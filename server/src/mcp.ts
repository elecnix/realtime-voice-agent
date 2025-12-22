import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as yamlParse } from "yaml";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: unknown;
};

type McpConfig = {
  mcp?: {
    servers?: Record<
      string,
      | {
          command: string;
          args?: string[];
          env?: Record<string, string>;
        }
      | {
          url: string;
        }
    >;
  };
};

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

type CallToolResult = {
  content?: unknown;
};

export type OpenAiChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
  };
};

type McpServerSpec =
  | {
      type: "stdio";
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      type: "remote";
      name: string;
      url: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
};

type StdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type RemoteServerConfig = {
  url: string;
};

const isRemoteServerConfig = (config: unknown): config is RemoteServerConfig => {
  return isRecord(config) && typeof config.url === "string";
};

const isStdioServerConfig = (config: unknown): config is StdioServerConfig => {
  return isRecord(config) && typeof config.command === "string";
};

const parseYaml: (raw: string) => unknown = yamlParse as unknown as (raw: string) => unknown;

const encodeMcpMessage = (payload: unknown): Buffer => {
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
};

const parseMcpOutputBuffer = (buffer: Buffer): { messages: JsonRpcResponse[]; rest: Buffer } => {
  const messages: JsonRpcResponse[] = [];
  let rest = buffer;

  const tryParseContentLengthFrames = (): boolean => {
    let parsedAny = false;

    // MCP servers typically speak JSON-RPC over stdio using LSP-style framing:
    // Content-Length: <n>\r\n\r\n<json>
    while (rest.length > 0) {
      const headerEndCrlf = rest.indexOf("\r\n\r\n");
      const headerEndLf = headerEndCrlf === -1 ? rest.indexOf("\n\n") : -1;
      const headerEnd = headerEndCrlf !== -1 ? headerEndCrlf : headerEndLf;
      const headerSepLen = headerEndCrlf !== -1 ? 4 : headerEndLf !== -1 ? 2 : 0;

      if (headerEnd === -1) {
        break;
      }

      const headerText = rest.subarray(0, headerEnd).toString("utf8");
      const contentLengthMatch = /\bcontent-length\s*:\s*(\d+)\b/i.exec(headerText);
      if (!contentLengthMatch) {
        break;
      }

      const contentLength = Number(contentLengthMatch[1]);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        break;
      }

      const bodyStart = headerEnd + headerSepLen;
      const bodyEnd = bodyStart + contentLength;
      if (rest.length < bodyEnd) {
        break;
      }

      const bodyText = rest.subarray(bodyStart, bodyEnd).toString("utf8");
      rest = rest.subarray(bodyEnd);
      parsedAny = true;

      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (isRecord(parsed) && parsed.jsonrpc === "2.0" && "id" in parsed) {
          messages.push(parsed as JsonRpcResponse);
        }
      } catch {
        // ignore
      }
    }

    return parsedAny;
  };

  const parseJsonLinesFallback = () => {
    const text = rest.toString("utf8");
    const lines = text.split("\n");
    const completeLines = lines.slice(0, -1);
    const tail = lines.at(-1) ?? "";

    for (const line of completeLines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed) && parsed.jsonrpc === "2.0" && "id" in parsed) {
          messages.push(parsed as JsonRpcResponse);
        }
      } catch {
        // ignore
      }
    }

    rest = Buffer.from(tail, "utf8");
  };

  const parsedFrames = tryParseContentLengthFrames();
  if (!parsedFrames) {
    parseJsonLinesFallback();
  }

  return { messages, rest };
};

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private restarting = false;
  private restartDelayMs = 500;
  private stderrTail = "";
  private allowRestart = true;

  constructor(private spec: Extract<McpServerSpec, { type: "stdio" }>) {}

  async connect(): Promise<void> {
    if (this.child) {
      return;
    }

    this.allowRestart = true;

    const child = spawn(this.spec.command, this.spec.args, {
      env: {
        ...process.env,
        ...this.spec.env
      },
      stdio: "pipe"
    });

    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      const { messages, rest } = parseMcpOutputBuffer(this.buffer);
      this.buffer = rest;

      for (const msg of messages) {
        const id =
          typeof msg.id === "number" ? msg.id : typeof msg.id === "string" ? Number(msg.id) : null;

        if (!Number.isFinite(id ?? NaN)) {
          continue;
        }

        const pending = this.pending.get(id as number);
        if (!pending) {
          continue;
        }

        this.pending.delete(id as number);

        if (msg.error) {
          pending.reject(new Error(`MCP error: ${JSON.stringify(msg.error).slice(0, 2000)}`));
          continue;
        }

        pending.resolve(msg.result);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const next = `${this.stderrTail}${chunk}`;
      this.stderrTail = next.length > 4000 ? next.slice(next.length - 4000) : next;
    });

    child.on("error", (err) => {
      this.child = null;
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`MCP process error: ${err.message}`));
      }
      this.pending.clear();
    });

    child.on("exit", () => {
      this.child = null;
      for (const [, pending] of this.pending) {
        pending.reject(new Error("MCP process exited"));
      }
      this.pending.clear();

      if (this.allowRestart) {
        void this.scheduleRestart();
      }
    });

    try {
      await this.initialize();
    } catch (e) {
      await this.close();
      const message = e instanceof Error ? e.message : "Unknown error";
      const tail = this.stderrTail.trim();
      const tailText = tail ? ` (stderr: ${tail})` : "";
      throw new Error(`Failed to initialize MCP server ${this.spec.name}: ${message}${tailText}`);
    }
  }

  close(): Promise<void> {
    this.restarting = false;
    this.restartDelayMs = 500;
    this.allowRestart = false;

    const child = this.child;
    this.child = null;

    if (!child) {
      return Promise.resolve();
    }

    child.kill();
    return Promise.resolve();
  }

  private async scheduleRestart(): Promise<void> {
    if (this.restarting) {
      return;
    }
    this.restarting = true;

    while (this.restarting) {
      await new Promise((r) => setTimeout(r, this.restartDelayMs));
      try {
        await this.connect();
        this.restarting = false;
        this.restartDelayMs = 500;
        return;
      } catch {
        this.restartDelayMs = Math.min(10_000, Math.round(this.restartDelayMs * 1.8));
      }
    }
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: "realtime-voice-agent",
        version: "0.0.0"
      }
    });

    await this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request("tools/list", {});
    if (!isRecord(result)) {
      return [];
    }

    const toolsRaw = result.tools;
    if (!Array.isArray(toolsRaw)) {
      return [];
    }

    return toolsRaw.filter(isRecord) as McpToolDefinition[];
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.request("tools/call", {
      name: toolName,
      arguments: args
    });

    return isRecord(result) ? (result as CallToolResult) : { content: result };
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child) {
      throw new Error("MCP process not running");
    }

    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const body = encodeMcpMessage(payload);

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        const tail = this.stderrTail.trim();
        const tailText = tail ? ` (stderr: ${tail})` : "";
        pending.reject(new Error(`MCP timeout calling ${method}${tailText}`));
      }, 300_000);

      const settle = {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };

      this.pending.set(id, settle);

      child.stdin.write(body, (err) => {
        if (err) {
          this.pending.delete(id);
          settle.reject(new Error(`Failed to write to MCP stdin: ${err.message}`));
        }
      });
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child) {
      throw new Error("MCP process not running");
    }

    const payload = {
      jsonrpc: "2.0",
      method,
      params
    };

    const body = encodeMcpMessage(payload);

    await new Promise<void>((resolve, reject) => {
      child.stdin.write(body, (err) => {
        if (err) {
          reject(new Error(`Failed to write MCP notification: ${err.message}`));
          return;
        }
        resolve();
      });
    });
  }
}

class McpRemoteClient {
  private connected = false;
  private nextId = 1;

  constructor(private spec: Extract<McpServerSpec, { type: "remote" }>) {}

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.initialize();
      this.connected = true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      throw new Error(`Failed to initialize remote MCP server ${this.spec.name}: ${message}`);
    }
  }

  close(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: "realtime-voice-agent",
        version: "0.0.0"
      }
    });

    await this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request("tools/list", {});
    if (!isRecord(result)) {
      return [];
    }

    const toolsRaw = result.tools;
    if (!Array.isArray(toolsRaw)) {
      return [];
    }

    return toolsRaw.filter(isRecord) as McpToolDefinition[];
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.request("tools/call", {
      name: toolName,
      arguments: args
    });

    return isRecord(result) ? (result as CallToolResult) : { content: result };
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.connected && method !== "initialize") {
      throw new Error("Remote MCP not connected");
    }

    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const response = await fetch(this.spec.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Remote MCP request failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      const lines = text.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonData = line.slice(6);
          try {
            const data: unknown = JSON.parse(jsonData);
            if (!isRecord(data)) {
              continue;
            }

            const rpcResponse = data as JsonRpcResponse;
            if (rpcResponse.id === id) {
              if (rpcResponse.error) {
                throw new Error(`MCP error: ${JSON.stringify(rpcResponse.error).slice(0, 2000)}`);
              }
              return rpcResponse.result;
            }
          } catch (e) {
            if (e instanceof Error && e.message.startsWith("MCP error")) {
              throw e;
            }
          }
        }
      }
      throw new Error("No matching response in SSE stream");
    }

    const data: unknown = await response.json();
    if (!isRecord(data)) {
      throw new Error("Invalid response from remote MCP server");
    }

    const rpcResponse = data as JsonRpcResponse;
    if (rpcResponse.error) {
      throw new Error(`MCP error: ${JSON.stringify(rpcResponse.error).slice(0, 2000)}`);
    }

    return rpcResponse.result;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const payload = {
      jsonrpc: "2.0",
      method,
      params
    };

    const response = await fetch(this.spec.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Remote MCP notification failed: ${response.status} ${response.statusText}`);
    }
  }
}

export type ToolPolicy = {
  requiresConfirmation: boolean;
  kind: "fetch" | "shell";
};

export type ToolCallResult = {
  toolName: string;
  serverName: string;
  rawToolName: string;
  result: unknown;
};

export type PendingToolCall = {
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
  policy: ToolPolicy;
};

type McpClient = McpStdioClient | McpRemoteClient;

export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolIndex = new Map<
    string,
    {
      serverName: string;
      tool: McpToolDefinition;
      policy: ToolPolicy;
    }
  >();

  private toolNameCollisions = new Map<string, number>();

  private startupErrors: Array<{ serverName: string; message: string }> = [];

  constructor(
    private repoRoot: string,
    private configPath: string
  ) {}

  async start(): Promise<void> {
    const config = await this.loadConfig();
    const servers = this.parseServers(config);

    this.startupErrors = [];

    for (const spec of servers) {
      const client = spec.type === "stdio" ? new McpStdioClient(spec) : new McpRemoteClient(spec);
      try {
        await client.connect();
        this.clients.set(spec.name, client);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        this.startupErrors.push({
          serverName: spec.name,
          message
        });
      }
    }

    await this.refreshTools();
  }

  getStartupErrors(): Array<{ serverName: string; message: string }> {
    return [...this.startupErrors];
  }

  async close(): Promise<void> {
    const closers = [...this.clients.values()].map((client) => client.close());
    await Promise.allSettled(closers);
    this.clients.clear();
    this.toolIndex.clear();
  }

  hasTools(): boolean {
    return this.toolIndex.size > 0;
  }

  async refreshTools(): Promise<void> {
    this.toolIndex.clear();
    this.toolNameCollisions.clear();

    for (const [serverName, client] of this.clients) {
      const tools = await client.listTools();
      for (const tool of tools) {
        const namespaced = this.allocateOpenAiToolName(serverName, tool.name);
        const policy = this.getPolicyForServer(serverName);
        this.toolIndex.set(namespaced, {
          serverName,
          tool,
          policy
        });
      }
    }
  }

  private allocateOpenAiToolName(serverName: string, toolName: string): string {
    const base = toOpenAiToolName(serverName, toolName);
    const used = this.toolNameCollisions.get(base);
    if (!used) {
      this.toolNameCollisions.set(base, 1);
      return base;
    }

    const next = used + 1;
    this.toolNameCollisions.set(base, next);
    return `${base}_${next}`;
  }

  getOpenAiTools(): OpenAiChatTool[] {
    const tools: OpenAiChatTool[] = [];

    for (const [toolName, entry] of this.toolIndex) {
      const schema = entry.tool.inputSchema;
      const properties = schema && isRecord(schema.properties) ? schema.properties : {};
      const required = schema && isStringArray(schema.required) ? schema.required : [];
      const additionalProperties =
        schema && typeof schema.additionalProperties === "boolean"
          ? schema.additionalProperties
          : false;

      tools.push({
        type: "function",
        function: {
          name: toolName,
          ...(entry.tool.description ? { description: entry.tool.description } : {}),
          parameters: {
            type: "object",
            properties,
            required,
            additionalProperties
          }
        }
      });
    }

    return tools;
  }

  getToolPolicy(toolName: string): ToolPolicy | null {
    const entry = this.toolIndex.get(toolName);
    return entry ? entry.policy : null;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const entry = this.toolIndex.get(toolName);
    if (!entry) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }

    const client = this.clients.get(entry.serverName);
    if (!client) {
      throw new Error(`MCP server not connected: ${entry.serverName}`);
    }

    const result = await client.callTool(entry.tool.name, args);
    return {
      toolName,
      serverName: entry.serverName,
      rawToolName: entry.tool.name,
      result
    };
  }

  private getPolicyForServer(serverName: string): ToolPolicy {
    if (serverName.toLowerCase().includes("shell")) {
      return {
        requiresConfirmation: true,
        kind: "shell"
      };
    }

    return {
      requiresConfirmation: false,
      kind: "fetch"
    };
  }

  private async loadConfig(): Promise<McpConfig> {
    try {
      const fullPath = path.isAbsolute(this.configPath)
        ? this.configPath
        : path.join(this.repoRoot, this.configPath);
      const examplePath = path.isAbsolute(this.configPath)
        ? this.configPath
        : path.join(this.repoRoot, "mcp.config.example.yaml");

      const raw = await fs.readFile(fullPath, "utf8").catch(() => fs.readFile(examplePath, "utf8"));
      const parsed = parseYaml(raw);
      return isRecord(parsed) ? (parsed as McpConfig) : {};
    } catch {
      return {};
    }
  }

  private parseServers(config: McpConfig): McpServerSpec[] {
    const serversRaw = config.mcp?.servers;
    if (!serversRaw || !isRecord(serversRaw)) {
      return [];
    }

    const servers: McpServerSpec[] = [];

    for (const [name, specRaw] of Object.entries(serversRaw)) {
      if (isRemoteServerConfig(specRaw)) {
        servers.push({
          type: "remote",
          name,
          url: specRaw.url
        });
        continue;
      }

      if (isStdioServerConfig(specRaw)) {
        const args = isStringArray(specRaw.args) ? specRaw.args : [];
        const env = isRecord(specRaw.env)
          ? Object.fromEntries(
              Object.entries(specRaw.env).flatMap(([k, v]) => {
                if (typeof v !== "string") {
                  return [];
                }
                const expanded = expandEnvPlaceholders(v);
                return expanded ? [[k, expanded]] : [];
              })
            )
          : {};

        servers.push({
          type: "stdio",
          name,
          command: specRaw.command,
          args,
          env
        });
      }
    }

    return servers;
  }
}

export const createMcpManager = async (repoRoot: string): Promise<McpManager> => {
  const manager = new McpManager(repoRoot, "mcp.config.yaml");
  await manager.start();
  return manager;
};

const sanitizeToolComponent = (value: string): string => {
  const replaced = value.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const collapsed = replaced.replace(/_+/g, "_");
  return collapsed.replace(/^_+|_+$/g, "");
};

const toOpenAiToolName = (serverName: string, toolName: string): string => {
  const serverPart = sanitizeToolComponent(serverName) || "mcp";
  const toolPart = sanitizeToolComponent(toolName) || "tool";
  return `${serverPart}__${toolPart}`;
};

const expandEnvPlaceholders = (value: string): string => {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, varName: string) => {
    const replacement = process.env[varName];
    return typeof replacement === "string" ? replacement : "";
  });
};
