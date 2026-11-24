/**
 * The `capability` tool (inbox-mcp-capability.ts) against a stand-in context: no Inbox runs. What regresses: the tool
 * missing from tools/list while capabilities are off (it is how one is turned on); a turn not taking, or taking on the
 * wrong computer; the person's line posted twice, posted for a turn that changed nothing, or not said when it had
 * nowhere to go; a linked computer's held turn reported as done; a linked computer too old for it, or a name that
 * matches none, answered as if it worked.
 */
import { describe, expect, test } from "bun:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type { InboxCapabilitySwitches, InboxCapabilitySwitchKey } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { capabilityLineText, registerInboxCapabilityTool, type InboxCapabilityMcpContext } from "./inbox-mcp-capability";
import { inboxScheduledOffText } from "./inbox-scheduled";

type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

function world(options: { far?: "online" | "away" | "older" | "last-said" } = {}) {
  const here: InboxCapabilitySwitches = { board: { on: false }, steps: { on: false }, scheduled_threads: { on: false }, bro: { on: false } };
  const there: InboxCapabilitySwitches = { board: { on: true }, scheduled_threads: { on: false } };
  const lines: { thread: string | null; project: string | null; body: string; by: string }[] = [];
  const turns: string[] = [];
  let settle: (end: { taken: boolean; why: string | null }) => void = () => {};
  const context: InboxCapabilityMcpContext = {
    // The door's own lookup (a paired agent's project is the door's): the line lands in the project it names.
    resolveProject: async (path) => ({ id: `prj:${path}` }),
    capabilities: {
      here: () => structuredClone(here),
      set: async (key: InboxCapabilitySwitchKey, on: boolean) => {
        turns.push(`here ${key} ${on}`);
        here[key] = { on };
        return structuredClone(here);
      },
      there: async (computer, change) => {
        if (computer.toLowerCase() !== "studio") return null;
        if (options.far === "older") throw new InboxError("machine_needs_update", "Update Plannotator on Studio: its capabilities cannot be turned from another computer yet. Nothing changed.");
        if (options.far === "away" || options.far === "last-said") {
          // Never read since this Inbox started (away), or read before it went away (last-said: board on, as it last said).
          if (!change && options.far === "away") throw new InboxError("machine_offline", "Studio cannot be reached now.");
          if (!change) return { name: "Studio", switches: structuredClone(there), held: null, awaySince: "2026-11-24T14:10:00.000Z", pending: [] };
          turns.push(`Studio ${change.key} ${change.on} (held)`);
          return { name: "Studio", switches: null, held: "Waiting for Studio: this applies when Studio is back.", settled: new Promise((resolve) => (settle = resolve)) };
        }
        if (change) {
          turns.push(`Studio ${change.key} ${change.on}`);
          there[change.key] = { on: change.on };
        }
        return { name: "Studio", switches: structuredClone(there), held: null };
      },
      linked: () => ["Studio"],
      tell: async (by, thread, projectOf, body) => {
        const project = thread ? null : await projectOf();
        if (!thread && !project) return null;
        lines.push({ thread, project, body, by: by.name });
        return thread ?? "msg_new";
      },
    },
  };
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "test", version: "1" });
      registerInboxCapabilityTool(server, context);
      return server;
    },
    { legacy: "stateless" },
  );
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await handler.fetch(
      new Request("http://127.0.0.1/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }),
    );
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return JSON.parse(data ? data.slice(5) : text) as { result: any };
  };
  const agent = { agent_session: "ses_ada", agent_host: "claude-code", agent_name: "Claude Code", project_path: "/work/api" };
  const call = async (args: Record<string, unknown>) => (await rpc("tools/call", { name: "capability", arguments: { ...agent, ...args } })).result as Result;
  return { here, there, lines, turns, rpc, call, settle: (end: { taken: boolean; why: string | null }) => settle(end) };
}

const SHELL_NOW = "Agents get the routine action in their next session (a session's tools are listed once, at its start); from a shell it works now: `plannotator routine --help`.";

describe("the capability tool", () => {
  test("is listed with every capability off, and turns one on here: one line for the person, in the thread named", async () => {
    const w = world();
    expect(((await w.rpc("tools/list", {})).result.tools as { name: string }[]).map((tool) => tool.name)).toEqual(["capability"]);
    const turned = await w.call({ capability: "routines", on: true, thread_id: "msg_work" });
    expect(turned.isError).toBeFalsy();
    // This session's tools were listed with Routines off: the result says where the action is, and what works now.
    expect(turned.content[0]!.text).toBe(`Turned on Routines on this computer. The person sees it in thread msg_work. ${SHELL_NOW}`);
    expect(w.here.scheduled_threads).toEqual({ on: true });
    expect(w.lines).toEqual([{ thread: "msg_work", project: null, body: "Turned on Routines.", by: "Claude Code" }]);
    // The same turn again changes nothing and posts nothing, and still says why this session may have no routine action.
    const again = await w.call({ capability: "routines", on: true, thread_id: "msg_work" });
    expect(again.content[0]!.text).toBe(`Routines was already on (this computer). Nothing changed. ${SHELL_NOW}`);
    expect([w.lines.length, w.turns]).toEqual([1, ["here scheduled_threads true"]]);
    // A switch that serves no action, or a turn off, says nothing of a next session.
    expect((await w.call({ capability: "bro_mode", on: true })).content[0]!.text).toBe("Turned on Bro mode on this computer. The person sees it in thread msg_new.");
  });

  test("lists each one and whether it is on; a capability not offered here is refused", async () => {
    const w = world();
    expect((await w.call({})).content[0]!.text).toBe("On this computer: board off, checklist off, routines off, bro_mode off.");
    w.here.code_review = { on: true };
    const refused = await w.call({ capability: "chapter_diagrams", on: true });
    expect([refused.isError, refused.content[0]!.text]).toEqual([true, "not_offered: Chapter diagrams is not offered on this computer."]);
    expect(w.turns).toEqual([]);
  });

  test("a hidden switch (System) is not an agent's: never named, listed or turned, even while it is on", async () => {
    const w = world();
    w.here.system = { on: true };
    const tools = (await w.rpc("tools/list", {})).result.tools as { inputSchema: { properties: { capability: { enum: string[] } } } }[];
    expect(tools[0]!.inputSchema.properties.capability.enum).not.toContain("system");
    const listed = await w.call({});
    expect(listed.content[0]!.text).not.toContain("system");
    expect(Object.keys(listed.structuredContent!.capabilities as object)).not.toContain("system");
    const refused = await w.call({ capability: "system", on: false });
    expect(refused.isError).toBe(true);
    expect([w.here.system, w.turns]).toEqual([{ on: true }, []]);
  });

  test("with no thread, the line goes to a new thread in the project the agent's own door names", async () => {
    const w = world();
    await w.call({ capability: "board", on: true, project_path: "/work/api" });
    expect(w.lines).toEqual([{ thread: null, project: "prj:/work/api", body: "Turned on Board.", by: "Claude Code" }]);
  });

  test("with no thread and no project there is nowhere to post: the result says so", async () => {
    const w = world();
    const turned = await w.call({ capability: "board", on: true, project_path: undefined });
    expect(turned.content[0]!.text).toStartWith("Turned on Board on this computer. There was no thread to post a line for the person in");
    expect(w.lines).toEqual([]);
  });

  test("a linked computer's switch turns there, not here, and its line names it", async () => {
    const w = world({ far: "online" });
    expect((await w.call({ computer: "Studio" })).content[0]!.text).toBe("On Studio: board on, routines off.");
    const turned = await w.call({ capability: "routines", on: true, computer: "studio" });
    expect(turned.content[0]!.text).toBe("Turned on Routines on Studio. The person sees it in thread msg_new.");
    expect([w.there.scheduled_threads, w.here.scheduled_threads]).toEqual([{ on: true }, { on: false }]);
    expect(w.lines.map((line) => line.body)).toEqual(["Turned on Routines on Studio."]);
    expect((await w.call({ capability: "board", on: true, computer: "Studio" })).content[0]!.text).toBe("Board was already on (Studio). Nothing changed.");
    expect(w.lines).toHaveLength(1);
  });

  test("a linked computer that is away holds the turn: the result and the line say it applies when it is back", async () => {
    const w = world({ far: "away" });
    const held = await w.call({ capability: "board", on: false, computer: "Studio", thread_id: "msg_work" });
    expect(held.content[0]!.text).toBe("Asked Studio to turn Board off. Waiting for Studio: this applies when Studio is back. The person sees it in thread msg_work.");
    expect(w.turns).toEqual(["Studio board false (held)"]);
    expect(w.lines.map((line) => line.body)).toEqual(["Turned off Board on Studio. It applies when Studio is back."]);
    // Taken when it is back: nothing more is said.
    w.settle({ taken: true, why: null });
    await Bun.sleep(0);
    expect(w.lines).toHaveLength(1);
  });

  test("a held turn that computer refuses when it is back: one more line, in the same thread", async () => {
    const w = world({ far: "away" });
    await w.call({ capability: "routines", on: true, computer: "Studio" });
    w.settle({ taken: false, why: "Routines are not offered on this computer." });
    await Bun.sleep(0);
    expect(w.lines.map((line) => [line.thread, line.body])).toEqual([
      [null, "Turned on Routines on Studio. It applies when Studio is back."],
      ["msg_new", "Studio did not turn on Routines: Routines are not offered on this computer."],
    ]);
  });

  test("away, its switches are as it last said: listed as such, and never taken as current for a turn", async () => {
    const w = world({ far: "last-said" });
    const listed = await w.call({ computer: "Studio" });
    expect(listed.content[0]!.text).toBe("On Studio: board on, routines off. Studio is away: these are as it last said, at 2026-11-24T14:10:00.000Z.");
    expect(listed.structuredContent).toMatchObject({ away: true, read_at: "2026-11-24T14:10:00.000Z" });
    // Board on, as it last said: not "already on"; the turn is held for it.
    const turned = await w.call({ capability: "board", on: true, computer: "Studio", thread_id: "msg_work" });
    expect(turned.content[0]!.text).toBe("Asked Studio to turn Board on. Waiting for Studio: this applies when Studio is back. The person sees it in thread msg_work.");
    expect(w.turns).toEqual(["Studio board true (held)"]);
  });

  test("an older linked computer, or a name that matches none, changes nothing and says why", async () => {
    const older = world({ far: "older" });
    const refused = await older.call({ capability: "routines", on: true, computer: "Studio" });
    expect([refused.isError, refused.content[0]!.text]).toEqual([true, "machine_needs_update: Update Plannotator on Studio: its capabilities cannot be turned from another computer yet. Nothing changed."]);
    const unknown = await older.call({ capability: "routines", on: true, computer: "Mini" });
    expect(unknown.content[0]!.text).toBe("machine_not_found: No linked computer is named Mini. Linked: Studio. Leave computer out for this computer.");
    expect([older.turns, older.lines]).toEqual([[], []]);
  });

  test("where Routines are not offered (Windows), a routine call is not told a switch turns them on", () => {
    expect(inboxScheduledOffText(true)).toContain("with the capability action");
    expect(inboxScheduledOffText(false)).toBe("routines_off: Routines are not offered on this computer, so nothing was written.");
  });

  test("the person's line: which way, which capability, and the computer only when it is not this one", () => {
    expect(capabilityLineText("Checklist", false, null, false)).toBe("Turned off Checklist.");
    expect(capabilityLineText("Routines", true, "Studio", false)).toBe("Turned on Routines on Studio.");
  });
});
