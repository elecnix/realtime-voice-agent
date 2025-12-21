import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./env.js";

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
  transcript: TranscriptItem[];
  relevantContextFromLastUserMessage?: string | null;
};

type SupervisorNextResponse = {
  message: string;
};

type EphemeralSessionResponse = {
  sessionId: string;
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  voice: string | null;
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
  "Be concise and voice-friendly. Ask one clarifying question if needed.";

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
      hasOpenAIKey: env.openaiApiKey.length > 0
    };
  });

  app.post<{ Body: EphemeralSessionRequestBody }>("/api/realtime/ephemeral", async (req, reply) => {
    if (!env.openaiApiKey) {
      return reply.status(500).send({
        error: "OPENAI_API_KEY is not set"
      });
    }

    const model = req.body.model ?? "gpt-realtime-mini-2025-10-06";
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
        ...(instructions ? { instructions } : {})
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

    const transcript = Array.isArray(req.body.transcript) ? req.body.transcript : [];
    const transcriptText = formatTranscriptForSupervisor(transcript);
    const relevantContext =
      typeof req.body.relevantContextFromLastUserMessage === "string"
        ? req.body.relevantContextFromLastUserMessage
        : "";

    const userPromptParts = [
      "Conversation transcript:",
      transcriptText || "(empty)",
      "",
      relevantContext ? `Relevant context from last user message: ${relevantContext}` : null,
      "",
      "Return ONLY the next assistant message (no headers)."
    ].filter((part): part is string => typeof part === "string" && part.length > 0);

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
            content: userPromptParts.join("\n")
          }
        ],
        temperature: 1
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
    const content =
      messageObj && typeof messageObj.content === "string" ? messageObj.content : null;

    if (!content) {
      return reply.status(502).send({
        error: "OpenAI response missing content"
      });
    }

    const response: SupervisorNextResponse = {
      message: content.trim()
    };

    return reply.send(response);
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
  } catch (err) {
    app.log.error(err);
    process.exitCode = 1;
  }
};

void main();
