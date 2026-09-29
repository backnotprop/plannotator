/**
 * Minimal MCP server over newline-delimited JSON-RPC (the MCP stdio
 * transport), with no SDK dependency.
 *
 * `plannotator mcp` needs a handful of methods (initialize, ping, tools/*,
 * resources/*, logging/setLevel, notifications/cancelled), so this stays a
 * small hand-rolled dispatcher instead of pulling @modelcontextprotocol/sdk
 * and its schema stack into the compiled binary.
 *
 * The transport is injected (`send`), so tests drive `handleMessage` directly
 * and never touch process stdio. Under stdio the protocol owns stdout: every
 * byte this module emits goes through `send`, and `runStdioMcpServer` points
 * `console.log` at stderr so a stray log line in shared code cannot corrupt
 * the stream.
 */

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface McpContentText {
  type: "text";
  text: string;
}

export interface McpCallToolResult {
  content: McpContentText[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpToolContext {
  /** Aborted when the client sends notifications/cancelled for this call, or the transport closes. */
  signal: AbortSignal;
  /** Send a notifications/message log entry (visible in client logs). */
  log: (level: "info" | "notice" | "warning" | "error", data: string) => void;
  /** Send notifications/progress when the client supplied a progressToken; no-op otherwise. */
  progress: (message: string) => void;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpCallToolResult>;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  _meta?: Record<string, unknown>;
  read: () => string;
}

export interface McpServerOptions {
  name: string;
  title?: string;
  version: string;
  instructions?: string;
  tools: McpToolDefinition[];
  resources?: McpResourceDefinition[];
  send: (message: Record<string, unknown>) => void;
}

/** Thrown (or returned via rejection) by a handler whose call was cancelled: no response is sent. */
export class McpCallCancelledError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "McpCallCancelledError";
  }
}

// Newest first. The client's requested version is echoed when we know it;
// otherwise we answer with our newest and let the client decide.
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface McpServer {
  /** Dispatch one parsed JSON-RPC message. Resolves once any response has been sent. */
  handleMessage: (message: unknown) => Promise<void>;
  /** Parse a line of stdio input and dispatch it. */
  handleLine: (line: string) => Promise<void>;
  /** Abort every in-flight tool call (transport closing) and wait for them to settle. */
  shutdown: (timeoutMs?: number) => Promise<void>;
  /** Number of tool calls currently running. */
  inFlight: () => number;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const { send } = options;
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const resourcesByUri = new Map((options.resources ?? []).map((r) => [r.uri, r]));
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  const respond = (id: JsonRpcId, result: unknown) =>
    send({ jsonrpc: "2.0", id, result });
  const respondError = (id: JsonRpcId | null, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  function describeTool(tool: McpToolDefinition): Record<string, unknown> {
    const { handler: _handler, ...rest } = tool;
    return rest;
  }

  function describeResource(resource: McpResourceDefinition): Record<string, unknown> {
    const { read: _read, ...rest } = resource;
    return rest;
  }

  async function callTool(id: JsonRpcId, params: Record<string, unknown>): Promise<void> {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = toolsByName.get(name);
    if (!tool) {
      respondError(id, INVALID_PARAMS, `Unknown tool: ${name || "(missing name)"}`);
      return;
    }
    const rawArgs = params.arguments;
    if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
      respondError(id, INVALID_PARAMS, "Tool arguments must be a JSON object");
      return;
    }
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const progressToken = meta.progressToken;
    let progressCount = 0;

    const controller = new AbortController();
    const key = String(id);
    const ctx: McpToolContext = {
      signal: controller.signal,
      log: (level, data) =>
        send({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level, logger: options.name, data },
        }),
      progress: (message) => {
        if (progressToken === undefined || progressToken === null) return;
        if (controller.signal.aborted) return;
        progressCount += 1;
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken, progress: progressCount, message },
        });
      },
    };

    const done = (async () => {
      try {
        const result = await tool.handler((rawArgs ?? {}) as Record<string, unknown>, ctx);
        // A cancelled request gets no response (MCP cancellation semantics).
        if (!controller.signal.aborted) respond(id, result);
      } catch (error) {
        if (error instanceof McpCallCancelledError || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        // Tool failures are tool results the model can read, not protocol errors.
        respond(id, { content: [{ type: "text", text: message }], isError: true });
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, { controller, done });
    await done;
  }

  async function handleRequest(id: JsonRpcId, method: string, params: Record<string, unknown>) {
    switch (method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        respond(id, {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            ...(resourcesByUri.size > 0 ? { resources: { listChanged: false, subscribe: false } } : {}),
            logging: {},
          },
          serverInfo: {
            name: options.name,
            ...(options.title ? { title: options.title } : {}),
            version: options.version,
          },
          ...(options.instructions ? { instructions: options.instructions } : {}),
        });
        return;
      }
      case "ping":
        respond(id, {});
        return;
      case "logging/setLevel":
        respond(id, {});
        return;
      case "tools/list":
        respond(id, { tools: options.tools.map(describeTool) });
        return;
      case "tools/call":
        await callTool(id, params);
        return;
      case "resources/list":
        respond(id, { resources: [...resourcesByUri.values()].map(describeResource) });
        return;
      case "resources/templates/list":
        respond(id, { resourceTemplates: [] });
        return;
      case "prompts/list":
        respond(id, { prompts: [] });
        return;
      case "resources/read": {
        const uri = typeof params.uri === "string" ? params.uri : "";
        const resource = resourcesByUri.get(uri);
        if (!resource) {
          respondError(id, INVALID_PARAMS, `Unknown resource: ${uri || "(missing uri)"}`);
          return;
        }
        respond(id, {
          contents: [
            {
              uri: resource.uri,
              mimeType: resource.mimeType,
              text: resource.read(),
              ...(resource._meta ? { _meta: resource._meta } : {}),
            },
          ],
        });
        return;
      }
      default:
        respondError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  function handleNotification(method: string, params: Record<string, unknown>) {
    if (method === "notifications/cancelled") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        running.get(String(requestId))?.controller.abort(
          typeof params.reason === "string" ? params.reason : "cancelled",
        );
      }
    }
    // notifications/initialized and anything unknown: nothing to do.
  }

  async function handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      respondError(null, INVALID_REQUEST, "Invalid JSON-RPC message");
      return;
    }
    const msg = message as JsonRpcMessage;
    const method = msg.method;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    const hasId = msg.id !== undefined && msg.id !== null;

    if (typeof method !== "string") {
      // A response to a request we never send (we issue none); ignore.
      if (hasId && ("result" in msg || "error" in msg)) return;
      respondError(hasId ? (msg.id as JsonRpcId) : null, INVALID_REQUEST, "Missing method");
      return;
    }
    if (!hasId) {
      handleNotification(method, params);
      return;
    }
    try {
      await handleRequest(msg.id as JsonRpcId, method, params);
    } catch (error) {
      respondError(msg.id as JsonRpcId, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    }
  }

  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      respondError(null, PARSE_ERROR, "Parse error");
      return;
    }
    await handleMessage(parsed);
  }

  async function shutdown(timeoutMs = 5000): Promise<void> {
    const pending = [...running.values()];
    for (const entry of pending) entry.controller.abort("transport closed");
    await Promise.race([
      Promise.allSettled(pending.map((entry) => entry.done)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  return { handleMessage, handleLine, shutdown, inFlight: () => running.size };
}

/**
 * Serve `server` over this process's stdio until stdin closes. Messages are
 * dispatched concurrently (a blocking annotate call must not stall `ping` or
 * a cancellation notification), and stdin EOF aborts every in-flight call so
 * its annotate server shuts down before the process exits.
 */
export async function runStdioMcpServer(
  build: (send: (message: Record<string, unknown>) => void) => McpServer,
): Promise<void> {
  // stdout is the protocol channel. Anything shared code logs with
  // console.log/info must land on stderr instead.
  const toStderr = (...parts: unknown[]) => console.error(...parts);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const send = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const server = build(send);

  const decoder = new TextDecoder();
  let buffer = "";
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void server.handleLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) void server.handleLine(buffer);
  await server.shutdown();
}
