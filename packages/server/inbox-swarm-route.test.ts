/**
 * `POST /api/inbox/swarm` (`plannotator inbox swarm`), the door's `POST swarm` for a linked computer's agent, the
 * window's `threads/:id/swarm`, and what a member is handed. The failures these guard: another site's page or a
 * device door (a phone, a linked computer's window) reaching the agents' route; the route answering while the switch
 * is off; a linked computer speaking for one of this computer's sessions; a ghost message worded as the person's
 * reply; and a swarm's first message handed without its join line.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { composeInboxSkillsBlock, inboxBuiltinSkillContent } from "@plannotator/core/inbox-skills-compose";
import { INBOX_MESSAGE_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import type { SkillCatalogEntry } from "@plannotator/core/skill-references-render";
import { SWARM_SKILL, swarmJoinLine } from "@plannotator/core/swarm-skill";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { SWARM_NAME_MAX, SWARM_WORDS, joinSwarm, saySwarm, startSwarm } from "@plannotator/shared/inbox/swarm";
import { farSwarmAnswer, swarmRoute, swarmWindowRoute, type SwarmRouteContext } from "./inbox-swarm-route";
import { swarmWakeOf } from "./inbox-swarm-wake";
import { createInboxFarTags } from "./inbox-far-tags";
import type { InboxMessage } from "@plannotator/core/inbox-types";

/** The block the window composes for `/swarm` (its text pasted, as a human-only built-in). */
const SWARM_REF = { name: SWARM_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true } as SkillCatalogEntry;
const SWARM_BLOCK = composeInboxSkillsBlock([SWARM_REF], new Map([[SWARM_SKILL.name, inboxBuiltinSkillContent(SWARM_REF, false)!]]), INBOX_MESSAGE_SKILL_AUDIENCE);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(on = true) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-swarm-route-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date() });
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  const thread = store.startPersonThread({
    project_id: project.id,
    body: `Add per-berth pricing. /swarm\n\n${SWARM_BLOCK}`,
    idempotency_key: "k1",
    to: { host: "claude-code", session: "ses_claude" },
    tags: [{ host: "codex", session: "ses_codex", wakes: true }],
  }).message;
  const state = { on };
  const ctx: SwarmRouteContext = { store, on: () => state.on, live: () => null, ownSession: (s) => s === "ses_claude", serverSession: "srv_page" };
  return { store, thread: thread.id, ctx, state, project };
}

const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
const post = (body: unknown, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:1/api/inbox/swarm", { method: "POST", headers: { "Content-Type": "application/json", Host: "127.0.0.1:1", ...headers }, body: JSON.stringify(body) });
const ask = async (ctx: SwarmRouteContext, body: unknown, headers?: Record<string, string>, door = false) => {
  const req = post(body, headers);
  const res = (await swarmRoute(req, new URL(req.url), ctx, readBody, door))!;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const CLAUDE = { host: "claude-code", session: "ses_claude", name: "Claude Code" };
const CODEX = { host: "codex", session: "ses_codex", name: "Codex" };

test("another site's page, a device door, and a switched-off Inbox never reach the agents' route", async () => {
  const { ctx, thread, state } = world();
  startSwarm(ctx.store, thread);
  expect((await ask(ctx, { action: "join", thread, by: CLAUDE }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await ask(ctx, { action: "join", thread, by: CLAUDE }, {}, true)).status).toBe(404);
  state.on = false;
  const off = await ask(ctx, { action: "join", thread, by: CLAUDE });
  expect(off.status).toBe(409);
  expect(off.json.code).toBe("swarm_off");
  expect(ctx.store.swarmOf(thread)!.members).toEqual([]);
});

test("join, say, doing, status and leave through the route; an unknown field or action is refused", async () => {
  const { ctx, thread, store } = world();
  startSwarm(store, thread);
  const joined = await ask(ctx, { action: "join", thread, by: CLAUDE });
  expect(joined.status).toBe(200);
  expect(joined.json.text).toContain(`Joined the swarm of thread ${thread} as Claude Code.`);
  // Codex is named by the thread and not joined yet.
  expect(joined.json.text).toContain("- Codex, on the thread's computer, not joined yet");
  expect((await ask(ctx, { action: "join", thread, by: CLAUDE })).json.text).toContain("Already in the swarm");
  await ask(ctx, { action: "join", thread: store.swarmOf(thread)!.ghost_id, by: CODEX });
  expect((await ask(ctx, { action: "say", text: "Price endpoint shape?", to: "codex", by: CLAUDE })).json.text).toBe("Said to Codex in the ghost thread.");
  expect(store.pendingReplies("ses_codex").at(-1)!.body).toBe("Price endpoint shape?");
  expect((await ask(ctx, { action: "doing", text: "Berth screen", by: CLAUDE })).json.text).toBe("Your status: Berth screen");
  const status = await ask(ctx, { action: "status", by: CODEX });
  expect(status.json.text).toContain("- Claude Code, on the thread's computer, state not known: Berth screen (just now)");
  expect((await ask(ctx, { action: "leave", by: CODEX })).json.text).toBe(`You left the swarm of thread ${thread}.`);
  expect((await ask(ctx, { action: "say", text: "x", by: CODEX })).json.code).toBe("not_in_swarm");
  expect((await ask(ctx, { action: "take", by: CLAUDE })).status).toBe(422);
  expect((await ask(ctx, { action: "say", text: "x", by: CLAUDE, extra: 1 })).status).toBe(422);
  expect((await ask(ctx, { action: "say", text: "x" })).status).toBe(422);
});

test("a linked computer's agent joins and speaks as its own session only", () => {
  const { ctx, thread, store } = world();
  startSwarm(store, thread);
  const machine = "ibx_01KAZ0000000000000000000PI";
  const answer = farSwarmAnswer(ctx, machine, { ask: { action: "join", thread }, session: "ses_pi", host: "pi", name: null });
  expect(String(answer.text)).toContain("as Pi");
  expect(store.swarmOf(thread)!.members.find((m) => m.session === "ses_pi")!.machine).toBe(machine);
  expect(() => farSwarmAnswer(ctx, machine, { ask: { action: "join", thread }, session: "ses_claude", host: "claude-code" })).toThrow("not one of your computer's");
  expect(() => farSwarmAnswer(ctx, machine, { ask: { action: "join", thread }, session: "bad session\n" })).toThrow("session");
});

test("the window reads the ghost thread, writes as the person, turns the swarm off, and nothing answers while the switch is off", async () => {
  const { ctx, thread, store, state, project } = world();
  startSwarm(store, thread);
  joinSwarm(store, thread, { session: "ses_claude", host: "claude-code", name: null });
  const call = async (method: "GET" | "POST", body?: unknown) => {
    const req = new Request(`http://127.0.0.1:1/api/inbox/threads/${thread}/swarm`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const res = (await swarmWindowRoute(req, new URL(req.url), ctx, readBody))!;
    return { status: res.status, json: (await res.json()) as { swarm: { on: boolean } | null; ghost: { body: string; author: { kind: string } }[] } };
  };
  expect((await call("GET")).json.ghost).toEqual([]);
  // As the window sends it: every write carries the page's serverSession (api.ts `post`).
  const said = await call("POST", { say: { text: "Weekend rates are on tab 2." }, serverSession: "srv_page" });
  expect(said.status).toBe(200);
  expect(said.json.ghost.map((m) => [m.author.kind, m.body])).toEqual([["person", "Weekend rates are on tab 2."]]);
  expect((await call("POST", { seen: true, serverSession: "srv_page" })).status).toBe(200);
  // A tab from an earlier run of the Inbox is told so, and nothing is written.
  const stale = await call("POST", { say: { text: "From an old tab." }, serverSession: "srv_old" });
  expect(stale.status).toBe(409);
  expect(store.ghostMessages(store.swarmOf(thread)!.ghost_id!).map((m) => m.body)).toEqual(["Weekend rates are on tab 2."]);
  expect((await call("POST", { on: false })).json.swarm!.on).toBe(false);
  expect((await call("POST", { on: true, serverSession: "srv_page" })).json.swarm!.on).toBe(true);
  expect((await call("POST", { bogus: true })).status).toBe(422);
  // Turn on never makes a swarm of a thread that is not one (a swarm starts from a message that names /swarm).
  const plain = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "pi", session: "ses_pi", name: "Pi" }, body: "Not a swarm.", subject: "Plain" }).message.id;
  const onPlain = await swarmWindowRoute(new Request(`http://127.0.0.1:1/api/inbox/threads/${plain}/swarm`, { method: "POST", body: JSON.stringify({ on: true }) }), new URL(`http://127.0.0.1:1/api/inbox/threads/${plain}/swarm`), ctx, readBody);
  expect(onPlain!.status).toBe(409);
  expect(store.swarmOf(plain)).toBeNull();
  state.on = false;
  expect((await call("GET")).status).toBe(404);
});

test("a ghost message is a notice naming who wrote it; the swarm's first message ends with its join line", () => {
  const { store, thread } = world();
  startSwarm(store, thread);
  joinSwarm(store, thread, { session: "ses_claude", host: "claude-code", name: null });
  joinSwarm(store, thread, { session: "ses_codex", host: "codex", name: null });
  const base = (id: string): InboxReplyCommand => ({ type: "reply", id, thread_id: "x", reply_to: null, subject: "s", body: "b", url: "http://127.0.0.1:1/x" });
  const said = saySwarm(store, thread, { session: "ses_claude", host: "claude-code", name: null }, "Shape?").message;
  const wake = swarmWakeOf(store, said, base(said.id), true);
  expect(wake.moved).toBe(true);
  expect(wake.notice).toStartWith("Claude Code wrote in the swarm's ghost thread.");
  expect(wake.notice!.length).toBeLessThanOrEqual(300);
  expect(wake.body).toBe("Shape?");
  const root = store.message(thread)!;
  expect(swarmWakeOf(store, root, { ...base(root.id), body: root.body }, true).body).toEndWith(swarmJoinLine(thread));
  // Off: nothing changes.
  expect(swarmWakeOf(store, said, base(said.id), false)).toEqual(base(said.id));
});

test("a member with a long name is still named as the agent who wrote, never as the person", () => {
  const { store, thread, ctx } = world();
  startSwarm(store, thread);
  joinSwarm(store, thread, { session: "ses_codex", host: "codex", name: null });
  const long = `Berth pricing ${"x".repeat(66)}`;
  expect(long.length).toBe(80);
  // A linked computer's session, its name as long as the door takes (80).
  const joined = farSwarmAnswer(ctx, "ibx_01KAZ0000000000000000000PI", { ask: { action: "join", thread }, session: "ses_pi", host: "pi", name: long });
  const name = store.swarmOf(thread)!.members.find((m) => m.session === "ses_pi")!.name;
  expect(name).toBe(long.slice(0, SWARM_NAME_MAX));
  expect(String(joined.text)).toContain(`as ${name}.`);
  const said = saySwarm(store, thread, { session: "ses_pi", host: "pi", name: long }, "Tests are green.").message;
  const notice = swarmWakeOf(store, said, { type: "reply", id: said.id, thread_id: "x", reply_to: null, subject: "s", body: "b", url: "http://127.0.0.1:1/x" }, true).notice!;
  expect(notice).toBe(SWARM_WORDS.wake(name));
  expect(notice.length).toBeLessThanOrEqual(300);
  // A name longer still (a record from before the cap) is shortened in the line; `--to` takes the session.
  store.writeSwarm({ ...store.swarmOf(thread)!, members: store.swarmOf(thread)!.members.map((m) => (m.session === "ses_pi" ? { ...m, name: "y".repeat(200) } : m)) });
  const longer = saySwarm(store, thread, { session: "ses_pi", host: "pi", name: null }, "Again.").message;
  const shortened = swarmWakeOf(store, longer, { type: "reply", id: longer.id, thread_id: "x", reply_to: null, subject: "s", body: "b", url: "http://127.0.0.1:1/x" }, true).notice!;
  expect(shortened).not.toBe(SWARM_WORDS.wakePerson);
  expect(shortened.length).toBeLessThanOrEqual(300);
  expect(shortened).toStartWith("yyyy");
  expect(shortened).toContain("--to ses_pi.");
  expect(saySwarm(store, thread, { session: "ses_codex", host: "codex", name: null }, "Thanks.", "ses_pi").to).toBe("y".repeat(200));
});

test("the join line is handed even when the wake is built inside the write that starts the swarm: a held poll and a far member", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-swarm-route-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date() });
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  const FAR = "ibx_01KAZ00000000000000000000B";
  const command = (reply: InboxMessage, now = false): InboxReplyCommand =>
    swarmWakeOf(store, reply, { type: "reply", id: reply.id, thread_id: reply.thread_id, reply_to: reply.reply_to ?? null, subject: null, body: reply.body, url: "http://127.0.0.1:1/x", ...(now ? { now: true } : {}) }, true);
  const farWrites: Record<string, unknown>[] = [];
  const tags = createInboxFarTags({
    store,
    selfId: () => "ibx_01KAZ00000000000000000000A",
    selfName: () => "Studio",
    peers: () => [],
    nameOf: () => "Mac mini",
    holdWrite: (_machine, _route, body) => {
      farWrites.push(body);
      return null;
    },
    heldWrite: () => null,
    commandFor: (reply, _session, now) => command(reply, now),
    sendAs: async () => ({ text: "", structured: {} }),
    ownSession: (s) => s === "ses_claude",
  });
  // As inbox.ts: a held poll answers inside the store's notify, and the far tags run in the same write, both before
  // the Inbox's own start of the swarm.
  const held: InboxReplyCommand[] = [];
  store.subscribe((line) => {
    if (line.kind !== "message" || line.record.author.kind !== "person") return;
    for (const item of store.pendingReplies("ses_claude")) held.push(command(item));
    tags.onPersonMessage(line.record);
  });
  const root = store.startPersonThread({
    project_id: project.id,
    body: `Add per-berth pricing. /swarm\n\n${SWARM_BLOCK}`,
    idempotency_key: "k-held",
    to: { host: "claude-code", session: "ses_claude" },
    tags: [{ host: "pi", session: "ses_far_pi", wakes: true, machine: FAR }],
  }).message;
  expect(store.swarmOf(root.id)).toBeNull();
  expect(held.map((c) => c.body.endsWith(swarmJoinLine(root.id)))).toEqual([true]);
  expect(farWrites.map((w) => [w.session, String((w.command as InboxReplyCommand).body).endsWith(swarmJoinLine(root.id))])).toEqual([["ses_far_pi", true]]);
  // The join that line asks for works before the Inbox has written the record.
  expect(joinSwarm(store, root.id, { session: "ses_claude", host: "claude-code", name: null }).member.name).toBe("Claude Code");
  expect(store.swarmOf(root.id)!.on).toBe(true);
  // A swarm the person turned off is not offered.
  store.writeSwarm({ ...store.swarmOf(root.id)!, on: false });
  expect(command(store.message(root.id)!).body.endsWith(swarmJoinLine(root.id))).toBe(false);
});
