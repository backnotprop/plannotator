/**
 * `plannotator inbox capability` on the Inbox's side (inbox-capability-agent.ts) against a stand-in context: no Inbox
 * runs. What regresses: a turn not taking; the person's line posted twice, posted for a turn that changed nothing, or
 * not said when it had nowhere to go; the result saying a turn was this computer's only (every linked computer takes
 * it); a `computer` (gone with the one set) still taken; the route taking a field it should refuse; a paired cloud agent's turn
 * through the door not named as that agent, or naming someone else; the answer naming a switch by a name the command
 * does not take; the route answering another site's page or a request through a device door.
 */
import { describe, expect, test } from "bun:test";
import type { InboxCapabilitySwitches, InboxCapabilitySwitchKey } from "@plannotator/core/inbox-types";
import { capabilityAskOf, capabilityLineText, capabilityRoute, type InboxCapabilityContext } from "./inbox-capability-agent";
import { inboxAgentRouteAction } from "./inbox-agent-routes";

type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

function world() {
  const here: InboxCapabilitySwitches = { board: { on: false }, steps: { on: false }, scheduled_threads: { on: false }, bro: { on: false } };
  const lines: { thread: string | null; project: string | null; body: string; by: string }[] = [];
  const turns: string[] = [];
  const context: InboxCapabilityContext = {
    // The project an agent's path names: the line lands in it.
    resolveProject: async (path) => ({ id: `prj:${path}` }),
    here: () => structuredClone(here),
    set: async (key: InboxCapabilitySwitchKey, on: boolean) => {
      turns.push(`here ${key} ${on}`);
      here[key] = { on };
      return structuredClone(here);
    },
    tell: async (by, thread, projectOf, body) => {
      const project = thread ? null : await projectOf();
      if (!thread && !project) return null;
      lines.push({ thread, project, body, by: by.name });
      return thread ?? "msg_new";
    },
  };
  // As the route answers the command: `{ text, ...structured }`, or a refusal `<code>: <message>`.
  const call = async (args: Record<string, unknown>): Promise<Result> => {
    const response = await capabilityRoute(new Request("http://127.0.0.1/api/inbox/capability", { method: "POST", body: JSON.stringify({ by: { session: "ses_ada", host: "claude-code", name: "Claude Code" }, project_path: "/work/api", ...args }) }), new URL("http://127.0.0.1/api/inbox/capability"), context, (req) => req.json());
    const { text, code, error, ...structured } = (await response!.json()) as Record<string, unknown>;
    return response!.ok ? { content: [{ text: text as string }], structuredContent: structured } : { isError: true, content: [{ text: `${code}: ${error}` }] };
  };
  return { here, lines, turns, context, call };
}

const SHELL_NOW = "Agents get the routine action in their next session (a session's tools are listed once, at its start); from a shell it works now: `plannotator routine --help`.";

describe("plannotator inbox capability, on the Inbox's side", () => {
  test("turns one on here: one line for the person, in the thread named", async () => {
    const w = world();
    const turned = await w.call({ capability: "routines", on: true, thread_id: "msg_work" });
    expect(turned.isError).toBeFalsy();
    // This session's tools were listed with Routines off: the result says where the action is, and what works now.
    expect(turned.content[0]!.text).toBe(`Turned on Routines. The person sees it in thread msg_work. ${SHELL_NOW}`);
    expect(w.here.scheduled_threads).toEqual({ on: true });
    expect(w.lines).toEqual([{ thread: "msg_work", project: null, body: "Turned on Routines.", by: "Claude Code" }]);
    // The same turn again changes nothing and posts nothing, and still says why this session may have no routine action.
    const again = await w.call({ capability: "routines", on: true, thread_id: "msg_work" });
    expect(again.content[0]!.text).toBe(`Routines was already on (this computer). Nothing changed. ${SHELL_NOW}`);
    expect([w.lines.length, w.turns]).toEqual([1, ["here scheduled_threads true"]]);
    // A switch that serves no action, or a turn off, says nothing of a next session.
    expect((await w.call({ capability: "bro_mode", on: true })).content[0]!.text).toBe("Turned on Bro mode. The person sees it in thread msg_new.");
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
    const turned = await w.call({ capability: "board", on: true, project_path: undefined, by: { session: "ses_ada", host: "claude-code", name: "Claude Code" } });
    expect(turned.content[0]!.text).toStartWith("Turned on Board. There was no thread to post a line for the person in");
    expect(w.lines).toEqual([]);
  });

  test("`computer` is not taken: refused, nothing turns and nothing is told", async () => {
    const w = world();
    const refused = await w.call({ capability: "routines", on: true, computer: "Studio", thread_id: "msg_work" });
    expect([refused.isError, refused.content[0]!.text]).toEqual([true, "validation_error: computer: not taken here."]);
    expect([w.turns, w.lines]).toEqual([[], []]);
  });

  test("the person's line: which way, which capability", () => {
    expect(capabilityLineText("Checklist", false)).toBe("Turned off Checklist.");
    expect(capabilityLineText("Routines", true)).toBe("Turned on Routines.");
  });

  test("the route refuses a field it does not take, and a capability or a state an agent cannot name", () => {
    expect(() => capabilityAskOf({ capability: "routines", on: true, force: true })).toThrow("force: not taken here.");
    expect(() => capabilityAskOf({ capability: "system", on: true })).toThrow("capability: one of");
    expect(() => capabilityAskOf({ capability: "routines", on: "yes" })).toThrow("on: true or false.");
  });

  test("every name the answer prints is one the command takes back", async () => {
    const w = world();
    const listed = await w.call({});
    const here = Object.keys(listed.structuredContent!.capabilities as object);
    expect(here).toEqual(["board", "checklist", "routines", "bro_mode"]);
    for (const name of here) expect([name, (await w.call({ capability: name, on: true })).isError ?? false]).toEqual([name, false]);
  });

  test("a list by GET", async () => {
    const w = world();
    const get = async (query: string) => (await (await capabilityRoute(new Request(`http://127.0.0.1/api/inbox/capability${query}`), new URL(`http://127.0.0.1/api/inbox/capability${query}`), w.context, async () => ({})))!.json()) as Record<string, unknown>;
    expect((await get("")).text).toBe("On this computer: board off, checklist off, routines off, bro_mode off.");
    expect(w.turns).toEqual([]);
  });
});

describe("the route is this computer's agents' own", () => {
  const ask = (init: { method?: string; headers?: Record<string, string>; body?: string }, query = "") =>
    new Request(`http://127.0.0.1:41000/api/inbox/capability${query}`, { ...init, headers: { Host: "127.0.0.1:41000", ...init.headers } });
  const turn = JSON.stringify({ capability: "routines", on: true, thread_id: "msg_work" });
  const answer = async (req: Request, w: ReturnType<typeof world>, fromDeviceDoor = false) => {
    const response = (await capabilityRoute(req, new URL(req.url), w.context, (r) => r.json(), fromDeviceDoor))!;
    return [response.status, ((await response.json()) as { code?: string }).code];
  };

  test("another site's page is refused, a read and a write: nothing turns and nothing is told", async () => {
    const w = world();
    for (const headers of [{ Origin: "https://elsewhere.example" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "http://127.0.0.1:41000", "Sec-Fetch-Site": "same-site" }, { Origin: "null" }]) {
      expect(await answer(ask({ headers }), w)).toEqual([403, "cross_origin"]);
      expect(await answer(ask({ method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: turn }), w)).toEqual([403, "cross_origin"]);
    }
    expect([w.turns, w.lines, w.here.scheduled_threads]).toEqual([[], [], { on: false }]);
    // The agent's own command (no browser origin), and the window's own page, are answered.
    expect(await answer(ask({ method: "POST", body: turn }), w)).toEqual([200, undefined]);
    expect(await answer(ask({ headers: { Origin: "http://127.0.0.1:41000" } }), w)).toEqual([200, undefined]);
  });

  test("through a device door (a phone, a linked computer) it is not found, a read or a write: nothing turns and nothing is told", async () => {
    const w = world();
    expect(await answer(ask({}), w, true)).toEqual([404, "not_found"]);
    expect(await answer(ask({ method: "POST", body: turn }), w, true)).toEqual([404, "not_found"]);
    expect([w.turns, w.lines]).toEqual([[], []]);
  });
});

describe("a paired cloud agent's turn, through the agent door's route", () => {
  const handled = () => {
    const seen: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
    const handle = async (req: Request) => {
      seen.push({ method: req.method, path: new URL(req.url).pathname + new URL(req.url).search, body: req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : null });
      return Response.json({ text: "ok" });
    };
    return { seen, handle };
  };
  const by = { host: "codex-cloud", session: "ses_cloud", name: "Codex Cloud", project: () => "prj_cloud" };

  test("the turn is the pairing's agent's, in its own project: what the agent sent cannot name another", async () => {
    const door = handled();
    await inboxAgentRouteAction(door.handle, by, "route", { method: "POST", path: "/api/inbox/capability", body: { capability: "routines", on: true, thread_id: "msg_1" } });
    expect(door.seen).toEqual([{ method: "POST", path: "/api/inbox/capability", body: { capability: "routines", on: true, thread_id: "msg_1", by: { host: "codex-cloud", session: "ses_cloud", name: "Codex Cloud" }, project_id: "prj_cloud" } }]);
    for (const field of ["by", "project_path", "project_id", "computer"]) {
      await expect(inboxAgentRouteAction(door.handle, by, "route", { method: "POST", path: "/api/inbox/capability", body: { capability: "routines", on: true, [field]: "x" } })).rejects.toThrow(`body: ${field}: not taken here`);
    }
    expect(door.seen).toHaveLength(1);
  });

  test("a list goes as a read", async () => {
    const door = handled();
    await inboxAgentRouteAction(door.handle, by, "route", { method: "GET", path: "/api/inbox/capability" });
    expect(door.seen.map((one) => [one.method, one.path])).toEqual([["GET", "/api/inbox/capability"]]);
    // A computer named in the read (gone with the one set) is not carried.
    await expect(inboxAgentRouteAction(door.handle, by, "route", { method: "GET", path: "/api/inbox/capability?computer=Studio" })).rejects.toThrow("method, path:");
    expect(door.seen).toHaveLength(1);
  });
});
