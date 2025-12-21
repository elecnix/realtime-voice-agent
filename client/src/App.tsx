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
- You may handle ONLY basic greetings and brief thanks without escalation.
- If the user says goodbye, you MUST call the tool pauseConversation.
- For everything else (including yes/no replies, confirmations, or any request that might require tools), you MUST call the tool getNextResponseFromSupervisor to decide what to say.
- Before calling that tool, say a short filler phrase like: "One moment." or "Let me check.".
- After you receive tool output, respond with the tool-provided message.
`;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const clampSpeed = (value: number): number => {
  return Math.min(1.5, Math.max(0.25, value));
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

const SESSION_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_WARNING_MS = 55_000;

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
                  "Pause the current voice conversation (disconnect) so the user can resume later.",
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
    addLog("Disconnect requested (timeout)");

    clearSessionTimeoutTimers();

    cleanupConnection();

    setConnectionState("disconnected");
    setConnectError(null);
    setLiveUserTranscript("");
    setLiveAssistantTranscript("");
    sessionIdRef.current = null;
  }, [addLog, cleanupConnection, clearSessionTimeoutTimers]);

  const pauseConversation = useCallback(
    (reason?: string) => {
      const suffix = reason ? `: ${reason}` : "";
      addLog(`Pause requested${suffix}`);

      clearSessionTimeoutTimers();
      cleanupConnection();

      setConnectionState("disconnected");
      setConnectError(null);
      setLiveUserTranscript("");
      setLiveAssistantTranscript("");
      sessionIdRef.current = null;
      setTimeoutStatus("paused");
    },
    [addLog, cleanupConnection, clearSessionTimeoutTimers]
  );

  const scheduleSessionTimeout = useCallback(() => {
    clearSessionTimeoutTimers();

    sessionTimeoutWarningTimerRef.current = window.setTimeout(() => {
      setTimeoutStatus("warning");
      addLog("Session will disconnect soon (timeout)");
    }, SESSION_TIMEOUT_WARNING_MS);

    sessionTimeoutTimerRef.current = window.setTimeout(() => {
      setTimeoutStatus("expired");
      disconnectForTimeout();
    }, SESSION_TIMEOUT_MS);
  }, [addLog, clearSessionTimeoutTimers, disconnectForTimeout]);

  const disconnect = useCallback(() => {
    addLog("Disconnect requested");

    clearSessionTimeoutTimers();
    setTimeoutStatus("none");

    cleanupConnection();

    setConnectionState("disconnected");
    setTimeoutStatus("paused");
    setConnectError(null);
    setLiveUserTranscript("");
    setLiveAssistantTranscript("");
    sessionIdRef.current = null;
  }, [addLog, cleanupConnection, clearSessionTimeoutTimers]);

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

      if (type === "conversation.item.input_audio_transcription.delta") {
        const delta = typeof record.delta === "string" ? record.delta : "";
        if (delta) {
          setLiveUserTranscript((prev) => `${prev}${delta}`);
        }
        return;
      }

      if (type === "conversation.item.input_audio_transcription.completed") {
        const transcript =
          typeof record.transcript === "string" ? record.transcript : liveUserTranscript;
        setLiveUserTranscript("");
        pushTranscript("user", transcript);

        if (looksLikeGoodbye(transcript)) {
          pauseConversation("user_goodbye");
        }
        return;
      }

      if (type === "response.audio_transcript.delta") {
        const delta = typeof record.delta === "string" ? record.delta : "";
        if (delta) {
          setLiveAssistantTranscript((prev) => `${prev}${delta}`);
          pendingAssistantTranscriptRef.current = `${pendingAssistantTranscriptRef.current}${delta}`;
        }
        return;
      }

      if (type === "response.audio_transcript.done") {
        const transcript = typeof record.transcript === "string" ? record.transcript : "";
        if (transcript) {
          pendingAssistantTranscriptRef.current = transcript;
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
        addLog("Realtime error event received");
      }

      if (type === "response.done") {
        const responseObj = isRecord(record.response) ? record.response : null;
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

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true
      });
      micStreamRef.current = micStream;
      pc.addTrack(micStream.getTracks()[0]!, micStream);

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
    if (connectionState === "connected" || connectionState === "connecting") {
      disconnect();
      return;
    }

    setTimeoutStatus("none");
    void connect();
  }, [connect, connectionState, disconnect]);

  useEffect(() => {
    if (connectionState !== "connected") {
      clearSessionTimeoutTimers();
      return;
    }

    scheduleSessionTimeout();
    sendSessionUpdate({ voice, speed: clampSpeed(speechSpeed), model });
  }, [
    clampSpeed,
    clearSessionTimeoutTimers,
    connectionState,
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

  return (
    <div className="container">
      <div className="mainLayout">
        <div className="header">
          <h1>Realtime Voice Agent</h1>
        </div>

        <div className="hero">
          <button
            type="button"
            className={`micButton state-${connectionState}`}
            onClick={handleMicToggle}
            disabled={!health?.hasOpenAIKey}
            aria-label={
              connectionState === "connected" || connectionState === "connecting"
                ? "Stop listening"
                : "Start listening"
            }
            title={
              connectionState === "connected" || connectionState === "connecting" ? "Stop" : "Start"
            }
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
            ) : connectionState === "connected" ? (
              <span>Listening… (click to stop)</span>
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
            </label>
          </div>

          <audio ref={audioRef} autoPlay className="audio" />
        </div>

        <div className="card">
          <h2>Transcript</h2>
          <div className="transcripts">
            <div className="transcriptLine">
              <strong>You (live):</strong>{" "}
              {normalizeTranscriptText(liveUserTranscript) || "(listening...)"}
            </div>
            <div className="transcriptLine">
              <strong>Assistant (live):</strong>{" "}
              <span className="liveMarkdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {normalizeTranscriptText(liveAssistantTranscript) || "(speaking...)"}
                </ReactMarkdown>
              </span>
            </div>
          </div>

          <div className="history">
            {transcriptHistory.length === 0 ? <p>(no transcript yet)</p> : null}
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
