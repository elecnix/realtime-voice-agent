# Research Repo Comparison

This document compares the current plan (see `IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `SOFTWARE_SPEC.md`) against each repository in `research/`.

## 1. Summary: what we are building

- Browser UI (React + Vite + TypeScript) hosted by a local Node server.
- Browser connects to OpenAI Realtime via WebRTC using an ephemeral secret minted by the local server.
- Realtime “chat agent” handles low-latency conversation and calls a server-side supervisor **as a realtime tool** (pattern from `openai-realtime-agents`).
- Supervisor is a text model that can perform tool calls.
- Tools come from MCP servers (initially `fetch` and `shell`) and are executed server-side.
- High-impact tools require voice confirmation.

## 2. How to interpret “use from this repo”

- **Use as-is**
  - We intend to reuse the pattern or approach nearly directly (adapted to our repo structure and dependencies).
- **Use as inspiration**
  - We will borrow selected ideas (for example UX patterns, event naming, state machines), but we are not copying the implementation wholesale.
- **Not using**
  - The repo is useful background, but does not fit our chosen stack, scope, or constraints.

## 3. Repo-by-repo comparison

### 3.1 `openai-realtime-agents`

**What it is**
- Official demo of agentic patterns built on the OpenAI Realtime API + OpenAI Agents SDK.
- Demonstrates “Chat-Supervisor” (realtime chat agent + text supervisor model) and sequential handoffs.

**How it works (high level)**
- Browser establishes a Realtime session.
- Realtime chat agent is configured with limited responsibility.
- Chat agent calls a tool (for example `getNextResponseFromSupervisor`) to ask a supervisor text model for help.
- The tool handler loops on tool calls until a final message is returned.

**What we will use**
- **Use as-is**
  - The **supervisor-as-realtime-tool** boundary and interaction loop.
  - The idea that the chat agent is kept small and mostly delegates.
- **Use as inspiration**
  - UI concepts (event log, tool-call transcript rendering) where helpful.
  - How they structure conversation history passed into the supervisor tool.
- **Not using**
  - Sequential handoff pattern (not needed initially).

**Plan alignment**
- Maps directly to **Milestone 3** in `IMPLEMENTATION_PLAN.md`.

### 3.2 `openai-agents-js`

**What it is**
- Official OpenAI Agents SDK for JavaScript/TypeScript.
- Includes realtime voice agent support and MCP support.

**How it works (high level)**
- Agents are configured with instructions + tools.
- Runner executes an agent loop with tool calling.
- Realtime support includes `RealtimeAgent` and `RealtimeSession`.

**What we will use**
- **Use as-is**
  - The SDK components needed for the realtime chat agent and the supervisor tool implementation.
  - Tool definition patterns and tool execution plumbing for the supervisor.
- **Use as inspiration**
  - Their examples for “human-in-the-loop” when translating into our voice confirmation state machine.
- **Not using**
  - Multi-agent handoffs beyond chat-supervisor (defer).

**Plan alignment**
- Supports **Milestone 2** (WebRTC + realtime session integration) and **Milestone 3** (supervisor tool).

### 3.3 `openai-realtime-console`

**What it is**
- Official example app demonstrating Realtime API events over WebRTC.
- Includes an event log UI for debugging.

**How it works (high level)**
- React client connects via WebRTC and sends/receives Realtime events over the data channel.
- UI shows raw event payloads for debugging.

**What we will use**
- **Use as-is**
  - None (we are not copying the entire console).
- **Use as inspiration**
  - Event logging UI patterns and minimal WebRTC event wiring.
  - Debug UX: inspect client/server events.
- **Not using**
  - Its server structure (Express + Vite in their template) because we prefer Fastify and our own repo layout.

**Plan alignment**
- Useful for **Milestone 2** debugging (connect + speak + hear).

### 3.4 `openai-realtime-console-webrtc`

**What it is**
- A fork of `openai-realtime-console` focused on WebRTC fixes / edge-case handling.

**How it works (high level)**
- Same conceptual architecture as `openai-realtime-console`, adjusted for WebRTC reliability.

**What we will use**
- **Use as-is**
  - None.
- **Use as inspiration**
  - WebRTC edge-case fixes if we hit connection instability.
- **Not using**
  - Not a baseline; treat as a patch/reference only.

**Plan alignment**
- Back-pocket reference during **Milestone 2**.

### 3.5 `simple-realtime-console`

**What it is**
- A simplified “console” style app (frontend-focused) derived from `openai-realtime-console`.

**How it works (high level)**
- Minimal UI, transcript formatting improvements, less event noise.

**What we will use**
- **Use as-is**
  - None.
- **Use as inspiration**
  - Transcript rendering and “reduce noisy logs” patterns.
- **Not using**
  - It prompts for API keys client-side and stores them in localStorage; we will not do this.

**Plan alignment**
- Useful for UI ergonomics in **Milestone 2**.

### 3.6 `openai-realtime-webrtc` (mostafa-drz)

**What it is**
- A Next.js + TypeScript boilerplate with a `RealtimeClient` abstraction layer and detailed event model.

**How it works (high level)**
- Server creates sessions and returns a client secret.
- Client performs SDP offer/answer to connect to the Realtime WebRTC endpoint.
- Provides a wrapper class with event callbacks and typed event definitions.

**What we will use**
- **Use as-is**
  - None (we are not adopting Next.js nor copying their wrapper wholesale).
- **Use as inspiration**
  - The clear breakdown of session creation vs WebRTC connection.
  - Their typed event and transcript callback approach (speaker-specific delta/done callbacks).
  - Their turn-detection discussion (server VAD vs semantic VAD vs manual).
- **Not using**
  - Next.js server actions approach.

**Plan alignment**
- Strong reference for **Milestone 2** implementation details and ergonomics.

### 3.7 `realtime-webrtc` (gbaeke)

**What it is**
- A FastAPI-based backend demo plus WebRTC frontend.

**How it works (high level)**
- Backend mints ephemeral token; frontend does WebRTC; includes example tool integration (weather).

**What we will use**
- **Use as-is**
  - None (Python backend).
- **Use as inspiration**
  - Token minting and minimal server endpoints.
  - How they structure tool integration at a high level.
- **Not using**
  - Python/FastAPI and Azure-specific notes.

**Plan alignment**
- Reference for **Milestone 2** (token + connect) and early tool shape concepts.

### 3.8 `openai-realtime-py`

**What it is**
- A Python implementation of OpenAI’s realtime API.

**How it works (high level)**
- Provides a websocket/audio oriented implementation and notes on responsiveness issues.

**What we will use**
- **Use as-is**
  - None.
- **Use as inspiration**
  - Operational lessons: realtime audio processing pitfalls and echo/feedback concerns.
- **Not using**
  - Python implementation details.

**Plan alignment**
- Background reference only.

### 3.9 `mcp-agent`

**What it is**
- A Python framework implementing MCP client/server patterns and “effective agent patterns”.

**How it works (high level)**
- Loads MCP configuration, manages server connections, exposes tools to an agent runtime.
- Emphasizes lifecycle management, logging, and composable patterns.

**What we will use**
- **Use as-is**
  - None (Python runtime).
- **Use as inspiration**
  - MCP lifecycle management requirements (restart/backoff, structured logs).
  - Configuration patterns and separation of secrets.
  - Human input / approval patterns, conceptually.
- **Not using**
  - Temporal/durable execution and cloud deployment pieces (out of scope).

**Plan alignment**
- Informs **Milestone 4** operational requirements.

### 3.10 `openai-agents-mcp`

**What it is**
- Python extension that connects OpenAI Agents SDK to MCP servers.

**How it works (high level)**
- Provides MCP config discovery, tool aggregation, tool schema conversion.

**What we will use**
- **Use as-is**
  - None (Python).
- **Use as inspiration**
  - MCP config structure ideas (server name → command/args, secrets separation).
  - The “aggregate MCP tools + local tools” approach.
- **Not using**
  - Python integration implementation.

**Plan alignment**
- Informs **Milestone 4** MCP configuration and schema mapping.

### 3.11 `openai-agents-mcp-server`

**What it is**
- Python MCP server that exposes OpenAI agents through MCP.

**How it works (high level)**
- Implements an MCP server and offers tools backed by OpenAI agents.

**What we will use**
- **Use as-is**
  - None.
- **Use as inspiration**
  - How to expose agent-like capabilities through MCP (useful if later we want to modularize capabilities).
- **Not using**
  - Running OpenAI agents *through* MCP is not part of the current plan.

**Plan alignment**
- Not needed for milestones 1–5; reference only.

## 4. Gaps / follow-ups

- Decide whether to base the client’s event typing on:
  - the Agents SDK event types, or
  - a small internal event model (typed subset) for UI purposes.
- Decide whether to implement VAD mode selection (server VAD vs semantic VAD vs manual) in the UI early or defer.
- For shell tool confirmation, define:
  - allowed command patterns,
  - timeouts,
  - output truncation/redaction.
