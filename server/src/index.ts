import Fastify from "fastify";
import cors from "@fastify/cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { createMcpManager, type McpManager, type ToolPolicy } from "./mcp.js";
import { recordFeedback, createFeedbackTool } from "./feedback.js";

type TranscriptItem = {
  speaker: "user" | "assistant";
  text: string;
};

type EphemeralSessionRequestBody = {
  model?: string;
  voice?: string;
  instructions?: string;
  speed?: number;
};

type SupervisorNextRequestBody = {
  sessionId?: string | null;
  transcript: TranscriptItem[];
  relevantContextFromLastUserMessage?: string | null;
};

type SupervisorNextResponse = {
  message: string;
};

type PendingToolCall = {
  toolName: string;
  args: Record<string, unknown>;
  policy: ToolPolicy;
  createdAt: number;
};

type EphemeralSessionResponse = {
  sessionId: string;
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  voice: string | null;
};

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAiChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const clampSpeed = (value: number): number => {
  return Math.min(1.5, Math.max(0.25, value));
};

const supervisorSystemPrompt =
  "You are a senior supervisor for a junior realtime voice agent. " +
  "Given the conversation transcript so far, produce the next assistant message. " +
  "Be concise and voice-friendly. Ask one clarifying question only if necessary. " +
  "Try to infer the user's intent and respond accordingly. " +
  "You have access to a record_user_feedback tool that you can use when: " +
  "1. The user explicitly provides feedback about their experience " +
  "2. You detect user frustration, confusion, or satisfaction from their tone or responses " +
  "3. Something goes particularly well or poorly in the conversation " +
  "Use the feedback tool to capture these insights for product improvement.";

const formatTranscriptForSupervisor = (items: TranscriptItem[]): string => {
  return items
    .map((item) => {
      const text = item.text.trim();
      if (!text) {
        return null;
      }
      return `${item.speaker}: ${text}`;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");
};

const getLastUserUtterance = (items: TranscriptItem[]): string => {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.speaker === "user") {
      return item.text.trim();
    }
  }
  return "";
};

const looksLikeYes = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return /\b(yes|yeah|yep|sure|ok|okay|please do|do it|confirm|proceed|go ahead)\b/.test(
    normalized
  );
};

const looksLikeNo = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return /\b(no|nope|nah|stop|cancel|don't|do not)\b/.test(normalized);
};

const truncate = (value: string, max: number): string => {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
};

const summarizeToolCall = (toolName: string, args: Record<string, unknown>): string => {
  const argsText = truncate(JSON.stringify(args), 220);
  return `${toolName}(${argsText})`;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

let mcpManager: McpManager | null = null;
const pendingToolCallsBySession = new Map<string, PendingToolCall>();

const startMcpManagerInBackground = async (app: Awaited<ReturnType<typeof buildServer>>) => {
  if (mcpManager) {
    return;
  }

  try {
    const manager = await createMcpManager(repoRoot);
    mcpManager = manager;

    const startupErrors = manager.getStartupErrors();
    if (startupErrors.length > 0) {
      for (const err of startupErrors) {
        app.log.warn(
          {
            serverName: err.serverName,
            message: err.message
          },
          "MCP server failed to start"
        );
      }
    }

    if (manager.hasTools()) {
      app.log.info("MCP tools loaded");
    } else {
      app.log.warn("MCP manager started, but no tools were discovered (missing mcp.config.yaml?)");
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    app.log.warn(`Failed to start MCP manager: ${message}`);
    mcpManager = null;
  }
};

const buildServer = async () => {
  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: [`http://localhost:${env.clientPort}`, `http://127.0.0.1:${env.clientPort}`],
    credentials: true
  });

  app.get("/api/health", () => {
    return {
      ok: true,
      serverTime: new Date().toISOString(),
      hasOpenAIKey: env.openaiApiKey.length > 0,
      hasMcp: Boolean(mcpManager)
    };
  });

  app.post<{ Body: EphemeralSessionRequestBody }>("/api/realtime/ephemeral", async (req, reply) => {
    if (!env.openaiApiKey) {
      return reply.status(500).send({
        error: "OPENAI_API_KEY is not set"
      });
    }

    const model = req.body.model ?? "gpt-4o-mini-realtime-preview-latest";
    const voice = req.body.voice ?? null;
    const instructions = req.body.instructions ?? null;
    const speed = typeof req.body.speed === "number" ? clampSpeed(req.body.speed) : null;

    const openAiResponse = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        ...(voice ? { voice } : {}),
        ...(typeof speed === "number" ? { speed } : {}),
        ...(instructions ? { instructions } : {}),
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: 1500, // Wait 1.5 seconds before considering user done
          prefix_padding_ms: 300, // Include 300ms of silence before speech
          threshold: 0.6, // Slightly higher threshold to avoid false positives
          create_response: true,
          interrupt_response: true
        }
      })
    });

    if (!openAiResponse.ok) {
      const text = await openAiResponse.text();
      req.log.warn(
        {
          status: openAiResponse.status,
          body: text.slice(0, 2000)
        },
        "OpenAI realtime session creation failed"
      );
      return reply.status(502).send({
        error: "OpenAI realtime session creation failed",
        status: openAiResponse.status
      });
    }

    const data: unknown = await openAiResponse.json();
    if (!isRecord(data)) {
      return reply.status(502).send({
        error: "OpenAI response was not an object"
      });
    }

    const sessionId = typeof data.id === "string" ? data.id : null;
    const clientSecretObj = isRecord(data.client_secret) ? data.client_secret : null;
    const clientSecret =
      clientSecretObj && typeof clientSecretObj.value === "string" ? clientSecretObj.value : null;
    const expiresAt =
      clientSecretObj && typeof clientSecretObj.expires_at === "number"
        ? clientSecretObj.expires_at
        : null;

    if (!sessionId || !clientSecret) {
      return reply.status(502).send({
        error: "OpenAI response missing client secret"
      });
    }

    const response: EphemeralSessionResponse = {
      sessionId,
      clientSecret,
      expiresAt,
      model,
      voice
    };

    return reply.send(response);
  });

  app.post<{ Body: SupervisorNextRequestBody }>("/api/supervisor/next", async (req, reply) => {
    if (!env.openaiApiKey) {
      return reply.status(500).send({
        error: "OPENAI_API_KEY is not set"
      });
    }

    const sessionId = typeof req.body.sessionId === "string" ? req.body.sessionId : null;
    const transcript = Array.isArray(req.body.transcript) ? req.body.transcript : [];
    const transcriptText = formatTranscriptForSupervisor(transcript);
    const relevantContext =
      typeof req.body.relevantContextFromLastUserMessage === "string"
        ? req.body.relevantContextFromLastUserMessage
        : "";

    const lastUserUtterance = getLastUserUtterance(transcript);

    if (sessionId && pendingToolCallsBySession.has(sessionId)) {
      const pending = pendingToolCallsBySession.get(sessionId);
      if (pending) {
        if (looksLikeYes(lastUserUtterance)) {
          pendingToolCallsBySession.delete(sessionId);

          if (!mcpManager) {
            return reply.send({
              message:
                "Okay. I can't run tools right now because MCP is not configured on the server."
            } satisfies SupervisorNextResponse);
          }

          try {
            const toolResult = await mcpManager.callTool(pending.toolName, pending.args);
            const toolSummary = truncate(JSON.stringify(toolResult.result), 1200);

            const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.openaiApiKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                model: "gpt-5-mini",
                messages: [
                  {
                    role: "system",
                    content: supervisorSystemPrompt
                  },
                  {
                    role: "user",
                    content: [
                      "The user confirmed you may execute a tool.",
                      `Tool executed: ${summarizeToolCall(pending.toolName, pending.args)}`,
                      `Tool result: ${toolSummary}`,
                      "",
                      "Conversation transcript:",
                      transcriptText || "(empty)",
                      "",
                      relevantContext
                        ? `Relevant context from last user message: ${relevantContext}`
                        : "",
                      "",
                      "Return ONLY the next assistant message (no headers)."
                    ]
                      .filter((part) => part.length > 0)
                      .join("\n")
                  }
                ]
              })
            });

            if (!openAiResponse.ok) {
              const text = await openAiResponse.text();
              req.log.warn(
                {
                  status: openAiResponse.status,
                  body: text.slice(0, 2000)
                },
                "OpenAI supervisor response failed"
              );
              return reply.status(502).send({
                error: "OpenAI supervisor response failed",
                status: openAiResponse.status
              });
            }

            const data: unknown = await openAiResponse.json();
            if (!isRecord(data)) {
              return reply.status(502).send({
                error: "OpenAI response was not an object"
              });
            }

            const choices = Array.isArray(data.choices) ? data.choices : [];
            const firstChoice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : null;
            const messageObj =
              firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null;
            const content =
              messageObj && typeof messageObj.content === "string" ? messageObj.content : null;

            if (!content) {
              return reply.status(502).send({
                error: "OpenAI response missing content"
              });
            }

            return reply.send({
              message: content.trim()
            } satisfies SupervisorNextResponse);
          } catch (e) {
            const message = e instanceof Error ? e.message : "Unknown error";
            req.log.warn({ message }, "Pending tool execution failed");
            return reply.send({
              message: "Sorry — I couldn't run that tool."
            } satisfies SupervisorNextResponse);
          }
        }

        if (looksLikeNo(lastUserUtterance)) {
          pendingToolCallsBySession.delete(sessionId);
          return reply.send({
            message: "Okay, I won't run that. What would you like to do instead?"
          } satisfies SupervisorNextResponse);
        }

        return reply.send({
          message: `I can run ${summarizeToolCall(pending.toolName, pending.args)}. Should I proceed?`
        } satisfies SupervisorNextResponse);
      }
    }

    const userPromptParts = [
      "Conversation transcript:",
      transcriptText || "(empty)",
      "",
      relevantContext ? `Relevant context from last user message: ${relevantContext}` : null,
      "",
      "Return ONLY the next assistant message (no headers)."
    ].filter((part): part is string => typeof part === "string" && part.length > 0);

    const tools = mcpManager
      ? [...mcpManager.getOpenAiTools(), createFeedbackTool]
      : [createFeedbackTool];
    const maxIterations = 3;

    const baseMessages: OpenAiChatMessage[] = [
      {
        role: "system",
        content: supervisorSystemPrompt
      },
      {
        role: "user",
        content: userPromptParts.join("\n")
      }
    ];

    const messages = [...baseMessages];

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openaiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5-mini",
          messages,
          ...(tools.length > 0
            ? {
                tools,
                tool_choice: "auto"
              }
            : {})
        })
      });

      if (!openAiResponse.ok) {
        const text = await openAiResponse.text();
        req.log.warn(
          {
            status: openAiResponse.status,
            body: text.slice(0, 2000)
          },
          "OpenAI supervisor response failed"
        );
        return reply.status(502).send({
          error: "OpenAI supervisor response failed",
          status: openAiResponse.status
        });
      }

      const data: unknown = await openAiResponse.json();
      if (!isRecord(data)) {
        return reply.status(502).send({
          error: "OpenAI response was not an object"
        });
      }

      const choices = Array.isArray(data.choices) ? data.choices : [];
      const firstChoice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : null;
      const messageObj = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null;
      if (!messageObj) {
        return reply.status(502).send({
          error: "OpenAI response missing message"
        });
      }

      const toolCallsRaw = Array.isArray(messageObj.tool_calls) ? messageObj.tool_calls : [];
      const toolCalls = toolCallsRaw.filter(isRecord);

      const assistantContent =
        typeof messageObj.content === "string" && messageObj.content.trim()
          ? messageObj.content.trim()
          : null;

      if (toolCalls.length === 0) {
        if (!assistantContent) {
          return reply.status(502).send({
            error: "OpenAI response missing content"
          });
        }
        return reply.send({
          message: assistantContent
        } satisfies SupervisorNextResponse);
      }

      if (!mcpManager) {
        return reply.send({
          message: "I need MCP tools for that, but MCP is not configured on the server."
        } satisfies SupervisorNextResponse);
      }

      const firstToolCall = toolCalls[0];
      if (!firstToolCall) {
        return reply.status(502).send({
          error: "OpenAI tool call missing"
        });
      }

      const toolCallId = typeof firstToolCall.id === "string" ? firstToolCall.id : null;
      const functionObj = isRecord(firstToolCall.function) ? firstToolCall.function : null;
      const toolName =
        functionObj && typeof functionObj.name === "string" ? functionObj.name : null;
      const argsRaw =
        functionObj && typeof functionObj.arguments === "string" ? functionObj.arguments : "{}";

      if (!toolCallId || !toolName) {
        return reply.status(502).send({
          error: "OpenAI tool call missing name/id"
        });
      }

      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(argsRaw) as unknown;
        if (isRecord(parsed)) {
          args = parsed;
        }
      } catch {
        // ignore
      }

      if (toolName === "record_user_feedback") {
        // Handle internal feedback tool
        try {
          const feedbackReport: {
            type: "explicit" | "inferred";
            sentiment?: "positive" | "negative" | "neutral";
            reason?: string;
            assistantObservation?: string;
          } = {
            type: args.feedbackType as "explicit" | "inferred"
          };

          if (typeof args.sentiment === "string") {
            feedbackReport.sentiment = args.sentiment as "positive" | "negative" | "neutral";
          }
          if (typeof args.reason === "string") {
            feedbackReport.reason = args.reason;
          }
          if (typeof args.assistantObservation === "string") {
            feedbackReport.assistantObservation = args.assistantObservation;
          }

          await recordFeedback(
            (args.conversationHistory as Array<{ speaker: "user" | "assistant"; text: string }>) ||
              transcript,
            feedbackReport
          );

          messages.push({
            role: "assistant",
            content: assistantContent ?? "",
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: {
                  name: toolName,
                  arguments: argsRaw
                }
              }
            ]
          });
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: "Feedback recorded successfully"
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown error";
          req.log.warn({ message }, "Feedback recording failed");

          messages.push({
            role: "assistant",
            content: assistantContent ?? "",
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: {
                  name: toolName,
                  arguments: argsRaw
                }
              }
            ]
          });
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: `Failed to record feedback: ${message}`
          });
        }
        continue;
      }

      const policy = mcpManager.getToolPolicy(toolName);
      if (!policy) {
        return reply.send({
          message: `I don't recognize tool ${toolName}.`
        } satisfies SupervisorNextResponse);
      }

      if (policy.requiresConfirmation) {
        if (!sessionId) {
          return reply.send({
            message:
              "I need an active session id to request confirmation for that action. Please reconnect."
          } satisfies SupervisorNextResponse);
        }

        pendingToolCallsBySession.set(sessionId, {
          toolName,
          args,
          policy,
          createdAt: Date.now()
        });

        return reply.send({
          message: `I can run ${summarizeToolCall(toolName, args)}. Should I proceed?`
        } satisfies SupervisorNextResponse);
      }

      const toolResult = await mcpManager.callTool(toolName, args);

      messages.push({
        role: "assistant",
        content: assistantContent ?? "",
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: toolName,
              arguments: argsRaw
            }
          }
        ]
      });
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify(toolResult.result)
      });
    }

    return reply.send({
      message: "I couldn't complete that request with tools."
    } satisfies SupervisorNextResponse);
  });

  return app;
};

const main = async () => {
  const app = await buildServer();

  try {
    await app.listen({
      host: "0.0.0.0",
      port: env.serverPort
    });

    void startMcpManagerInBackground(app);
  } catch (err) {
    app.log.error(err);
    process.exitCode = 1;
  }
};

void main();
