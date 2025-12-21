import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type HealthResponse = {
  ok: boolean;
  serverTime: string;
  hasOpenAIKey: boolean;
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
- For basic greetings and brief chitchat, respond normally.
- For everything else, you MUST call the tool getNextResponseFromSupervisor to decide what to say.
- Before calling that tool, say a short filler phrase like: "One moment." or "Let me check.".
- After you receive tool output, respond with the tool-provided message.
`;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const clampSpeed = (value: number): number => {
  return Math.min(1.5, Math.max(0.25, value));
};

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [ephemeral, setEphemeral] = useState<RealtimeEphemeralResponse | null>(null);

  const [voice, setVoice] = useState<string>("alloy");
  const [speechSpeed, setSpeechSpeed] = useState<number>(1.15);
  const [liveUserTranscript, setLiveUserTranscript] = useState<string>("");
  const [liveAssistantTranscript, setLiveAssistantTranscript] = useState<string>("");
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptItem[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const logIdRef = useRef<number>(1);

  const transcriptHistoryRef = useRef<TranscriptItem[]>([]);

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

  const sendSessionUpdate = useCallback((updates: { voice?: string; speed?: number }) => {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== "open") {
      return;
    }

    dc.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: chatAgentInstructions,
          ...(updates.voice ? { voice: updates.voice } : {}),
          ...(updates.speed ? { speed: updates.speed } : {}),
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
            }
          ],
          tool_choice: "auto",
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe"
          }
        }
      })
    );
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

  const disconnect = useCallback(() => {
    addLog("Disconnect requested");

    cleanupConnection();

    setConnectionState("disconnected");
    setConnectError(null);
    setEphemeral(null);
    setLiveUserTranscript("");
    setLiveAssistantTranscript("");
    setTranscriptHistory([]);
    transcriptHistoryRef.current = [];
  }, [addLog, cleanupConnection]);

  useEffect(() => {
    return () => {
      cleanupConnection();
    };
  }, [cleanupConnection]);

  const pushTranscript = useCallback((speaker: "user" | "assistant", text: string) => {
    const trimmed = text.trim();
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
  }, []);

  const runSupervisorTool = useCallback(
    async (callId: string, relevantContextFromLastUserMessage: string) => {
      addLog("Supervisor tool invoked");

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
        pendingAssistantTranscriptRef.current = "";
        setLiveAssistantTranscript("");
        addLog("Assistant audio cleared; transcript reset");
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
    [addLog, liveUserTranscript, pushTranscript, runSupervisorTool]
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
          instructions: chatAgentInstructions
        })
      });

      if (!ephemeralRes.ok) {
        const text = await ephemeralRes.text();
        throw new Error(
          `Ephemeral endpoint returned ${ephemeralRes.status}: ${text.slice(0, 400)}`
        );
      }

      const session = (await ephemeralRes.json()) as RealtimeEphemeralResponse;
      setEphemeral(session);
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
      addLog("Connected");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      cleanupConnection();

      setConnectError(message);
      setConnectionState("error");
      addLog(`Connection failed: ${message}`);
      setEphemeral(null);
      setLiveUserTranscript("");
      setLiveAssistantTranscript("");
    }
  }, [
    addLog,
    cleanupConnection,
    clampSpeed,
    connectionState,
    handleRealtimeEvent,
    sendSessionUpdate,
    speechSpeed,
    voice,
    webrtcUrl
  ]);

  useEffect(() => {
    if (connectionState !== "connected") {
      return;
    }
    sendSessionUpdate({ voice, speed: clampSpeed(speechSpeed) });
  }, [connectionState, sendSessionUpdate, speechSpeed, voice]);

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
      <h1>Realtime Voice Agent</h1>
      <p>Baseline app (Phase 1).</p>

      <div className="card">
        <h2>Server status</h2>
        {error ? <p className="error">{error}</p> : null}
        {health ? (
          <dl className="dl">
            <div className="row">
              <dt>OK</dt>
              <dd>{String(health.ok)}</dd>
            </div>
            <div className="row">
              <dt>Server time</dt>
              <dd>{health.serverTime}</dd>
            </div>
            <div className="row">
              <dt>OpenAI key present</dt>
              <dd>{String(health.hasOpenAIKey)}</dd>
            </div>
          </dl>
        ) : (
          <p>Loading…</p>
        )}
      </div>

      <div className="card">
        <h2>Next</h2>
        <p>Next phase is WebRTC connect/disconnect and the ephemeral token endpoint.</p>
      </div>

      <div className="card">
        <h2>Realtime session</h2>

        <div className="controls">
          <label className="field">
            <span>Voice</span>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              disabled={connectionState === "connecting" || connectionState === "connected"}
            >
              <option value="alloy">alloy</option>
              <option value="ash">ash</option>
              <option value="ballad">ballad</option>
              <option value="coral">coral</option>
              <option value="echo">echo</option>
              <option value="sage">sage</option>
              <option value="shimmer">shimmer</option>
              <option value="verse">verse</option>
            </select>
          </label>

          <label className="field">
            <span>Speech speed (effective {clampSpeed(speechSpeed).toFixed(2)}x)</span>
            <input
              type="range"
              min={0.25}
              max={1.5}
              step={0.05}
              value={speechSpeed}
              onChange={(e) => setSpeechSpeed(Number(e.target.value))}
              disabled={connectionState === "connecting"}
            />
          </label>

          <div className="buttons">
            <button
              type="button"
              className="button"
              onClick={() => void connect()}
              disabled={
                !health?.hasOpenAIKey ||
                connectionState === "connecting" ||
                connectionState === "connected"
              }
            >
              Connect
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={disconnect}
              disabled={connectionState !== "connected" && connectionState !== "error"}
            >
              Disconnect
            </button>
          </div>
        </div>

        <p>
          Status: <strong>{connectionState}</strong>
        </p>
        {connectError ? <p className="error">{connectError}</p> : null}

        {ephemeral ? (
          <dl className="dl">
            <div className="row">
              <dt>Session</dt>
              <dd>{ephemeral.sessionId}</dd>
            </div>
            <div className="row">
              <dt>Model</dt>
              <dd>{ephemeral.model}</dd>
            </div>
            <div className="row">
              <dt>Expires at</dt>
              <dd>{ephemeral.expiresAt ?? "(unknown)"}</dd>
            </div>
          </dl>
        ) : null}

        <audio ref={audioRef} autoPlay />
      </div>

      <div className="card">
        <h2>Transcript</h2>
        <div className="transcripts">
          <div className="transcriptLine">
            <strong>You (live):</strong> {liveUserTranscript || "(listening...)"}
          </div>
          <div className="transcriptLine">
            <strong>Assistant (live):</strong> {liveAssistantTranscript || "(speaking...)"}
          </div>
        </div>

        <div className="history">
          {transcriptHistory.length === 0 ? <p>(no transcript yet)</p> : null}
          {transcriptHistory.map((item) => (
            <div key={item.id} className={`bubble ${item.speaker}`}>
              <div className="bubbleHeader">{item.speaker === "user" ? "You" : "Assistant"}</div>
              <div className="bubbleText">{item.text}</div>
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
  );
}
