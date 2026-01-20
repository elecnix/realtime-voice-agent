# Implementation Plan

## 0. Milestones

1. **Bootstrap repository and baseline app**
2. **Vertical slice: connect + speak + hear (ephemeral token minting + WebRTC audio)**
3. **Chat-supervisor orchestration (supervisor as realtime tool)**
4. **MCP integration (fetch + shell) + voice confirmation policy**
5. **Hardening and operational readiness (Cloudflare tunnel assumptions)**

## 1. Bootstrap repository and baseline app

- Create a TypeScript monorepo layout (or a single repo with `client/` and `server/`).
- Use Vite + React + TypeScript for `client/`.
- Use Node.js + TypeScript for `server/`.
- Prefer Fastify for the server.

Deliverables:

- `npm run dev` starts server and client.
- Basic UI skeleton renders.

## 2. Vertical slice: connect + speak + hear

Goal: prove the core realtime voice pipe works end-to-end before adding orchestration and tools.

### 2.1 Server: ephemeral token endpoint

- Implement `POST /api/realtime/ephemeral`:
  - Reads `OPENAI_API_KEY` from environment.
  - Calls OpenAI Realtime session creation endpoint.
  - Returns only ephemeral secret and minimal metadata.

### 2.2 Client: WebRTC connect

- Implement WebRTC session connect using an OpenAI supported approach (SDK or direct API).
- Fetch ephemeral key from server.
- Connect/disconnect UI.
- Add a client-side session timeout: after 60 seconds, disconnect automatically; shortly before disconnect, show a prompt to click a Resume button to continue.
- Hook transcript and event callbacks for UI.

Deliverables:

- Connect/disconnect works.
- Audio roundtrip works.
- UI shows transcript deltas.
- Basic error reporting for failed connect.

## 3. Chat-supervisor orchestration (supervisor as realtime tool)

Decision: use the working pattern from `openai-realtime-agents` where the realtime chat agent calls a tool (for example `getNextResponseFromSupervisor`) that runs a text model and returns a voice-friendly response.

### 3.1 Define chat agent boundary

- Create the realtime “chat agent” prompt that:
  - stays concise
  - asks clarifying questions
  - has an allowlist of actions it can complete without escalation
  - uses a supervisor tool for everything else

### 3.2 Implement supervisor tool (server-side)

- Implement a realtime tool handler (for example `getNextResponseFromSupervisor`):
  - Collects conversation context (structured transcript or filtered message history).
  - Calls a supervisor text model (for example `gpt-4.1`).
  - Provides the supervisor with available tools (MCP-derived tool schemas once milestone 4 is complete; until then, run in “no-tools” mode).
  - Returns a short response suitable for voice.

Nice to have:

- Add a tool that can pause the conversation before the timeout.
- If user says good bye, pause.
- The voice agent should have direct access to that tool, without going through the supervisor.

### 3.3 Tool-call iteration loop

- Follow the demonstrated pattern:
  - Supervisor may propose tool calls.
  - Tool execution happens server-side.
  - Tool outputs are fed back into the supervisor until a final assistant message is produced.

Deliverables:

- A “requires thinking” query triggers a filler phrase and then a supervisor response.
- The user hears:
  - an immediate acknowledgment
  - then the supervisor result
- Defined JSON shapes for:
  - transcript items stored client-side
  - supervisor tool input (context passed from chat agent)
  - supervisor tool output

## 4. MCP integration + voice confirmation

### 4.1 MCP client layer (server-side)

- Implement MCP server runner:
  - Read `mcp.config.yaml`.
  - Spawn servers as local child processes.
  - Discover tools.

Operational requirements:

- MCP process lifecycle:
  - start on server boot
  - restart on crash (with backoff)
  - shutdown on server stop
- Per-tool timeouts.
- Concurrency policy (initially: serialize high-impact tools).
- Logging and redaction rules for tool inputs and outputs.

### 4.2 Tool policies

- Categorize tools:
  - `fetch`: low impact
  - `shell`: high impact

### 4.3 Voice confirmation

- Implement a confirmation state machine:
  - Supervisor proposes a shell command.
  - Server marks it as pending.
  - Assistant asks for confirmation.
  - User confirms by voice.
  - Server executes command and returns result.

Deliverables:

- `fetch` tool can be called without confirmation.
- `shell` tool requires confirmation.
- Tool execution is logged in UI.

## 5. Hardening and operational readiness

- Display running cost of conversation in UI.
- Enforce limits:
  - request size
  - timeouts
- Ensure no secrets are logged.
- CORS restrict to the hosted origin.

Deliverables:

- Stable reconnect behavior.
- Clear errors.

## 6. Verification steps

Once implementation starts, run after each meaningful change:

- `npm run build`
- `npm run lint`
- `npm run format`
- `npm test` (if configured)

Manual smoke tests:

- Connect from browser, speak, receive audio reply.
- Trigger supervisor escalation.
- Trigger fetch tool.
- Trigger shell tool and confirm via voice.

---

https://platform.openai.com/docs/guides/tools-local-shell
https://github.com/codelion/dynamic-shell-server
https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
https://github.com/ezyang/codemcp
