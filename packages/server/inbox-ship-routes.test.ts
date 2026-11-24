/**
 * Ship's routes (inbox-ship-routes.ts) on their own, with the store and watch real (a temp data dir) and the rest of the
 * Inbox stood in for. What regresses here breaks Ship across computers:
 *  - a ships read that does not say the computer's projects by repository (a linked machine's window then lists none
 *    of this computer's agents in Ship's list);
 *  - a ship started in a thread a linked machine's window just started here (`started`) that names no agent until the
 *    agent answers (the watch's wakes would then go to nobody);
 *  - a pull request nobody here can read still shipping (its watch would read nothing, forever).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { createInboxShipRoutes } from "./inbox-ship-routes";
import { createInboxShipStore } from "./inbox-ship-store";
import { createInboxShipWatch } from "./inbox-ship-watch";

const KEY = "github.com/harbor/fern-api#614";
const PULL = { key: KEY, platform: "github", url: "https://github.com/harbor/fern-api/pull/614", title: "Send a receipt after checkout", number: 614, repo: "harbor/fern-api", host: "github.com", state: "open", head: "receipts", base: "main", head_repo: "harbor/fern-api", mine: true, author: "charlie-dunn" } as InboxPull;

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function world(over: { findPull?: (key: string) => Promise<InboxPull | null>; threadAgent?: () => null | { host: string; session: string; name: string } } = {}) {
  const ships = createInboxShipStore(mkdtempSync(join(tmpdir(), "ship-routes-")));
  const watch = createInboxShipWatch({ ships, read: async () => null, note: () => {}, everyMs: 60 * 60_000 });
  closers.push(() => watch.close());
  const sent: unknown[] = [];
  const from: { machine: { id: string; name: string | null } | null } = { machine: null };
  const routes = createInboxShipRoutes({
    ships,
    watch,
    serverSession: "s1",
    json: (body, status = 200) => Response.json(body, { status }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    findPull: over.findPull ?? (async (key) => (key === KEY ? PULL : null)),
    threadProject: (threadId) => (threadId === "msg_thread" ? "prj_fern" : null),
    threadAgent: over.threadAgent ?? (() => null),
    repoProjects: async () => ({ "github.com/harbor/fern-api": ["prj_fern"] }),
    sendInstruction: async (input) => {
      sent.push(input);
      return { agent: { host: "claude-code", session: "ses_1", name: "Claude Code" }, message_id: "msg_ship" };
    },
    fromMachine: () => from.machine,
    guard: () => null,
  });
  const call = (method: "GET" | "POST", path: string, body?: unknown) =>
    routes(new Request(`http://127.0.0.1${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), path.split("?")[0]!, new URL(`http://127.0.0.1${path}`)).then((r) => r!);
  return { ships, sent, call, from };
}

test("a ships read says this computer's projects by repository, beside its ships", async () => {
  const w = world();
  const answer = (await (await w.call("GET", "/api/inbox/ships")).json()) as { ships: unknown[]; projects: Record<string, string[]> };
  expect(answer.ships).toEqual([]);
  expect(answer.projects).toEqual({ "github.com/harbor/fern-api": ["prj_fern"] });
});

test("a ship in a thread the window just started here ships with the live session it started it with, until the thread names its agent", async () => {
  const w = world();
  const res = await w.call("POST", "/api/inbox/ships", { key: KEY, thread_id: "msg_thread", started: true, to: { host: "codex", session: "ses_far" }, idempotency_key: "k1" });
  expect(res.status).toBe(200);
  expect(w.ships.get(KEY)!.agent).toEqual({ host: "codex", session: "ses_far", name: null });
  // Nothing was sent: the window's new thread carried the instruction.
  expect(w.sent).toEqual([]);
});

test("the session the window started the thread with ships it, never another agent that wrote in the thread since", async () => {
  const w = world({ threadAgent: () => ({ host: "codex", session: "ses_reviewer", name: "Codex" }) });
  await w.call("POST", "/api/inbox/ships", { key: KEY, thread_id: "msg_thread", started: true, to: { host: "codex", session: "ses_far" }, idempotency_key: "k1" });
  expect(w.ships.get(KEY)!.agent.session).toBe("ses_far");
  expect(w.ships.get(KEY)!.instruction_id).toBe("msg_thread");
});

test("a Ship in this thread records the session the instruction went to and the message that carried it", async () => {
  const w = world({ threadAgent: () => ({ host: "codex", session: "ses_reviewer", name: "Codex" }) });
  await w.call("POST", "/api/inbox/ships", { key: KEY, thread_id: "msg_thread", to: { host: "claude-code", session: "ses_1" }, idempotency_key: "k1" });
  expect(w.ships.get(KEY)!.agent.session).toBe("ses_1");
  expect(w.ships.get(KEY)!.instruction_id).toBe("msg_ship");
  expect(w.ships.get(KEY)!.platform).toBe("github");
});

test("a linked computer's word of a newer ship stops the older one here; a window's call is refused", async () => {
  const w = world();
  await w.call("POST", "/api/inbox/ships", { key: KEY, thread_id: "msg_thread", to: { host: "claude-code", session: "ses_1" }, idempotency_key: "k1" });
  // Pressed on the Mac mini after it heard of this one; its clock is a few minutes behind, which decides nothing.
  const earlier = new Date(Date.now() - 3 * 60_000).toISOString();
  expect((await w.call("POST", "/api/inbox/ships/newer", { key: KEY, id: "shp_far", started_at: earlier, generation: 2 })).status).toBe(403);
  expect(w.ships.get(KEY)!.state).toBe("shipping");
  w.from.machine = { id: "ibx_mini", name: "Mac mini" };
  // Fields checked: a date, and a whole generation.
  await expect(w.call("POST", "/api/inbox/ships/newer", { key: KEY, id: "shp_far", started_at: "soon", generation: 2 })).rejects.toMatchObject({ code: "validation_error", details: { field: "started_at" } });
  await expect(w.call("POST", "/api/inbox/ships/newer", { key: KEY, id: "shp_far", started_at: earlier, generation: 2.5 })).rejects.toMatchObject({ code: "validation_error", details: { field: "generation" } });
  await expect(w.call("POST", "/api/inbox/ships/newer", { key: KEY, id: "shp_far", started_at: earlier })).rejects.toMatchObject({ code: "validation_error", details: { field: "generation" } });
  expect(w.ships.get(KEY)!.state).toBe("shipping");
  const res = await w.call("POST", "/api/inbox/ships/newer", { key: KEY, id: "shp_far", started_at: earlier, generation: 2 });
  expect(res.status).toBe(200);
  expect(w.ships.get(KEY)!.state).toBe("stopped");
  expect(w.ships.get(KEY)!.log.at(-1)!.text).toBe("Stopped: shipping on Mac mini");
});

test("a pull request this computer can neither list nor read is refused, and nothing is sent", async () => {
  const w = world({ findPull: async () => null });
  await expect(w.call("POST", "/api/inbox/ships", { key: KEY, thread_id: "msg_thread", to: { host: "codex", session: "ses_far" }, idempotency_key: "k1" })).rejects.toMatchObject({ code: "pull_not_found" });
  expect(w.sent).toEqual([]);
  expect(w.ships.get(KEY)).toBeNull();
});
