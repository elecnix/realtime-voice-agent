# Security Notes

## Threat model summary

- The browser client is untrusted.
- The app is reachable from the internet (behind Cloudflare Tunnel).
- The agent has access to the home machine via tools.

## Key controls

- Long-lived OpenAI API key remains on the server only.
- Browser receives only ephemeral realtime credentials.
- Tool execution is server-side.
- Shell tool requires voice confirmation.
- Consider command allowlists/denylists and execution timeouts.

## Operational recommendations

- Enforce Cloudflare Zero Trust access policies.
- Restrict who can reach the tunnel.
- Consider IP allowlisting if possible.
- Log tool usage for audit.
