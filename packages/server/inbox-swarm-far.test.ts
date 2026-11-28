/**
 * Swarm across linked computers, on the asking computer's side (inbox-swarm-far.ts) and the thread's (the door's
 * `POST swarm`, `farSwarmAnswer`). Two stores in temp folders stand for the two computers; the outbox between them is
 * a stand-in that holds a write until the test says the computer is back. No Inbox, no network.
 *
 * The failures these guard: a `say` to an away computer refused instead of held; a held `say` written twice when
 * its answer was lost and it was sent again; a far join forgotten after the asking Inbox restarts, so `say` without
 * `--thread` fails there; a far member handed a ghost message as the person's reply.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { SWARM_WORDS, joinSwarm, saySwarm, startSwarm } from "@plannotator/shared/inbox/swarm";
import { farWakeCommand } from "./inbox-far-wakes";
import { createInboxFarTags } from "./inbox-far-tags";
import { FAR_REPLY_WORDS } from "./inbox-mcp-far-reply";
import type { OutboxEntry } from "./inbox-outbox";
import { createSwarmFarJoins, holdSwarmSay } from "./inbox-swarm-far";
import { farSwarmAnswer, swarmRoute, type SwarmRouteContext } from "./inbox-swarm-route";
import { swarmWakeOf } from "./inbox-swarm-wake";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MACHINE_A = "ibx_01KAZ00000000000000000000A";
const MACHINE_B = "ibx_01KAZ00000000000000000000B";
const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_claude", name: "Claude Code" };
const FAR_PI = { host: "pi", session: "ses_far_pi", name: "Pi" };

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-swarm-far-"));
  roots.push(dir);
  return dir;
};

/** The thread's computer (A): a swarm with this computer's Claude Code in it. */
function threadComputer() {
  const store = InboxStore.open(temp(), { now: () => new Date() });
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: "Per-berth pricing.", subject: "Pricing" }).message.id;
  startSwarm(store, thread);
  joinSwarm(store, thread, { session: AGENT.session, host: "claude-code", name: null });
  const ctx: SwarmRouteContext = { store, on: () => true, live: () => null, ownSession: (s) => s === AGENT.session };
  return { store, thread, ctx };
}

/**
 * The asking computer (B), its data in `dir`: the thread's computer reached through `door` while `online()`, its
 * held writes kept in `held` until `flush` sends them (as many times as asked: a lost answer is sent again).
 */
function askingComputer(dir: string, a: ReturnType<typeof threadComputer>, online: () => boolean) {
  const store = InboxStore.open(dir, { now: () => new Date() });
  const held: { key: string; body: Record<string, unknown> }[] = [];
  const door = (body: Record<string, unknown>) => {
    try {
      return { status: 200, json: farSwarmAnswer(a.ctx, MACHINE_B, body) };
    } catch (error) {
      return { status: 409, json: { code: (error as { code?: string }).code ?? "error", error: String(error) } };
    }
  };
  const entry = (key: string, body: Record<string, unknown>, state: OutboxEntry["state"], answer: unknown): OutboxEntry =>
    ({ v: 1, key, machine: MACHINE_A, route: "swarm", body, n: 1, queued_at: "", state, left: state !== "queued", errors: 0, status: state === "delivered" ? 200 : null, answer, settled_at: null, notice: null, dismissed: false }) as OutboxEntry;
  const asked: Record<string, unknown>[] = [];
  const ctx: SwarmRouteContext = {
    store,
    on: () => true,
    live: () => null,
    far: {
      placeOf: async (ref) => (ref === a.thread ? { machine: MACHINE_A, thread_id: a.thread } : null),
      nameOf: () => "Studio",
      ask: async (_machine, body) => {
        asked.push(body);
        if (!online()) return { status: 409, json: { code: "machine_offline", error: "Studio cannot be reached now." } };
        return door(body);
      },
      joins: createSwarmFarJoins(store.dir),
      holdSay: (machine, thread, body) =>
        holdSwarmSay(
          async (_m, b) => {
            const key = String(b.idempotency_key);
            if (!online()) {
              held.push({ key, body: b });
              return entry(key, b, "queued", null);
            }
            const answer = door(b);
            return entry(key, b, answer.status === 200 ? "delivered" : "refused", answer.json);
          },
          () => {},
          machine,
          thread,
          body,
        ),
    },
  };
  const flush = (times = 1) => {
    for (const write of held.splice(0)) for (let i = 0; i < times; i++) door(write.body);
  };
  return { store, ctx, held, flush, asked };
}

const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
const run = async (ctx: SwarmRouteContext, body: unknown) => {
  const req = new Request("http://127.0.0.1:1/api/inbox/swarm", { method: "POST", headers: { "Content-Type": "application/json", Host: "127.0.0.1:1" }, body: JSON.stringify(body) });
  const res = (await swarmRoute(req, new URL(req.url), ctx, readBody))!;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

test("a far say while the thread's computer is away waits, and is written once when it is back, a resend included", async () => {
  const a = threadComputer();
  let online = true;
  const b = askingComputer(temp(), a, () => online);
  expect((await run(b.ctx, { action: "join", thread: a.thread, by: FAR_PI })).status).toBe(200);
  online = false;
  const said = await run(b.ctx, { action: "say", text: "Schema is in; who takes the endpoint?", by: FAR_PI });
  expect(said.status).toBe(200);
  expect(said.json.text).toBe(FAR_REPLY_WORDS.held(a.thread, "Studio"));
  expect(said.json.held).toBe(true);
  const ghost = a.store.swarmOf(a.thread)!.ghost_id!;
  expect(a.store.ghostMessages(ghost)).toEqual([]);
  // Back: the outbox sends it, and sends it again (its first answer was lost). One message, for the other member.
  online = true;
  b.flush(2);
  const words = a.store.ghostMessages(ghost);
  expect(words.map((m) => m.body)).toEqual(["Schema is in; who takes the endpoint?"]);
  expect(a.store.pendingReplies(AGENT.session, { tags: true }).map((m) => m.id)).toEqual([words[0]!.id]);
  // Online, a say is answered at once with the thread's computer's own words.
  const now = await run(b.ctx, { action: "say", text: "Taking it.", by: FAR_PI });
  expect(now.json.text).toBe(SWARM_WORDS.said("everyone"));
  expect(a.store.ghostMessages(ghost)).toHaveLength(2);
});

test("a far join survives the asking Inbox's restart: say, doing and leave need no --thread", async () => {
  const a = threadComputer();
  const dir = temp();
  const b = askingComputer(dir, a, () => true);
  expect((await run(b.ctx, { action: "join", thread: a.thread, by: FAR_PI })).status).toBe(200);
  // A restart: the store opened again on the same data, and a new context.
  const again = askingComputer(dir, a, () => true);
  const said = await run(again.ctx, { action: "say", text: "Still here after a restart.", by: FAR_PI });
  expect(said.status).toBe(200);
  expect(a.store.ghostMessages(a.store.swarmOf(a.thread)!.ghost_id!).map((m) => m.body)).toEqual(["Still here after a restart."]);
  expect((await run(again.ctx, { action: "doing", text: "the endpoint", by: FAR_PI })).status).toBe(200);
  expect((await run(again.ctx, { action: "leave", by: FAR_PI })).status).toBe(200);
  // Left: forgotten, after another restart too.
  const third = askingComputer(dir, a, () => true);
  expect((await run(third.ctx, { action: "say", text: "Gone?", by: FAR_PI })).json.code).toBe("not_in_swarm");
});

test("a far member is handed a ghost message once, as a notice its computer keeps", () => {
  const a = threadComputer();
  joinSwarm(a.store, a.thread, { session: FAR_PI.session, host: "pi", name: null, machine: MACHINE_B, machine_name: "Mac mini" });
  const writes: { machine: string; body: Record<string, unknown> }[] = [];
  const kept = new Set<string>();
  const tags = createInboxFarTags({
    store: a.store,
    selfId: () => MACHINE_A,
    selfName: () => "Studio",
    peers: () => [],
    nameOf: () => "Mac mini",
    holdWrite: (machine, _route, body) => {
      writes.push({ machine, body });
      kept.add(String(body.idempotency_key));
      return null;
    },
    heldWrite: (key) => (kept.has(key) ? ({ key } as OutboxEntry) : null),
    commandFor: (reply, session, now) => swarmWakeOf(a.store, reply, { type: "reply", id: reply.id, thread_id: reply.thread_id, reply_to: reply.reply_to, subject: null, body: reply.body, url: "http://x/", ...(now ? { now: true } : {}) }, true),
    sendAs: async () => ({ text: "", structured: {} }),
    ownSession: (s) => s === AGENT.session,
  });
  const said = saySwarm(a.store, a.thread, { session: AGENT.session, host: "claude-code", name: null }, "Pi: take the tests?").message;
  tags.onPersonMessage(said);
  tags.onPersonMessage(said);
  expect(writes.map((w) => [w.machine, w.body.session])).toEqual([[MACHINE_B, FAR_PI.session]]);
  // The far computer keeps it as a notice, never the person's reply.
  const command = farWakeCommand(writes[0]!.body.command, { reply_id: said.id, thread_id: said.thread_id }, "http://b/");
  expect(command).toMatchObject({ moved: true, notice: SWARM_WORDS.wake("Claude Code"), body: "Pi: take the tests?" });
});

test("a linked computer cannot act as a session that is not its own: a local member, another computer's, or one known elsewhere", () => {
  const a = threadComputer();
  // This computer's member, its session no longer live here (ownSession no longer names it).
  const ctx: SwarmRouteContext = { ...a.ctx, ownSession: () => false };
  const MACHINE_C = "ibx_01KAZ00000000000000000000C";
  joinSwarm(a.store, a.thread, { session: "ses_far_c", host: "codex", name: null, machine: MACHINE_C, machine_name: "Laptop" });
  // A session a message here puts on computer C, never joined.
  a.store.sendReply(a.thread, { idempotency_key: "k-tag-c", words: "Codex, look.", tags: [{ host: "codex", session: "ses_tagged_c", name: "Codex", wakes: true, machine: MACHINE_C }] });
  expect(a.store.sessionMachine("ses_tagged_c")).toBe(MACHINE_C);
  const before = JSON.stringify(a.store.swarmOf(a.thread));
  for (const session of [AGENT.session, "ses_far_c", "ses_tagged_c"]) {
    for (const ask of [{ action: "join", thread: a.thread, as: "Mallory" }, { action: "say", thread: a.thread, text: "Stop." }, { action: "doing", thread: a.thread, text: "x" }, { action: "leave", thread: a.thread }]) {
      expect(() => farSwarmAnswer(ctx, MACHINE_B, { ask, session, host: "pi" })).toThrow(expect.objectContaining({ code: "not_your_session" }));
    }
  }
  expect(JSON.stringify(a.store.swarmOf(a.thread))).toBe(before);
  expect(a.store.ghostMessages(a.store.swarmOf(a.thread)!.ghost_id!)).toEqual([]);
  // Its own session joins as before.
  expect(farSwarmAnswer(ctx, MACHINE_B, { ask: { action: "join", thread: a.thread }, session: FAR_PI.session, host: "pi" }).thread_id).toBe(a.thread);
});

test("a linked computer cannot act as a session a thread here is addressed to with no machine, though it is not live, never wrote and has not joined", () => {
  const a = threadComputer();
  // After a restart: nothing is live here, and these sessions never wrote and are not members.
  const ctx: SwarmRouteContext = { ...a.ctx, ownSession: () => false };
  const project = a.store.message(a.thread)!.project_id;
  a.store.startPersonThread({
    project_id: project,
    body: "Pricing tests.",
    idempotency_key: "k-to-here",
    to: { host: "claude-code", session: "ses_to_here" },
    tags: [{ host: "codex", session: "ses_tag_here", wakes: true }, { host: "pi", session: "ses_tag_b", wakes: true, machine: MACHINE_B }],
  });
  expect(a.store.sessionMachine("ses_to_here")).toBeNull();
  const before = JSON.stringify(a.store.swarmOf(a.thread));
  for (const session of ["ses_to_here", "ses_tag_here"]) {
    expect(() => farSwarmAnswer(ctx, MACHINE_B, { ask: { action: "join", thread: a.thread }, session, host: "pi" })).toThrow(expect.objectContaining({ code: "not_your_session" }));
  }
  expect(JSON.stringify(a.store.swarmOf(a.thread))).toBe(before);
  // The calling computer's session, named there with its machine, joins.
  expect(farSwarmAnswer(ctx, MACHINE_B, { ask: { action: "join", thread: a.thread }, session: "ses_tag_b", host: "pi" }).thread_id).toBe(a.thread);
});
