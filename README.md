# Realtime Voice Agent (Home)

Browser-based speech-to-speech voice agent that runs on a home Linux machine and is accessed remotely through a Cloudflare Tunnel.

## Goals

- Speech-to-speech voice conversations in the browser
- WebRTC transport to OpenAI Realtime models
- No application login (access controlled by Cloudflare Zero Trust)
- Local server mints ephemeral OpenAI Realtime tokens (no long-lived keys in the browser)
- Agent orchestration using a chat-supervisor pattern
- Tooling via MCP servers (initially: fetch + shell command execution)
- Voice confirmation approval before executing high-impact tools

## Repository state

This repository currently contains planning documents under `plan/`.

Research material is stored in `research/`.

## Next steps

- Implement the application based on `plan/IMPLEMENTATION_PLAN.md`

## Docker Compose

Start the client and server with Docker:

1. Ensure `.env` exists (see `.env.example`).
2. Run `docker compose up --detach`.
3. Visit http://localhost:8642/ in the browser.
