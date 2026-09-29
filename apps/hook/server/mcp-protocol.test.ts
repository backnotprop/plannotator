/**
 * The hand-rolled MCP stdio dispatcher behind `plannotator mcp`.
 *
 * Guards the protocol behaviors a client depends on: version negotiation, a
 * JSON-RPC error (not a crash or silence) for bad input, and tool failures
 * surfacing as readable tool results.
 */

import { describe, expect, test } from "bun:test";
import { createMcpServer, SUPPORTED_PROTOCOL_VERSIONS } from "./mcp-protocol";

function harness(handler: () => Promise<any> = async () => ({ content: [{ type: "text", text: "ok" }] })) {
  const sent: Record<string, any>[] = [];
  const server = createMcpServer({
    name: "t",
    version: "1",
    tools: [{ name: "echo", description: "d", inputSchema: { type: "object" }, handler }],
    send: (message) => sent.push(message),
  });
  return { server, sent };
}

describe("mcp protocol", () => {
  test("initialize echoes a supported protocol version and falls back to the newest otherwise", async () => {
    const { server, sent } = harness();
    await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(sent[0].result.protocolVersion).toBe("2025-06-18");
    expect(sent[1].result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  test("malformed input gets JSON-RPC errors", async () => {
    const { server, sent } = harness();
    await server.handleLine("{not json");
    await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "no/such" });
    await server.handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "missing" } });
    await server.handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: [1] } });
    expect(sent.map((m) => m.error?.code)).toEqual([-32700, -32601, -32602, -32602]);
  });

  test("a throwing tool becomes an isError tool result the model can read", async () => {
    const { server, sent } = harness(async () => {
      throw new Error("boom");
    });
    await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } });
    expect(sent[0].result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });

  test("notifications never get a response", async () => {
    const { server, sent } = harness();
    await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    await server.handleLine("   ");
    expect(sent).toEqual([]);
  });
});
