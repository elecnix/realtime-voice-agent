# MCP Configuration Example

This project expects an MCP configuration file on the server side (for example `mcp.config.yaml`).

## Example: `mcp.config.yaml`

```yaml
mcp:
  servers:
    fetch:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-fetch"]

    shell:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-shell"]
```

Notes:

- The server will spawn these processes locally.
- Prefer storing secrets in environment variables rather than in the YAML file.
