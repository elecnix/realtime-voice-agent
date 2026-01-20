import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type HealthResponse = {
  ok: boolean;
  serverTime: string;
  hasOpenAIKey: boolean;
  hasMcp?: boolean;
};

type RealtimeEphemeralResponse = {
  sessionId: string;
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  voice: string | null;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

type TranscriptItem = {
  id: string;
  speaker: "user" | "assistant";
  text: string;
};

type SupervisorNextResponse = {
  message: string;
};

type LogItem = {
  id: number;
  at: string;
  message: string;
};

const chatAgentInstructions = `You are a realtime voice agent.

- Keep responses short and voice-friendly.
- You may handle basic greetings and brief thanks without escalation.
- Pausing is just a cost-saving measure to avoid listening to long silence. The conversation can be resumed multiple times - when the user speaks again, continue the conversation normally.
- Only consider the most recent messages when deciding whether to pause. If there's been a long silence or the user seems done, you may call pauseConversation to save costs.
- If the user speaks again after you pause, simply continue the conversation as normal - don't acknowledge the pause unless they mention it.
- Your supervisor cannot talk to the user directly, but can help you with anything; that gives you infinite capabilities. Always respond positively when the user requests something you don't know yet.
- Don't mention the existence of the supervisor to the user.
- Call the supervisor when the user requests information from a knowledge base, productivity tools, or access external services.
- Before calling the supervisor, say a short filler phrase like: "One moment." or "Let me check.". Getting a response from the supervisor can take a few minutes, so keep the conversation going.
- After you receive tool output, respond in your own voice, not as the supervisor.
`;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const clampSpeed = (value: number): number => {
  return Math.min(1.5, Math.max(0.25, value));
};

type LegacyGetUserMedia = (
  constraints: MediaStreamConstraints,
  successCallback: (stream: MediaStream) => void,
  errorCallback: (error: unknown) => void
) => void;

const getMicrophoneStream = async (): Promise<MediaStream> => {
  if (navigator.mediaDevices?.getUserMedia) {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  const legacyNavigator = navigator as Navigator & {
    getUserMedia?: LegacyGetUserMedia;
    webkitGetUserMedia?: LegacyGetUserMedia;
    mozGetUserMedia?: LegacyGetUserMedia;
    msGetUserMedia?: LegacyGetUserMedia;
  };

  const legacyGetUserMedia: LegacyGetUserMedia | undefined =
    legacyNavigator.getUserMedia ??
    legacyNavigator.webkitGetUserMedia ??
    legacyNavigator.mozGetUserMedia ??
    legacyNavigator.msGetUserMedia;

  if (legacyGetUserMedia) {
    return await new Promise<MediaStream>((resolve, reject) => {
      legacyGetUserMedia.call(
        navigator,
        { audio: true },
        (stream) => resolve(stream),
        (err) => reject(err instanceof Error ? err : new Error(String(err)))
      );
    });
  }

  throw new Error(
    "Microphone capture is not available in this browser or context. Try opening the app over HTTPS."
  );
};

const normalizeTranscriptText = (text: string): string => {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
};

const looksLikeGoodbye = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return /\b(bye|goodbye|good bye|see you|see ya|talk to you later|later|take care)\b/.test(
    normalized
  );
};

const SESSION_TIMEOUT_MS = 180_000;
const SESSION_TIMEOUT_WARNING_MS = 170_000;

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [connectError, setConnectError] = useState<string | null>(null);

  const voice = "alloy";
  const [speechSpeed, setSpeechSpeed] = useState<number>(1.15);
  const [model, setModel] = useState<string>("gpt-realtime");
  const [liveUserTranscript, setLiveUserTranscript] = useState<string>("");
  const [liveAssistantTranscript, setLiveAssistantTranscript] = useState<string>("");
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptItem[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [totalCostUsd, setTotalCostUsd] = useState<number>(0);

  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isWaitingForSupervisor, setIsWaitingForSupervisor] = useState<boolean>(false);

  const [isUserSpeaking, setIsUserSpeaking] = useState<boolean>(false);

  const [timeoutStatus, setTimeoutStatus] = useState<"none" | "warning" | "expired" | "paused">(
    "none"
  );

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const logIdRef = useRef<number>(1);

  const sessionTimeoutTimerRef = useRef<number | null>(null);
  const sessionTimeoutWarningTimerRef = useRef<number | null>(null);

  const autoConnectAttemptedRef = useRef<boolean>(false);

  const transcriptHistoryRef = useRef<TranscriptItem[]>([]);
  const sessionIdRef = useRef<string | null>(null);

  const webrtcUrl = useMemo(() => {
    return "https://api.openai.com/v1/realtime";
  }, []);

  const pendingAssistantTranscriptRef = useRef<string>("");
  const pendingAssistantCommitTimerRef = useRef<number | null>(null);

  const userSpeakingTimerRef = useRef<number | null>(null);

  const scheduleUserSpeakingOff = useCallback(() => {
    if (userSpeakingTimerRef.current) {
      window.clearTimeout(userSpeakingTimerRef.current);
    }
    userSpeakingTimerRef.current = window.setTimeout(() => {
      setIsUserSpeaking(false);
      userSpeakingTimerRef.current = null;
    }, 100);
  }, []);

  const addLog = useCallback((message: string) => {
    setLogs((prev) => {
      const next: LogItem = {
        id: logIdRef.current++,
        at: new Date().toISOString(),
        message
      };
      const merged = [...prev, next];
      return merged.length > 200 ? merged.slice(merged.length - 200) : merged;
    });
  }, []);

  const playMutedBeep = useCallback(() => {
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextCtor();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = 660;

      gain.gain.value = 0;

      oscillator.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.08, now + 0.01);
      gain.gain.linearRampToValueAtTime(0.0, now + 0.11);

      oscillator.start(now);
      oscillator.stop(now + 0.12);

      oscillator.onended = () => {
        void ctx.close();
      };
    } catch {
      // ignore
    }
  }, []);

  const applyMicMute = useCallback((muted: boolean) => {
    const micStream = micStreamRef.current;
    const track = micStream?.getAudioTracks()?.[0] ?? null;
    if (!track) {
      return;
    }
    track.enabled = !muted;
  }, []);

  const isDev = import.meta.env.DEV;

  const extractCostFromUsage = useCallback(
    (usage: unknown): {
      costUsd: number;
      inputTextTokens: number;
      inputAudioTokens: number;
      outputTextTokens: number;
      outputAudioTokens: number;
    } => {
      if (!isRecord(usage)) {
        return {
          costUsd: 0,
          inputTextTokens: 0,
          inputAudioTokens: 0,
          outputTextTokens: 0,
          outputAudioTokens: 0
        };
      }

      const inputTokenDetails = isRecord(usage.input_token_details)
        ? usage.input_token_details
        : null;
      const outputTokenDetails = isRecord(usage.output_token_details)
        ? usage.output_token_details
        : null;

      const inputTextTokens =
        inputTokenDetails && typeof inputTokenDetails.text_tokens === "number"
          ? inputTokenDetails.text_tokens
          : 0;
      const inputAudioTokens =
        inputTokenDetails && typeof inputTokenDetails.audio_tokens === "number"
          ? inputTokenDetails.audio_tokens
          : 0;

      const outputTextTokens =
        outputTokenDetails && typeof outputTokenDetails.text_tokens === "number"
          ? outputTokenDetails.text_tokens
          : 0;
      const outputAudioTokens =
        outputTokenDetails && typeof outputTokenDetails.audio_tokens === "number"
          ? outputTokenDetails.audio_tokens
          : 0;

      const hasInputDetails = inputTextTokens > 0 || inputAudioTokens > 0;
      const hasOutputDetails = outputTextTokens > 0 || outputAudioTokens > 0;

      const normalizedInputTextTokens = hasInputDetails
        ? inputTextTokens
        : typeof usage.input_tokens === "number"
          ? usage.input_tokens
          : 0;
      const normalizedInputAudioTokens = hasInputDetails ? inputAudioTokens : 0;

      const normalizedOutputTextTokens = hasOutputDetails
        ? outputTextTokens
        : typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : 0;
      const normalizedOutputAudioTokens = hasOutputDetails ? outputAudioTokens : 0;

      const inputTextUsdPer1M = 5;
      const outputTextUsdPer1M = 20;
      const inputAudioUsdPer1M = 100;
      const outputAudioUsdPer1M = 200;

      const costUsd =
        (normalizedInputTextTokens * inputTextUsdPer1M +
          normalizedOutputTextTokens * outputTextUsdPer1M +
          normalizedInputAudioTokens * inputAudioUsdPer1M +
          normalizedOutputAudioTokens * outputAudioUsdPer1M) /
        1_000_000;

      return {
        costUsd,
        inputTextTokens: normalizedInputTextTokens,
        inputAudioTokens: normalizedInputAudioTokens,
        outputTextTokens: normalizedOutputTextTokens,
        outputAudioTokens: normalizedOutputAudioTokens
      };
    },
    []
  );

  const sendSessionUpdate = useCallback(
    (updates: { voice?: string; speed?: number; model?: string }) => {
      const dc = dataChannelRef.current;
      if (!dc || dc.readyState !== "open") {
        return;
      }

      if (updates.model) {
        addLog(`Session updated: model=${updates.model}`);
      }

      dc.send(
        JSON.stringify({
          type: "session.update",
          session: {
            instructions: chatAgentInstructions,
            ...(updates.voice ? { voice: updates.voice } : {}),
            ...(updates.speed ? { speed: updates.speed } : {}),
            ...(updates.model ? { model: updates.model } : {}),
            tools: [
              {
                type: "function",
                name: "getNextResponseFromSupervisor",
                description:
                  "Get the next voice-friendly response from a supervisor model, using transcript context.",
                parameters: {
                  type: "object",
                  properties: {
                    relevantContextFromLastUserMessage: {
                      type: "string",
                      description:
                        "Key context from the last user message, if available; may be empty string."
                    }
                  },
                  required: ["relevantContextFromLastUserMessage"],
                  additionalProperties: false
                }
              },
              {
                type: "function",
                name: "pauseConversation",
                description:
                  "Mute the microphone to save costs during long silence or when conversation seems complete. This is just a cost-saving measure - the user can resume by speaking again. Use this when there's been a long pause, silence, or the conversation appears to have reached a natural end. Don't use if the user is actively engaged or asking questions.",
                parameters: {
                  type: "object",
                  properties: {
                    reason: {
                      type: "string",
                      description: "Optional reason for pausing."
                    }
                  },
                  required: [],
                  additionalProperties: false
                }
              }
            ],
            tool_choice: "auto",
            input_audio_transcription: {
              model: "gpt-4o-mini-transcribe"
            }
          }
        })
      );
    },
    [addLog]
  );

  const clearSessionTimeoutTimers = useCallback(() => {
    if (sessionTimeoutWarningTimerRef.current !== null) {
      window.clearTimeout(sessionTimeoutWarningTimerRef.current);
      sessionTimeoutWarningTimerRef.current = null;
    }
    if (sessionTimeoutTimerRef.current !== null) {
      window.clearTimeout(sessionTimeoutTimerRef.current);
      sessionTimeoutTimerRef.current = null;
    }
  }, []);

  const cleanupConnection = useCallback(() => {
    if (pendingAssistantCommitTimerRef.current) {
      window.clearTimeout(pendingAssistantCommitTimerRef.current);
      pendingAssistantCommitTimerRef.current = null;
    }
    pendingAssistantTranscriptRef.current = "";

    if (userSpeakingTimerRef.current) {
      window.clearTimeout(userSpeakingTimerRef.current);
      userSpeakingTimerRef.current = null;
    }
    setIsUserSpeaking(false);

    setIsMuted(false);
    setIsWaitingForSupervisor(false);

    const dc = dataChannelRef.current;
    if (dc) {
      try {
        dc.close();
      } catch {
        // ignore
      }
    }
    dataChannelRef.current = null;

    const pc = peerConnectionRef.current;
    if (pc) {
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    peerConnectionRef.current = null;

    const micStream = micStreamRef.current;
    if (micStream) {
      for (const t of micStream.getTracks()) {
        t.stop();
      }
    }
    micStreamRef.current = null;
  }, []);

  const disconnectForTimeout = useCallback(() => {
    addLog("Auto-mute triggered (timeout)");
    clearSessionTimeoutTimers();

    setIsMuted(true);
    applyMicMute(true);
  }, [addLog, applyMicMute, clearSessionTimeoutTimers]);

  const pauseConversation = useCallback(
    (reason?: string) => {
      const suffix = reason ? `: ${reason}` : "";
      addLog(`Pause requested${suffix}`);

      if (pendingAssistantCommitTimerRef.current) {
        window.clearTimeout(pendingAssistantCommitTimerRef.current);
        pendingAssistantCommitTimerRef.current = null;
      }

      const pendingText = pendingAssistantTranscriptRef.current.trim();
      if (pendingText) {
        const trimmed = normalizeTranscriptText(pendingText).trim();
        if (trimmed) {
          setTranscriptHistory((prev) => {
            const next: TranscriptItem = {
              id: `assistant-${Date.now()}`,
              speaker: "assistant",
              text: trimmed
            };
            const merged = [next, ...prev];
            return merged.length > 50 ? merged.slice(0, 50) : merged;
          });
          addLog("Committed pending assistant transcript before pause");
        }
      }

      clearSessionTimeoutTimers();

      setIsMuted(true);
      applyMicMute(true);
      setTimeoutStatus("paused");
    },
    [addLog, applyMicMute, clearSessionTimeoutTimers]
  );

  const scheduleSessionTimeout = useCallback(() => {
    clearSessionTimeoutTimers();

    sessionTimeoutWarningTimerRef.current = window.setTimeout(() => {
      setTimeoutStatus("warning");
      addLog("Session will disconnect soon (timeout)");
    }, SESSION_TIMEOUT_WARNING_MS);

    sessionTimeoutTimerRef.current = window.setTimeout(() => {
      setTimeoutStatus("none");
      disconnectForTimeout();
    }, SESSION_TIMEOUT_MS);
  }, [addLog, clearSessionTimeoutTimers, disconnectForTimeout]);

  useEffect(() => {
    return () => {
      clearSessionTimeoutTimers();
      cleanupConnection();
    };
  }, [cleanupConnection, clearSessionTimeoutTimers]);

  const pushTranscript = useCallback((speaker: "user" | "assistant", text: string) => {
    const trimmed = normalizeTranscriptText(text).trim();
    if (!trimmed) {
      return;
    }

    setTranscriptHistory((prev) => {
      const next: TranscriptItem = {
        id: `${speaker}-${Date.now()}`,
        speaker,
        text: trimmed
      };
      const merged = [next, ...prev];
      return merged.length > 50 ? merged.slice(0, 50) : merged;
    });
  }, []);

  useEffect(() => {
    transcriptHistoryRef.current = transcriptHistory;
  }, [transcriptHistory]);

  const sendConversationItemCreate = useCallback((payload: unknown) => {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== "open") {
      return;
    }
    dc.send(JSON.stringify(payload));
  }, []);

  const sendResponseCreate = useCallback(() => {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== "open") {
      return;
    }
    dc.send(
      JSON.stringify({
        type: "response.create"
      })
    );
  }, [addLog]);

  const runSupervisorTool = useCallback(
    async (callId: string, relevantContextFromLastUserMessage: string) => {
      setIsWaitingForSupervisor(true);
      addLog("Supervisor tool invoked");

      const sessionId = sessionIdRef.current;

      try {
        const transcriptForServer = transcriptHistoryRef.current
          .slice()
          .reverse()
          .map((item) => ({
            speaker: item.speaker,
            text: item.text
          }));

        const res = await fetch("/api/supervisor/next", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            sessionId,
            transcript: transcriptForServer,
            relevantContextFromLastUserMessage
          })
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Supervisor endpoint returned ${res.status}: ${text.slice(0, 400)}`);
        }

        const data = (await res.json()) as SupervisorNextResponse;
        if (!data.message) {
          throw new Error("Supervisor response missing message");
        }

        sendConversationItemCreate({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({ message: data.message })
          }
        });

        addLog("Supervisor tool output sent to session");
        sendResponseCreate();
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        addLog(`Supervisor tool failed: ${message}`);

        sendConversationItemCreate({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({
              message: "Sorry — I hit an internal error while checking that. Could you try again?"
            })
          }
        });

        sendResponseCreate();
      } finally {
        setIsWaitingForSupervisor(false);
      }
    },
    [addLog, sendConversationItemCreate, sendResponseCreate]
  );

  const handleRealtimeEvent = useCallback(
    (evt: unknown) => {
      if (typeof evt !== "object" || evt === null) {
        return;
      }

      const record = evt as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";

      if (type === "input_audio_buffer.speech_started") {
        if (userSpeakingTimerRef.current) {
          window.clearTimeout(userSpeakingTimerRef.current);
          userSpeakingTimerRef.current = null;
        }
        setIsUserSpeaking(true);
        return;
      }

      if (type === "conversation.item.input_audio_transcription.delta") {
        const delta = typeof record.delta === "string" ? record.delta : "";
        if (delta) {
          setLiveUserTranscript((prev) => `${prev}${delta}`);
        }
        setIsUserSpeaking(true);
        scheduleUserSpeakingOff();
        return;
      }

      if (type === "conversation.item.input_audio_transcription.completed") {
        const transcript =
          typeof record.transcript === "string" ? record.transcript : liveUserTranscript;
        setLiveUserTranscript("");
        scheduleUserSpeakingOff();
        pushTranscript("user", transcript);

        if (looksLikeGoodbye(transcript)) {
          pauseConversation("user_goodbye");
          return;
        }

        return;
      }

      if (type === "response.audio_transcript.delta") {
        const delta = typeof record.delta === "string" ? record.delta : "";
        if (delta) {
          pendingAssistantTranscriptRef.current = `${pendingAssistantTranscriptRef.current}${delta}`;
          setLiveAssistantTranscript(pendingAssistantTranscriptRef.current);
        }
        return;
      }

      if (type === "response.audio_transcript.done") {
        const transcript = typeof record.transcript === "string" ? record.transcript : "";
        if (transcript) {
          pendingAssistantTranscriptRef.current = transcript;
          setLiveAssistantTranscript(transcript);
        }

        if (pendingAssistantCommitTimerRef.current) {
          window.clearTimeout(pendingAssistantCommitTimerRef.current);
        }

        pendingAssistantCommitTimerRef.current = window.setTimeout(() => {
          const finalText = pendingAssistantTranscriptRef.current.trim();
          pendingAssistantTranscriptRef.current = "";
          pendingAssistantCommitTimerRef.current = null;
          setLiveAssistantTranscript("");
          pushTranscript("assistant", finalText);
          addLog("Committed assistant transcript via timeout fallback");
        }, 7_000);

        return;
      }

      if (type === "output_audio_buffer.started") {
        if (pendingAssistantCommitTimerRef.current) {
          window.clearTimeout(pendingAssistantCommitTimerRef.current);
          pendingAssistantCommitTimerRef.current = null;
        }
        pendingAssistantTranscriptRef.current = "";
        setLiveAssistantTranscript("");
        return;
      }

      if (type === "output_audio_buffer.cleared") {
        if (pendingAssistantCommitTimerRef.current) {
          window.clearTimeout(pendingAssistantCommitTimerRef.current);
          pendingAssistantCommitTimerRef.current = null;
        }
        const partialText = pendingAssistantTranscriptRef.current.trim();
        pendingAssistantTranscriptRef.current = "";
        setLiveAssistantTranscript("");
        if (partialText) {
          pushTranscript("assistant", partialText);
          addLog("Assistant audio cleared; committed partial transcript");
        } else {
          addLog("Assistant audio cleared; transcript reset");
        }
        return;
      }

      if (type === "output_audio_buffer.stopped") {
        if (pendingAssistantCommitTimerRef.current) {
          window.clearTimeout(pendingAssistantCommitTimerRef.current);
          pendingAssistantCommitTimerRef.current = null;
        }
        const finalText = pendingAssistantTranscriptRef.current.trim();
        pendingAssistantTranscriptRef.current = "";
        setLiveAssistantTranscript("");
        pushTranscript("assistant", finalText);
        return;
      }

      if (type === "error") {
        const errorObj = isRecord(record.error) ? record.error : null;
        const errorType = errorObj && typeof errorObj.type === "string" ? errorObj.type : "unknown";
        const errorCode = errorObj && typeof errorObj.code === "string" ? errorObj.code : "";
        const errorMessage =
          errorObj && typeof errorObj.message === "string" ? errorObj.message : "";
        const errorDetails = [errorType, errorCode, errorMessage].filter(Boolean).join(" - ");
        addLog(`Realtime error: ${errorDetails || JSON.stringify(record)}`);
      }

      if (type === "response.done") {
        const responseObj = isRecord(record.response) ? record.response : null;
        const usageRaw = responseObj ? responseObj.usage : null;
        const usage = extractCostFromUsage(usageRaw);
        if (usage.costUsd > 0) {
          setTotalCostUsd((prev) => prev + usage.costUsd);
          addLog(
            `Usage in ${usage.inputTextTokens}t/${usage.inputAudioTokens}a out ${usage.outputTextTokens}t/${usage.outputAudioTokens}a (+$${usage.costUsd.toFixed(6)})`
          );
        } else if (isDev) {
          addLog("Usage missing or zero on response.done");
        }

        if (isDev) {
          console.debug("Realtime response.done usage", usageRaw);
          console.debug("Realtime usage derived", usage);
        }
        const outputUnknown = responseObj ? responseObj.output : null;
        const outputArr = Array.isArray(outputUnknown) ? outputUnknown : [];

        for (const outputItem of outputArr) {
          if (!isRecord(outputItem)) {
            continue;
          }

          const outputType = typeof outputItem.type === "string" ? outputItem.type : null;
          if (outputType !== "function_call") {
            continue;
          }

          const name = typeof outputItem.name === "string" ? outputItem.name : null;
          const callId = typeof outputItem.call_id === "string" ? outputItem.call_id : null;
          const argsRaw = typeof outputItem.arguments === "string" ? outputItem.arguments : "{}";

          if (name === "pauseConversation" && callId) {
            let reason: string | undefined;
            try {
              const parsed = JSON.parse(argsRaw) as unknown;
              if (isRecord(parsed) && typeof parsed.reason === "string") {
                reason = parsed.reason;
              }
            } catch {
              // ignore
            }

            sendConversationItemCreate({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: callId,
                output: JSON.stringify({ ok: true })
              }
            });

            pauseConversation(reason);
            break;
          }

          if (name !== "getNextResponseFromSupervisor" || !callId) {
            continue;
          }

          let relevantContextFromLastUserMessage = "";
          try {
            const parsed = JSON.parse(argsRaw) as unknown;
            if (isRecord(parsed) && typeof parsed.relevantContextFromLastUserMessage === "string") {
              relevantContextFromLastUserMessage = parsed.relevantContextFromLastUserMessage;
            }
          } catch {
            // ignore
          }

          void runSupervisorTool(callId, relevantContextFromLastUserMessage);
          break;
        }
      }
    },
    [
      addLog,
      extractCostFromUsage,
      liveUserTranscript,
      pauseConversation,
      pushTranscript,
      runSupervisorTool,
      sendConversationItemCreate
    ]
  );

  const connect = useCallback(async () => {
    if (connectionState === "connecting" || connectionState === "connected") {
      return;
    }

    setTotalCostUsd(0);
    setConnectError(null);
    setConnectionState("connecting");
    addLog("Connecting...");

    try {
      const speed = clampSpeed(speechSpeed);

      const ephemeralRes = await fetch("/api/realtime/ephemeral", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          voice,
          speed,
          instructions: chatAgentInstructions,
          model
        })
      });

      if (!ephemeralRes.ok) {
        const text = await ephemeralRes.text();
        throw new Error(
          `Ephemeral endpoint returned ${ephemeralRes.status}: ${text.slice(0, 400)}`
        );
      }

      const session = (await ephemeralRes.json()) as RealtimeEphemeralResponse;
      sessionIdRef.current = session.sessionId;
      addLog(`Ephemeral session created (${session.sessionId})`);

      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;

      pc.onconnectionstatechange = () => {
        addLog(`Peer connection state: ${pc.connectionState}`);
      };

      pc.ontrack = (e) => {
        const audio = audioRef.current;
        if (!audio) {
          return;
        }

        const stream = e.streams[0];
        if (!stream) {
          return;
        }

        audio.srcObject = stream;
      };

      const micStream = await getMicrophoneStream();
      micStreamRef.current = micStream;
      pc.addTrack(micStream.getTracks()[0]!, micStream);

      setIsMuted(false);

      const dc = pc.createDataChannel("oai-events");
      dataChannelRef.current = dc;

      dc.onopen = () => {
        addLog("Data channel opened");
        sendSessionUpdate({ voice, speed });
      };

      dc.onmessage = (e) => {
        try {
          const parsed: unknown = JSON.parse(e.data as string);
          handleRealtimeEvent(parsed);
        } catch {
          // ignore
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const offerSdp = offer.sdp;
      if (!offerSdp) {
        throw new Error("Failed to create SDP offer");
      }

      const sdpResponse = await fetch(`${webrtcUrl}?model=${encodeURIComponent(session.model)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.clientSecret}`,
          "Content-Type": "application/sdp"
        },
        body: offerSdp
      });

      if (!sdpResponse.ok) {
        const text = await sdpResponse.text();
        throw new Error(
          `Realtime SDP exchange failed ${sdpResponse.status}: ${text.slice(0, 400)}`
        );
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp
      });

      setConnectionState("connected");
      setTimeoutStatus("none");
      addLog("Connected");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      cleanupConnection();

      setConnectError(message);
      setConnectionState("error");
      addLog(`Connection failed: ${message}`);
      setLiveUserTranscript("");
      setLiveAssistantTranscript("");
    }
  }, [
    addLog,
    cleanupConnection,
    clampSpeed,
    connectionState,
    handleRealtimeEvent,
    model,
    sendSessionUpdate,
    speechSpeed,
    voice,
    webrtcUrl
  ]);

  const handleMicToggle = useCallback(() => {
    if (connectionState === "connecting") {
      return;
    }

    if (connectionState === "connected") {
      const nextMuted = !isMuted;
      setIsMuted(nextMuted);
      applyMicMute(nextMuted);
      if (nextMuted) {
        playMutedBeep();
      }
      return;
    }

    setTimeoutStatus("none");
    void connect();
  }, [applyMicMute, connect, connectionState, isMuted, playMutedBeep]);

  useEffect(() => {
    if (connectionState !== "connected") {
      clearSessionTimeoutTimers();
      return;
    }

    if (isWaitingForSupervisor) {
      clearSessionTimeoutTimers();
      return;
    }

    scheduleSessionTimeout();
    sendSessionUpdate({ voice, speed: clampSpeed(speechSpeed), model });
  }, [
    clampSpeed,
    clearSessionTimeoutTimers,
    connectionState,
    isWaitingForSupervisor,
    model,
    scheduleSessionTimeout,
    sendSessionUpdate,
    speechSpeed,
    voice
  ]);

  useEffect(() => {
    if (!health?.hasOpenAIKey) {
      return;
    }
    if (autoConnectAttemptedRef.current) {
      return;
    }
    if (connectionState !== "disconnected") {
      return;
    }

    autoConnectAttemptedRef.current = true;
    void connect();
  }, [connectionState, connect, health?.hasOpenAIKey]);

  useEffect(() => {
    let cancelled = false;

    const startedAt = Date.now();
    const timeoutMs = 20_000;
    const retryDelayMs = 500;

    const run = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) {
          throw new Error(`Server returned ${res.status}`);
        }
        const data = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(data);
          setError(null);
        }
      } catch (e) {
        if (cancelled) {
          return;
        }

        const message = e instanceof Error ? e.message : "Unknown error";
        setError(message);

        if (Date.now() - startedAt < timeoutMs) {
          setTimeout(() => {
            if (!cancelled) {
              void run();
            }
          }, retryDelayMs);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.code === "Space" &&
        !(
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLSelectElement ||
          event.target instanceof HTMLTextAreaElement
        )
      ) {
        event.preventDefault();
        handleMicToggle();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleMicToggle]);

  return (
    <div className="container">
      <div className="mainLayout">
        <div className="header">
          <h1>Realtime Voice Agent</h1>
        </div>

        <div className="hero">
          <button
            type="button"
            className={`micButton state-${connectionState}${isMuted ? " isMuted" : ""}${isUserSpeaking && !isMuted && connectionState === "connected" ? " isSpeaking" : ""}`}
            onClick={handleMicToggle}
            disabled={!health?.hasOpenAIKey}
            aria-label={
              connectionState === "connected"
                ? isMuted
                  ? "Unmute microphone"
                  : "Mute microphone"
                : connectionState === "connecting"
                  ? "Starting"
                  : "Start listening"
            }
            title={connectionState === "connected" ? (isMuted ? "Unmute" : "Mute") : "Start"}
          >
            <svg
              className="micIcon"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M19 11a7 7 0 0 1-14 0"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12 18v3"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M8 21h8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>

            {connectionState === "connected" && isMuted ? (
              <svg
                className="micSlash"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path d="M6 6l12 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            ) : null}
          </button>

          <div className="micHint">
            {error ? (
              <span className="error">{error}</span>
            ) : !health ? (
              <span>Checking server…</span>
            ) : !health.hasOpenAIKey ? (
              <span className="error">Missing OpenAI key (server)</span>
            ) : connectError ? (
              <span className="error">{connectError}</span>
            ) : timeoutStatus === "expired" ? (
              <span>Paused (timeout). Click to resume.</span>
            ) : timeoutStatus === "paused" ? (
              <span>Paused. Click to resume.</span>
            ) : timeoutStatus === "warning" ? (
              <span>Still there? Click to keep listening.</span>
            ) : connectionState === "connected" && isMuted ? (
              <span className="micHintLine">
                <span>Muted (spacebar to unmute)…</span>
                {isWaitingForSupervisor ? (
                  <span className="waitingLine">
                    <span className="spinner" aria-hidden="true" />
                    <span>Waiting for response…</span>
                  </span>
                ) : null}
              </span>
            ) : connectionState === "connected" ? (
              <span className="micHintLine">
                <span>Listening (spacebar to mute)…</span>
                {isWaitingForSupervisor ? (
                  <span className="waitingLine">
                    <span className="spinner" aria-hidden="true" />
                    <span>Waiting for response…</span>
                  </span>
                ) : null}
              </span>
            ) : connectionState === "connecting" ? (
              <span>Starting…</span>
            ) : connectionState === "error" ? (
              <span>Click to retry.</span>
            ) : (
              <span className="micHintLine">
                {health.ok ? (
                  <span className="statusOk" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path
                        d="M20 6 9 17l-5-5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                ) : null}
                <span>Click to start listening.</span>
              </span>
            )}
          </div>

          <div className="costBadge" aria-label={`Total cost ${totalCostUsd.toFixed(6)} dollars`}>
            <span className="costLabel">Cost</span>
            <span className="costValue">${totalCostUsd.toFixed(6)}</span>
          </div>

          <div className="modelPicker">
            <label className="field">
              <span>Model</span>
              <select
                value={model}
                onChange={(e) => {
                  const next = e.target.value;
                  setModel(next);
                  if (connectionState === "connected") {
                    addLog(`Model changed: ${model} -> ${next}`);
                    sendSessionUpdate({ model: next });
                  }
                }}
                disabled={connectionState === "connecting"}
              >
                <option value="gpt-realtime">gpt-realtime</option>
                <option value="gpt-realtime-mini">gpt-realtime-mini</option>
                <option value="gpt-4o-realtime-preview">gpt-4o-realtime-preview</option>
                <option value="gpt-4o-mini-realtime-preview">gpt-4o-mini-realtime-preview</option>
              </select>
            </label>
          </div>

          <div className="speedPicker">
            <label className="field">
              <span>Speed</span>
              <div className="rangeContainer">
                <input
                  type="range"
                  min={0.25}
                  max={1.5}
                  step={0.05}
                  value={speechSpeed}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setSpeechSpeed(next);
                    if (connectionState === "connected") {
                      sendSessionUpdate({ speed: clampSpeed(next) });
                    }
                  }}
                  disabled={connectionState === "connecting"}
                  aria-label={`Speech speed ${clampSpeed(speechSpeed).toFixed(2)}x`}
                />
                <span className="speedValue">{clampSpeed(speechSpeed).toFixed(2)}x</span>
              </div>
            </label>
          </div>

          <audio ref={audioRef} autoPlay className="audio" />
        </div>

        <div className="card">
          <h2>Transcript</h2>
          <div className="history">
            {liveAssistantTranscript && (
              <div className="bubble assistant live">
                <div className="bubbleHeader">Assistant</div>
                <div className="bubbleText">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {normalizeTranscriptText(liveAssistantTranscript)}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            {transcriptHistory.length === 0 && !liveAssistantTranscript ? (
              <p>(no transcript yet)</p>
            ) : null}
            {transcriptHistory.map((item) => (
              <div key={item.id} className={`bubble ${item.speaker}`}>
                <div className="bubbleHeader">{item.speaker === "user" ? "You" : "Assistant"}</div>
                <div className="bubbleText">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2>Event log</h2>
          <div className="log">
            {logs.length === 0 ? <p>(no events yet)</p> : null}
            {logs
              .slice()
              .reverse()
              .map((item) => (
                <div key={item.id} className="logRow">
                  <span className="logAt">{item.at}</span>
                  <span className="logMsg">{item.message}</span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
