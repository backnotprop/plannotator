export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly annotations?: object;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

export interface McpToolHandler {
  instructions?: string;
  listTools(): readonly McpToolDefinition[];
  callTool(name: string, args: unknown): Promise<McpToolResult>;
}

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const MCP_SERVER_NAME = "plannotator-guide-builder";

export function createMcpMessageHandler(handler: McpToolHandler, serverVersion: string) {
  return async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (!message || typeof message !== "object") return errorResponse(null, -32600, "Invalid request");
    const msg = message as { id?: JsonRpcId; method?: unknown; params?: unknown };
    const isRequest = "id" in msg && msg.id !== undefined;
    if (typeof msg.method !== "string") {
      return isRequest ? errorResponse(msg.id ?? null, -32600, "Invalid request") : null;
    }
    if (!isRequest) return null;
    const id = msg.id ?? null;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    switch (msg.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
        return result(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: serverVersion },
          instructions: handler.instructions ?? "Tools that build the guided review draft held by the Plannotator VS Code extension. Call guide_read to see the draft; call guide_finish when done.",
        });
      }
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, {
          tools: handler.listTools().map((t) => ({
            name: t.name,
            ...(t.title && { title: t.title }),
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations && { annotations: t.annotations }),
          })),
        });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        if (!handler.listTools().some((t) => t.name === name)) return errorResponse(id, -32602, `Unknown tool: ${name}`);
        try {
          const out = await handler.callTool(name, params.arguments ?? {});
          return result(id, { content: [{ type: "text", text: out.text }], isError: out.isError });
        } catch (err) {
          return result(id, { content: [{ type: "text", text: `The tool failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
        }
      }
      default:
        return errorResponse(id, -32601, `Method not found: ${msg.method}`);
    }
  };
}

function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
