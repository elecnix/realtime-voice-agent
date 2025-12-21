import { useEffect, useState } from "react";

type HealthResponse = {
  ok: boolean;
  serverTime: string;
  hasOpenAIKey: boolean;
};

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    </div>
  );
}
