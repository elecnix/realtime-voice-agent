# Architecture

## 1. High-level architecture

### Components

- **Browser client (React + Vite + TypeScript)**
  - Establishes WebRTC connection to OpenAI Realtime using an ephemeral secret
  - Handles microphone input and audio output
  - Displays transcripts, tool confirmations, and logs

- **Local application server (Node.js, TypeScript)**
  - Mints ephemeral OpenAI Realtime tokens
  - Runs supervisor agent (text model)
  - Hosts MCP tool execution (fetch + shell) and enforces confirmation policies

- **MCP servers (child processes)**
  - Provide tools (initially fetch + shell)
  - Local-only processes on the home machine

- **OpenAI Realtime API**
  - Speech-to-speech realtime model
  - WebRTC transport

- **OpenAI Responses/Agents API (text supervisor)**
  - Used by the supervisor model for tool calling and planning

## 2. Data flow

### 2.1 Session establishment

1. Browser loads UI from local server.
2. User clicks Connect.
3. Browser requests ephemeral credentials:
   - `POST /api/realtime/ephemeral`
4. Server calls OpenAI to create a realtime session and returns ephemeral secret.
5. Browser establishes WebRTC connection to OpenAI Realtime using ephemeral secret.

### 2.2 Normal conversation (no tools)

1. User speaks.
2. Realtime model responds with audio.
3. UI shows transcript updates.

### 2.3 Escalation to supervisor

1. Realtime chat agent decides escalation is needed.
2. Realtime chat agent calls a server-side supervisor tool handler (for example `getNextResponseFromSupervisor`).
3. The supervisor tool handler forwards conversation context to a supervisor text model.
4. Supervisor proposes actions (tool calls) and a response.
5. If actions require confirmation:
   - The assistant asks the user for confirmation via voice.
   - Only after confirmation does the server execute tool calls.
6. Tool results feed into supervisor.
7. Supervisor returns a short response.
8. Response is returned to the realtime chat agent via the tool response so it is spoken.

## 3. Chat-supervisor boundary

### Realtime chat agent responsibilities

- Maintain natural, low-latency conversation
- Perform lightweight tasks without tools
- Trigger supervisor for:
  - tool use
  - multi-step reasoning
  - tasks involving file operations or network activity

### Supervisor responsibilities

- Tool planning and execution
- Enforcing confirmation policies
- Producing concise, voice-friendly responses

## 4. Tool execution and confirmation

### Tool categories

- **Low impact**: fetch
- **High impact**: shell

### Confirmation enforcement

- The server must enforce that high-impact tools require confirmation.
- Confirmation occurs via voice:
  - The assistant asks a confirmation question.
  - The user responds with a clear affirmative/negative.

## 5. Configuration

### MCP server configuration file

- Stored locally in the project directory (for example `mcp.config.yaml`).
- Supports:
  - server name
  - command
  - args
  - env var mapping

### Model configuration

- Realtime chat agent model (speech-to-speech)
- Supervisor text model

## 6. Deployment topology

- The server listens on localhost or LAN interface.
- Cloudflare Tunnel routes external traffic to the server.
- No login page.

## 7. Key design decisions

- WebRTC is used for realtime voice.
- Ephemeral credentials are minted server-side.
- Supervisor does tool calls; realtime model focuses on low-latency interaction.
- MCP processes run locally, never exposed directly to the internet.
