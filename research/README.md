# Research Repository Collection

This folder contains cloned repositories relevant to the OpenAI Realtime Voice Agent implementation.

## Repositories

### Core OpenAI Projects
- **openai-realtime-console** - Official React app for inspecting, building and debugging with the Realtime API
- **openai-realtime-agents** - Official demo showing advanced agentic patterns (Chat-Supervisor, Sequential Handoffs)
- **openai-agents-js** - Official TypeScript/JavaScript Agents SDK with MCP support

### WebRTC Implementations
- **openai-realtime-webrtc** (mostafa-drz) - TypeScript wrapper and demo for OpenAI Realtime API using WebRTC with Next.js
- **simple-realtime-console** (swyxio) - Simplified frontend-only VAD server implementation
- **realtime-webrtc** (gbaeke) - FastAPI backend + WebRTC demo; clean token minting and tool integration
- **openai-realtime-console-webrtc** (thorwebdev) - Fork of the console with WebRTC fixes and edge-case handling

### MCP Integration & Tooling
- **openai-agents-mcp** (lastmile-ai) - MCP extension package for OpenAI Agents SDK (Python-based)
- **openai-agents-mcp-server** (lroolle) - Exposes OpenAI agents via MCP; useful patterns for tool transport and permissions
- **mcp-agent** (lastmile-ai) - Broader orchestration and execution engine; policy layer and handoff patterns

### Alternative Implementations
- **openai-realtime-py** (p-i-) - Python implementation of OpenAI's realtime API

## Key Components to Study

1. **WebRTC Connection Management** - openai-realtime-webrtc, openai-realtime-console, and gbaeke/realtime-webrtc
2. **Chat-Supervisor Pattern** - openai-realtime-agents
3. **MCP Integration** - openai-agents-js (native TypeScript) and openai-agents-mcp (Python)
4. **React/Vite Setup** - openai-realtime-console
5. **Authentication & Token Management** - All repositories
6. **Tool Execution & Confirmation** - openai-agents-mcp-server, mcp-agent, gbaeke/realtime-webrtc

## Repository Management

### Clone All Repositories

Use the provided script to clone all repositories at once:

```bash
./clone_research_repos.sh
```

This script will:
- Create the `research` directory if it doesn't exist
- Clone all 11 repositories listed above
- Skip repositories that already exist
- Provide a summary of the cloning process

### Manual Cloning

If you prefer to clone repositories manually, use the URLs provided above.

## Implementation Strategy

Based on research findings:
- Use **openai-realtime-console** as the base foundation
- Integrate **Chat-Supervisor** pattern from openai-realtime-agents
- Use **native TypeScript MCP support** from openai-agents-js
- Reference **openai-realtime-webrtc** and **gbaeke/realtime-webrtc** for WebRTC best practices
- Study **openai-agents-mcp-server** and **mcp-agent** for tool execution and confirmation policies
