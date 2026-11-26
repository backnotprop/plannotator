/**
 * Swarm's Add an agent and Remove, on the thread's computer: `POST threads/:id/swarm/add` (`addSwarmAgent`) and main's
 * Remove an agent from a thread (`store.removeFromThread`) in a swarm. Stores in temp folders, the far tags' outbox a
 * stand-in that keeps what it is handed. No Inbox, no network.
 *
 * The failures these guard: Add an agent that only types `@`, so the agent added is never told it is in a swarm; the
 * agent added handed nothing it can join from (no `/swarm` text, no join line); the agents already in woken again by
 * it; an agent on a linked computer added here never woken there; a removed agent still in the members, the status
 * or the ghost thread's "everyone", or still able to speak or join; a swarm's sub-agent that never wrote in the thread
 * refused by Remove; a removed agent added again staying out; Add an agent's message read as going to the thread's
 * first agent (its row's "Saved for Claude Code"); an agent on a linked computer whose name is not known sent as one on
 * the thread's computer.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { composeInboxSkillsBlock, inboxBuiltinSkillContent } from "@plannotator/core/inbox-skills-compose";
import type { InboxMessage, InboxTag } from "@plannotator/core/inbox-types";
import { INBOX_MESSAGE_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import type { SkillCatalogEntry } from "@plannotator/core/skill-references-render";
import { SWARM_SKILL, swarmJoinLine } from "@plannotator/core/swarm-skill";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { SWARM_WORDS, joinSwarm, saySwarm, startSwarm, swarmWire } from "@plannotator/shared/inbox/swarm";
import { inboxMessageStartsSwarm } from "@plannotator/shared/inbox/swarm-start";
import { createInboxFarTags } from "./inbox-far-tags";
import type { OutboxEntry } from "./inbox-outbox";
import { farSwarmAnswer, swarmWindowRoute, type SwarmRouteContext } from "./inbox-swarm-route";
import { swarmWakeOf } from "./inbox-swarm-wake";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SWARM_REF = { name: SWARM_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true } as SkillCatalogEntry;
const SWARM_BLOCK = composeInboxSkillsBlock([SWARM_REF], new Map([[SWARM_SKILL.name, inboxBuiltinSkillContent(SWARM_REF, false)!]]), INBOX_MESSAGE_SKILL_AUDIENCE);
const MACHINE_A = "ibx_01KAZ00000000000000000000A";
const MACHINE_B = "ibx_01KAZ00000000000000000000B";
const CLAUDE = { host: "claude-code", session: "ses_claude", name: null };
const CODEX = { host: "codex", session: "ses_codex", name: null };

/** The agents the Add list offers, as the reply's tags resolve them: this computer's Pi, and Qwen on the Mac mini. */
const AGENTS: Record<string, InboxTag> = {
  ses_pi: { host: "pi", session: "ses_pi", wakes: true },
  ses_far_qwen: { host: "qwen", session: "ses_far_qwen", wakes: true, machine: MACHINE_B },
};

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-swarm-add-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date() });
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  const thread = store.startPersonThread({
    project_id: project.id,
    body: `Add per-berth pricing. /swarm\n\n${SWARM_BLOCK}`,
    idempotency_key: "k1",
    to: { host: "claude-code", session: "ses_claude" },
    tags: [{ host: "codex", session: "ses_codex", wakes: true }],
  }).message.id;
  startSwarm(store, thread);
  joinSwarm(store, thread, CLAUDE);
  joinSwarm(store, thread, CODEX);
  const ctx: SwarmRouteContext = {
    store,
    on: () => true,
    live: () => null,
    ownSession: (s) => s === "ses_claude",
    serverSession: "srv_page",
    far: { placeOf: async () => null, nameOf: (m) => (m === MACHINE_B ? "Mac mini" : null), ask: async () => ({ status: 409, json: null }) },
    tagOf: async (value) =>
      (value as { session: string }[]).map((item) => {
        const tag = AGENTS[item.session];
        if (!tag) throw Object.assign(new Error("A session you tagged is not live any more"), { code: "session_not_live" });
        return tag;
      }),
  };
  return { store, thread, ctx };
}

const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
const add = async (ctx: SwarmRouteContext, thread: string, body: Record<string, unknown>) => {
  const req = new Request(`http://127.0.0.1:1/api/inbox/threads/${thread}/swarm/add`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "srv_page", ...body }) });
  const res = (await swarmWindowRoute(req, new URL(req.url), ctx, readBody))!;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const command = (store: InboxStore, reply: InboxMessage) => swarmWakeOf(store, reply, { type: "reply", id: reply.id, thread_id: reply.thread_id, reply_to: reply.reply_to, subject: null, body: reply.body, url: "http://x/" }, true);
const latest = (store: InboxStore, thread: string) => store.message(store.threadMessageIds(thread).at(-1)!)!;

test("Add an agent hands that agent alone the thread with the /swarm skill and its join line; it is listed until it joins", async () => {
  const { store, thread, ctx } = world();
  const before = store.threadMessageIds(thread).length;
  const answer = await add(ctx, thread, { session: "ses_pi", host: "pi", label: "Pi", idempotency_key: "add-pi" });
  expect(answer.status).toBe(200);
  const members = (answer.json.swarm as { members: { session: string; joined: boolean }[] }).members;
  expect(members.find((m) => m.session === "ses_pi")).toMatchObject({ joined: false });

  const sent = latest(store, thread);
  expect(store.threadMessageIds(thread).length).toBe(before + 1);
  expect(sent.author.kind).toBe("person");
  // It carries the approved skill text, as the first agents' message did.
  expect(inboxMessageStartsSwarm(sent)).toBe(true);
  expect(sent.body).toContain(SWARM_SKILL.body);
  // Only the agent added is handed it: the agents already in are not woken again.
  expect(store.isFor(sent, "ses_pi")).toBe(true);
  expect(store.isFor(sent, "ses_claude")).toBe(false);
  expect(store.isFor(sent, "ses_codex")).toBe(false);
  // No session owns it, so nothing reads it as going to the thread's first agent: its recipients are the agent added
  // alone, and the row draws no owner's "Saved for Claude Code".
  expect(store.recipientsOf(sent).map((r) => r.session)).toEqual(["ses_pi"]);
  expect(store.listRow(thread)!.delivery ?? null).toBeNull();
  // A live agent is added to the thread, so its wake is the added one.
  expect(sent.tags?.[0]).toMatchObject({ session: "ses_pi", joined: true });
  // Its wake ends with the join line for this thread.
  expect(command(store, sent).body.endsWith(swarmJoinLine(thread))).toBe(true);

  // The outbox sends it again (a linked computer's window, its answer lost): written once.
  expect((await add(ctx, thread, { session: "ses_pi", host: "pi", idempotency_key: "add-pi" })).status).toBe(200);
  expect(store.threadMessageIds(thread).length).toBe(before + 1);

  // It joins: a member like the others.
  joinSwarm(store, thread, { host: "pi", session: "ses_pi", name: null });
  expect(swarmWire(store, thread, () => null)!.members.find((m) => m.session === "ses_pi")).toMatchObject({ joined: true });
  // A joined member added again writes nothing.
  expect((await add(ctx, thread, { session: "ses_pi", host: "pi", idempotency_key: "add-pi-2" })).status).toBe(200);
  expect(store.threadMessageIds(thread).length).toBe(before + 1);
});

test("Add an agent on a linked computer: its wake, with the join line, goes to its own computer through the outbox, and it is listed there by name", async () => {
  const { store, thread, ctx } = world();
  const writes: { machine: string; route: string; body: Record<string, unknown> }[] = [];
  const kept = new Set<string>();
  const tags = createInboxFarTags({
    store,
    selfId: () => MACHINE_A,
    selfName: () => "Studio",
    peers: () => [],
    nameOf: () => "Mac mini",
    holdWrite: (machine, route, body) => {
      writes.push({ machine, route, body });
      kept.add(String(body.idempotency_key));
      return null;
    },
    heldWrite: (key) => (kept.has(key) ? ({ key } as OutboxEntry) : null),
    commandFor: (reply) => command(store, reply),
    sendAs: async () => ({ text: "", structured: {} }),
    ownSession: (s) => s === "ses_claude",
  });
  const answer = await add(ctx, thread, { session: "ses_far_qwen", host: "qwen", machine: MACHINE_B, idempotency_key: "add-qwen" });
  expect(answer.status).toBe(200);
  // Not joined, and named by its own computer, never this one's.
  expect((answer.json.swarm as { members: { session: string; joined: boolean; machine_name?: string }[] }).members.find((m) => m.session === "ses_far_qwen")).toMatchObject({ joined: false, machine_name: "Mac mini" });
  const sent = latest(store, thread);
  tags.onPersonMessage(sent);
  expect(writes.map((w) => [w.machine, w.body.session])).toEqual([[MACHINE_B, "ses_far_qwen"]]);
  expect(String((writes[0]!.body.command as { body: string }).body).endsWith(swarmJoinLine(thread))).toBe(true);
  // From its computer it joins as itself.
  expect(farSwarmAnswer(ctx, MACHINE_B, { ask: { action: "join", thread }, session: "ses_far_qwen", host: "qwen" }).thread_id).toBe(thread);
});

test("An agent added on a linked computer whose name is not known: the wire says a linked computer (machine_name null), never the thread's", async () => {
  const { store, thread, ctx } = world();
  const blind = { ...ctx, far: { ...ctx.far!, nameOf: () => null } };
  const answer = await add(blind, thread, { session: "ses_far_qwen", host: "qwen", machine: MACHINE_B, idempotency_key: "add-qwen" });
  const member = (answer.json.swarm as { members: { session: string; machine_name?: string | null }[] }).members.find((m) => m.session === "ses_far_qwen")!;
  expect(member).toHaveProperty("machine_name", null);
  // Joined, still not named: the same.
  farSwarmAnswer(blind, MACHINE_B, { ask: { action: "join", thread }, session: "ses_far_qwen", host: "qwen" });
  expect(swarmWire(store, thread, () => null, () => null)!.members.find((m) => m.session === "ses_far_qwen")).toHaveProperty("machine_name", null);
  // This computer's own members carry none.
  expect(swarmWire(store, thread, () => null, () => null)!.members.find((m) => m.session === "ses_claude")).not.toHaveProperty("machine_name");
});

test("Remove in a swarm: out of the members, the status and the ghost thread's everyone; its words stay; it can neither speak nor join until it is added again", async () => {
  const { store, thread, ctx } = world();
  // A sub-agent that joined and never wrote in the thread.
  joinSwarm(store, thread, { host: "claude-code", session: "ses_sub", name: "Tester" }, { for: "Claude Code" });
  saySwarm(store, thread, CODEX, "Schema is in.");
  const ghost = store.swarmOf(thread)!.ghost_id!;
  const said = store.ghostMessages(ghost).length;

  store.removeFromThread(thread, "ses_codex");
  store.removeFromThread(thread, "ses_sub");
  const wire = swarmWire(store, thread, () => null)!;
  expect(wire.members.map((m) => m.session)).toEqual(["ses_claude"]);
  // "To everyone" leaves them out, and nothing waits for them.
  const everyone = saySwarm(store, thread, null, "Status, please.").message;
  expect((everyone.tags ?? []).map((t) => t.session)).toEqual(["ses_claude"]);
  expect(store.isSwarmMember(thread, "ses_codex")).toBe(false);
  // Its past ghost words stay.
  expect(store.ghostMessages(ghost).length).toBe(said + 1);
  // It is told it was removed when it tries to speak or join.
  expect(() => saySwarm(store, thread, CODEX, "Still here?")).toThrow(expect.objectContaining({ code: "removed_from_swarm", message: SWARM_WORDS.removed }));
  expect(() => joinSwarm(store, thread, CODEX)).toThrow(expect.objectContaining({ code: "removed_from_swarm" }));

  // Added again: back in, as it was.
  expect((await add({ ...ctx, tagOf: async () => [{ host: "codex", session: "ses_codex", wakes: true }] }, thread, { session: "ses_codex", host: "codex", idempotency_key: "add-codex" })).status).toBe(200);
  expect(swarmWire(store, thread, () => null)!.members.find((m) => m.session === "ses_codex")).toMatchObject({ joined: true });
  expect(saySwarm(store, thread, CODEX, "Back.").message.tags?.map((t) => t.session)).toEqual(["ses_claude"]);
});

test("Remove on a linked computer's swarm member: its computer cannot speak for it there until the person adds it back", () => {
  const { store, thread, ctx } = world();
  farSwarmAnswer(ctx, MACHINE_B, { ask: { action: "join", thread }, session: "ses_far_pi", host: "pi" });
  store.removeFromThread(thread, "ses_far_pi");
  expect(swarmWire(store, thread, () => null)!.members.some((m) => m.session === "ses_far_pi")).toBe(false);
  expect(() => farSwarmAnswer(ctx, MACHINE_B, { ask: { action: "say", thread, text: "Hello?" }, session: "ses_far_pi", host: "pi" })).toThrow(expect.objectContaining({ code: "removed_from_swarm" }));
});
