# Software Specification

## 1. Overview

This project is a browser-based voice agent designed to run on a home Linux machine and be accessed remotely through a Cloudflare Tunnel.

- The user connects from a remote browser to a web application hosted on the home machine.
- The browser establishes a WebRTC connection to OpenAI Realtime models for low-latency, speech-to-speech interaction.
- A local server on the home machine mints short-lived (ephemeral) OpenAI Realtime credentials so the browser never receives the long-lived OpenAI API key.
- An agentic orchestration pattern (chat-supervisor) splits responsibilities:
  - A realtime “chat” agent handles low-latency conversational interaction.
  - A text-based “supervisor” model performs tool use and more complex decision-making.
- Tools are provided via MCP servers. Initially:
  - `fetch` (HTTP retrieval)
  - `shell` (command execution)
- High-impact actions (for example, shell commands) require voice confirmation.

## 2. Goals

- Speech-to-speech voice conversations with low perceived latency
- WebRTC transport (browser-native)
- TypeScript codebase
- React UI
- Vite build tooling
- No application login (access via Cloudflare Zero Trust)
- Tool extensibility via MCP servers
- Voice confirmation approval for high-impact tools

## 3. Non-goals

- No multi-user authentication/authorization implemented in the app
- No persistence requirements (conversation history may be ephemeral)
- No attempt to “sandbox” tool execution beyond confirmation gating and allowlists

## 4. Assumptions and constraints

- Host OS: Linux
- Deployment: hosted on a home PC, exposed via Cloudflare Tunnel
- OpenAI API key is available on the host environment (not committed)
- Browser clients are untrusted; the long-lived OpenAI API key must never be sent to the browser
- Initial MCP servers required: fetch + shell

## 5. Functional requirements

### 5.1 Browser voice experience

- The UI must allow:
  - Connect/disconnect
  - Microphone permission request and status
  - Display of live transcripts (user and assistant)
  - Display of connection state and errors
- The client must use WebRTC to connect to OpenAI Realtime.
- The client must support speech-to-speech (assistant audio output) and optionally show text transcripts.

### 5.2 Ephemeral credential minting

- The server must expose an endpoint to mint ephemeral credentials:
  - `POST /api/realtime/ephemeral`
- The server uses the long-lived OpenAI API key to call the OpenAI API to create a Realtime session and returns the ephemeral `client_secret.value` to the browser.
- The ephemeral secret must have a short TTL (OpenAI-controlled).

### 5.3 Chat-supervisor orchestration

- The realtime chat agent must:
  - Converse naturally and quickly
  - Ask for clarifications
  - Decide whether an action requires the supervisor
  - When escalation is needed, acknowledge and stall briefly (for example “Give me a moment”) while the supervisor completes tool calls
- The supervisor agent must:
  - Receive the task context and relevant conversation state
  - Decide which tool(s) to call
  - Call tools via MCP
  - Return a concise voice-friendly response

### 5.4 MCP tool integration

- The server must:
  - Read a local MCP configuration file defining servers and how to run them
  - Spawn MCP servers as child processes
  - Discover tool schemas from MCP servers
  - Provide the tool list to the supervisor model

### 5.5 Voice confirmation approval

- For tool calls deemed “high impact” (initially: shell commands), the agent must request confirmation.
- Confirmation must be possible by voice. The system must support:
  - The assistant asking a confirmation question that includes a summary of the proposed action.
  - The user responding with an affirmative or negative.
  - The action only executes after affirmative confirmation.
- The confirmation policy must be enforced server-side.

### 5.6 Observability

- The UI should show:
  - Event log (optional but helpful for debugging)
  - Tool execution log (command issued, time, status, output summary)
- The server must log:
  - Ephemeral token mint requests (without secrets)
  - Supervisor escalations
  - Tool invocations and results (with redaction rules for sensitive data)

## 6. Security requirements

- Never expose the long-lived OpenAI API key to the browser.
- Do not persist ephemeral tokens.
- Restrict tool capabilities:
  - Implement allowlists for shell commands (initially simple allowlist or a denylist for known dangerous patterns).
  - Enforce confirmation.
- The app assumes access is controlled by Cloudflare, but the app should still implement basic hardening:
  - Request size limits
  - CORS limited to the hosted origin
  - No directory listing

## 7. Interfaces

### 7.1 Server HTTP API

- `POST /api/realtime/ephemeral`
  - Returns ephemeral secret for WebRTC.

### 7.2 Realtime tool interface

- Supervisor tool (server-side tool handler registered with the realtime chat agent):
  - Example name: `getNextResponseFromSupervisor`
  - Input: relevant context from the last user message + filtered conversation history
  - Output: a short, voice-friendly response text
  - Behavior: may iterate tool calls (once MCP is integrated) until a final assistant message is produced

### 7.3 MCP configuration

A YAML file in the project root (example name: `mcp.config.yaml`):

- Defines MCP servers:
  - name
  - command
  - args
  - environment variables (prefer reading from process environment)

## 8. Reliability and performance requirements

- Low-latency voice response is prioritized over long-form responses.
- Server should handle reconnects and ephemeral token refresh.
- WebRTC session should fail fast with actionable error messages.

## 9. UX requirements

- Minimal UI
- Clear “Connected / Disconnected” state
- Clear “Listening / Not listening” state
- Clear “Awaiting confirmation” state

## 10. Compliance and operational notes

- Cloudflare Tunnel provides the public entry point.
- No login is implemented; operational security relies on Cloudflare policies.
