/**
 * Claude Code cuts a tool description at 2,048 characters, which would cut off the last line, the `--help` pointer.
 * What regresses: an action's line (`routine`, or a new one) pushing `plannotator_inbox` past it in the worst case,
 * every capability that adds an action on (the Board, the Checklist, Routines), in both builders (the shared one and
 * the Claude Code mod's byte copy); and a `capability` action coming back into the tool (the owner, 2026-11-24: turning
 * a capability is `plannotator inbox capability`, in the CLI help only). No Inbox runs: the bundled list and each
 * action's real definition.
 */
import { expect, test } from "bun:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { inboxAgentTool, INBOX_TOOL_ACTIONS, INBOX_TOOL_HELP_NOTE, type InboxToolInfo } from "@plannotator/shared/inbox/connection";
import { inboxAgentTool as modAgentTool, INBOX_TOOL_ACTIONS as MOD_TOOL_ACTIONS } from "../../apps/hook/hooks/mod/inbox-contract";
import { INBOX_MCP_TOOLS } from "./inbox-mcp";
import { INBOX_DEFAULT_TOOLS } from "../../apps/hook/hooks/mod/inbox-default-tools";
import { registerInboxCardTool } from "./inbox-mcp-cards";
import { registerInboxStepsTool } from "./inbox-mcp-steps";
import { registerInboxScheduledTool } from "./inbox-mcp-scheduled";

async function servedWithEverythingOn(): Promise<InboxToolInfo[]> {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "budget", version: "1" });
      registerInboxCardTool(server, {} as never);
      registerInboxStepsTool(server, {} as never);
      registerInboxScheduledTool(server, {} as never);
      return server;
    },
    { legacy: "stateless" },
  );
  const response = await handler.fetch(
    new Request("http://127.0.0.1/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }),
  );
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  const extra = (JSON.parse(data ? data.slice(5) : text) as { result: { tools: InboxToolInfo[] } }).result.tools;
  return [...INBOX_DEFAULT_TOOLS, ...extra];
}

test("with the Board, the Checklist and Routines on, the agent tool's description stays under 2,048 and ends with the help line", async () => {
  const served = await servedWithEverythingOn();
  expect(served.map((tool) => tool.name)).toEqual(expect.arrayContaining(["card", "steps", "routine"]));
  for (const build of [inboxAgentTool, modAgentTool]) {
    const tool = build(served)!;
    expect(tool.description.length).toBeLessThan(2_048);
    expect(tool.description.endsWith(INBOX_TOOL_HELP_NOTE)).toBe(true);
    // Every action stays callable: the description only lost lines, never an action.
    const actions = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).action!.enum!;
    expect(actions).toEqual(served.map((one) => one.name));
    expect(actions).not.toContain("capability");
  }
});

test("the agent tool has no capability action: not in the contract's actions, the bundled list or the Inbox's tools", () => {
  for (const actions of [INBOX_TOOL_ACTIONS, MOD_TOOL_ACTIONS, INBOX_MCP_TOOLS, INBOX_DEFAULT_TOOLS.map((tool) => tool.name)]) expect(actions).not.toContain("capability");
});
