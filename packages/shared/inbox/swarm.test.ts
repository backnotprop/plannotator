/**
 * Swarm in the store (docs/agent-guides/inbox-swarm.md). The failures these guard: a ghost thread that shows up as a
 * row, in a project's threads, in search or as a session's latest thread; an agent's words delivered outside a ghost
 * thread, or to an agent that did not join; a join that is not idempotent or takes a name already taken; a `doing`
 * line that keeps control characters or runs long; a far member whose words are not addressed to its computer; and a
 * swarm that does not read back after a restart.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { INBOX_SWARM_DOING_MAX } from "@plannotator/core/inbox-swarm-types";
import { InboxSearchIndex } from "./search";
import { InboxStore } from "./store";
import { SWARM_GHOST_SEND_REFUSED } from "./swarm-start";
import { joinSwarm, leaveSwarm, markGhostSeen, saySwarm, setSwarmDoing, setSwarmOn, startSwarm, swarmWire, type SwarmCaller } from "./swarm";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLAUDE: SwarmCaller = { session: "ses_claude", host: "claude-code", name: null };
const CODEX: SwarmCaller = { session: "ses_codex", host: "codex", name: null };
const FAR_PI: SwarmCaller = { session: "ses_pi", host: "pi", name: null, machine: "ibx_01KAZ0000000000000000000PI", machine_name: "Mac mini" };
const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_claude", name: "Claude Code" };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-swarm-"));
  roots.push(dir);
  const open = () => InboxStore.open(dir, { now: () => new Date() });
  const store = open();
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: "Per-berth pricing: the plan.", subject: "Per-berth pricing" }).message.id;
  const swarm = startSwarm(store, thread);
  return { dir, store, project, thread, ghost: swarm.ghost_id!, open };
}

const live = () => null;

test("the ghost thread is never a row, a project's thread, a search hit or a session's latest thread", async () => {
  const { store, project, thread, ghost } = world();
  joinSwarm(store, thread, CLAUDE);
  joinSwarm(store, thread, CODEX);
  saySwarm(store, thread, CLAUDE, "berthquartz shape of the price endpoint?");
  expect(store.ghostParentOf(ghost)).toBe(thread);
  expect(store.listRow(ghost)).toBeNull();
  expect(store.listRows().map((r) => r.thread_id)).toEqual([thread]);
  expect(store.threadsOf(project.id).map((t) => t.thread_id)).toEqual([thread]);
  expect(store.lastThreadsBySession().get("ses_claude")?.id).toBe(thread);
  const index = new InboxSearchIndex(store);
  await index.ensureBuilt();
  const hits = index.search({ q: "berthquartz" });
  expect(Object.values(hits.groups ?? {}).flat()).toEqual([]);
  // The same word in a real thread is found: the index works, and only the ghost thread is left out.
  store.sendMessage({ project_id: store.message(thread)!.project_id, author: AGENT, body: "berthquartz in the open.", subject: "Open" });
  await index.ensureBuilt();
  expect(Object.values(index.search({ q: "berthquartz" }).groups ?? {}).flat().length).toBeGreaterThan(0);
});

test("join is idempotent, names are unique, and --for must name a member", () => {
  const { store, thread } = world();
  const first = joinSwarm(store, thread, CLAUDE);
  expect(first.again).toBe(false);
  expect(first.member.name).toBe("Claude Code");
  const again = joinSwarm(store, thread, CLAUDE);
  expect(again.again).toBe(true);
  expect(store.swarmOf(thread)!.members).toHaveLength(1);
  // A second Claude Code is told apart; a name taken is refused; --for names a member.
  const second = joinSwarm(store, thread, { session: "ses_claude_2", host: "claude-code", name: null }, { for: "claude code" });
  expect(second.member.name).toBe("Claude Code 2");
  expect(second.member.for).toBe("Claude Code");
  expect(() => joinSwarm(store, thread, CODEX, { as: "Claude Code" })).toThrow("is taken");
  expect(() => joinSwarm(store, thread, CODEX, { for: "Nobody" })).toThrow("No member is named Nobody");
  expect(leaveSwarm(store, thread, "ses_claude_2")).toBe(true);
  expect(leaveSwarm(store, thread, "ses_claude_2")).toBe(false);
  expect(store.swarmOf(thread)!.members.map((m) => m.session)).toEqual(["ses_claude"]);
});

test("an agent's words in the ghost thread reach only the swarm's members", () => {
  const { store, thread } = world();
  joinSwarm(store, thread, CLAUDE);
  joinSwarm(store, thread, CODEX);
  const said = saySwarm(store, thread, CLAUDE, "Codex, what shape does the price endpoint return?");
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).toEqual([said.message.id]);
  // Never to its own author, never to an agent that did not join, never to a connection that does not word tags.
  expect(store.pendingReplies("ses_claude")).toEqual([]);
  expect(store.pendingReplies("ses_stranger")).toEqual([]);
  expect(store.pendingReplies("ses_codex", { tags: false })).toEqual([]);
  // Delivered once.
  store.recordDelivery(said.message.id, { host: "codex", session: "ses_codex" });
  expect(store.pendingReplies("ses_codex")).toEqual([]);
  // A member that left is no longer handed what waits for it.
  const later = saySwarm(store, thread, CLAUDE, "One more thing.");
  leaveSwarm(store, thread, "ses_codex");
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).not.toContain(later.message.id);
});

test("send_message into a ghost thread is refused, and only a member writes there, so nothing reaches a member from outside", () => {
  const { store, thread, ghost } = world();
  joinSwarm(store, thread, CLAUDE);
  joinSwarm(store, thread, CODEX);
  const said = saySwarm(store, thread, CLAUDE, "Codex: the endpoint?").message;
  const outsider: InboxAuthor = { kind: "agent", host: "pi", session: "ses_outsider", name: "Pi" };
  for (const reply_to of [ghost, said.id]) {
    expect(() => store.sendMessage({ project_id: store.message(thread)!.project_id, author: outsider, body: "- [ ] Ship it?", reply_to })).toThrow(SWARM_GHOST_SEND_REFUSED);
  }
  expect(() => store.writeGhostMessage(ghost, outsider, "Codex, stop.", [{ host: "codex", session: "ses_codex", name: "Codex", wakes: true }])).toThrow(expect.objectContaining({ code: "not_in_swarm" }));
  expect(store.ghostMessages(ghost).map((m) => m.id)).toEqual([said.id]);
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).toEqual([said.id]);
});

test("turning a swarm (or the switch) back on hands out nothing said before", () => {
  const { store, thread } = world();
  joinSwarm(store, thread, CLAUDE);
  joinSwarm(store, thread, CODEX);
  const before = saySwarm(store, thread, CLAUDE, "Said before Turn off.").message;
  const person = saySwarm(store, thread, null, "The person, before Turn off.").message;
  setSwarmOn(store, thread, false);
  expect(store.pendingReplies("ses_codex")).toEqual([]);
  setSwarmOn(store, thread, true);
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).not.toContain(before.id);
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).not.toContain(person.id);
  expect(store.ghostWaitsFor(before)).toEqual([]);
  const after = saySwarm(store, thread, CLAUDE, "Said after Turn on.").message;
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).toEqual([after.id]);
  // The experimental switch: off, then on again.
  let on = true;
  store.setSwarmSwitch(() => on);
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).toEqual([after.id]);
  on = false;
  expect(store.pendingReplies("ses_codex")).toEqual([]);
  // Back on, and the first thing said comes before anything reads the switch: it is handed, what came before is not.
  on = true;
  const later = saySwarm(store, thread, CLAUDE, "Said after the switch came back.").message;
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).toEqual([later.id]);
});

test("the first words said after the switch comes back on are handed once, with nothing read in between", () => {
  const { store, thread } = world();
  joinSwarm(store, thread, CLAUDE);
  joinSwarm(store, thread, CODEX);
  let on = false;
  store.setSwarmSwitch(() => on);
  expect(store.pendingReplies("ses_codex")).toEqual([]);
  on = true;
  const said = saySwarm(store, thread, CLAUDE, "First words after the switch is back.").message;
  expect(store.ghostWaitsFor(said)).toEqual(["ses_codex"]);
  expect(store.pendingRepliesFor(new Set(["ses_codex"]), { tags: true }).get("ses_codex")?.map((m) => m.id)).toEqual([said.id]);
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).toEqual([said.id]);
  store.recordDelivery(said.id, { host: "codex", session: "ses_codex" });
  expect(store.pendingReplies("ses_codex")).toEqual([]);
  expect(store.ghostWaitsFor(store.message(said.id)!)).toEqual([]);
});

test("--to names one member; the person writes to everyone or one; a turned-off swarm takes nothing", () => {
  const { store, thread } = world();
  joinSwarm(store, thread, CLAUDE);
  joinSwarm(store, thread, CODEX);
  joinSwarm(store, thread, FAR_PI);
  const one = saySwarm(store, thread, CLAUDE, "Pi only.", "pi");
  expect(one.message.tags!.map((t) => t.session)).toEqual(["ses_pi"]);
  expect(() => saySwarm(store, thread, CLAUDE, "Me?", "Claude Code")).toThrow("not you");
  const person = saySwarm(store, thread, null, "Weekend rates are on tab 2.");
  expect(person.message.author.kind).toBe("person");
  expect(person.message.tags!.map((t) => t.session).sort()).toEqual(["ses_claude", "ses_codex", "ses_pi"]);
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).toContain(person.message.id);
  setSwarmOn(store, thread, false);
  expect(() => saySwarm(store, thread, CLAUDE, "Anyone?")).toThrow("turned off");
  expect(() => joinSwarm(store, thread, { session: "ses_new", host: "pi", name: null })).toThrow("turned off");
});

test("a far member's words are addressed to its computer, and its computer's sessions are the thread's far sessions", () => {
  const { store, thread, ghost } = world();
  joinSwarm(store, thread, CLAUDE);
  const pi = joinSwarm(store, thread, FAR_PI);
  expect(pi.member.machine).toBe(FAR_PI.machine!);
  expect(pi.member.machine_name).toBe("Mac mini");
  const said = saySwarm(store, thread, CLAUDE, "Pi, invoices read berth_rates now.");
  expect(said.message.tags).toEqual([{ host: "pi", session: "ses_pi", name: "Pi", wakes: true, machine: FAR_PI.machine! }]);
  expect(store.farSessions(ghost).get("ses_pi")).toEqual({ machine: FAR_PI.machine!, host: "pi" });
  const back = saySwarm(store, thread, FAR_PI, "Thanks.");
  expect(back.message.author).toMatchObject({ kind: "agent", session: "ses_pi", machine: FAR_PI.machine! });
});

test("doing is one clean line of at most 200 characters", () => {
  const { store, thread } = world();
  joinSwarm(store, thread, CLAUDE);
  const line = setSwarmDoing(store, thread, "ses_claude", `Berth screen\n\u001b[31m and\tcheckout\u0007 ${"x".repeat(400)}`);
  expect(line.startsWith("Berth screen [31m and checkout")).toBe(true);
  expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
  expect([...line].length).toBe(INBOX_SWARM_DOING_MAX);
  expect(() => setSwarmDoing(store, thread, "ses_claude", "\n\t")).toThrow("one line");
  expect(() => setSwarmDoing(store, thread, "ses_codex", "Not a member")).toThrow("not joined");
});

test("the wire lists joined members, then the agents the thread names that have not joined, and counts unseen ghost words", () => {
  const { store, thread, project } = world();
  // New message to two agents: `to` the first, the second as a tag (compose's several picks); a repeat of `to` is dropped.
  const started = store.startPersonThread({
    project_id: project.id,
    body: "Add per-berth pricing.",
    idempotency_key: "k1",
    to: { host: "claude-code", session: "ses_claude" },
    tags: [{ host: "claude-code", session: "ses_claude", wakes: true }, { host: "codex", session: "ses_codex", wakes: true }],
  }).message;
  expect(started.tags!.map((t) => t.session)).toEqual(["ses_codex"]);
  expect(store.pendingReplies("ses_codex").map((m) => m.id)).toEqual([started.id]);
  expect(store.pendingReplies("ses_claude").map((m) => m.id)).toEqual([started.id]);
  startSwarm(store, started.id);
  joinSwarm(store, started.id, CLAUDE);
  const wire = swarmWire(store, started.id, live)!;
  expect(wire.members.map((m) => [m.session, m.joined])).toEqual([
    ["ses_claude", true],
    ["ses_codex", false],
  ]);
  joinSwarm(store, started.id, CODEX);
  saySwarm(store, started.id, CODEX, "Up.");
  expect(swarmWire(store, started.id, live)!.ghost_unread).toBe(1);
  markGhostSeen(store, started.id);
  expect(swarmWire(store, started.id, live)!.ghost_unread).toBe(0);
  expect(swarmWire(store, thread, live)!.members).toEqual([]);
});

test("a swarm and its ghost thread read back after a restart", () => {
  const { store, thread, ghost, open } = world();
  joinSwarm(store, thread, CLAUDE);
  joinSwarm(store, thread, CODEX);
  const said = saySwarm(store, thread, CLAUDE, "Still there?");
  const again = open();
  expect(again.swarmOf(thread)!.members.map((m) => m.name)).toEqual(["Claude Code", "Codex"]);
  expect(again.ghostParentOf(ghost)).toBe(thread);
  expect(again.listRow(ghost)).toBeNull();
  expect(again.pendingReplies("ses_codex").map((m) => m.id)).toEqual([said.message.id]);
});

test("deleting a thread deletes its ghost thread and its swarm record with it, now and after a restart", () => {
  const { store, thread, ghost, open } = world();
  joinSwarm(store, thread, CLAUDE);
  joinSwarm(store, thread, CODEX);
  const said = saySwarm(store, thread, CLAUDE, "The endpoint takes a date now.");
  // Another thread's swarm stays.
  const other = store.sendMessage({ project_id: store.message(thread)!.project_id, author: AGENT, body: "Docs search.", subject: "Docs" }).message.id;
  const otherGhost = startSwarm(store, other).ghost_id!;
  store.deleteThread(thread);
  for (const reader of [store, open()]) {
    expect(reader.message(thread)).toBeNull();
    expect(reader.message(ghost)).toBeNull();
    expect(reader.message(said.message.id)).toBeNull();
    expect(reader.swarmOf(thread)).toBeNull();
    expect(reader.ghostParentOf(ghost)).toBeNull();
    expect(reader.pendingReplies("ses_codex")).toEqual([]);
    expect(reader.swarmOf(other)?.ghost_id).toBe(otherGhost);
    expect(reader.ghostParentOf(otherGhost)).toBe(other);
  }
});
