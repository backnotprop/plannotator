/**
 * What every wake reads for a swarm's ghost thread (docs/agent-guides/inbox-swarm.md, "Who is woken how"): the store's
 * pending items, which the bridge poll (Claude Code, Pi, OpenCode, DeepSeek Harness, Cline, OpenClaw, Hermes) hands
 * one session at a time and the Codex, Qwen, T3, Antigravity and cloud wakes read in one pass, and the sessions those
 * wakes look at. The failures these guard: a member of some host that never gets a ghost message, one that gets it
 * twice, the author or a non-member that gets it, words still handed once the swarm or its switch is off, a cloud
 * agent's wake that cannot be recorded on a ghost message, and a delivery in the ghost thread that changes the main
 * thread's row (its unread, or its "Delivered to" line).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";
import { joinSwarm, leaveSwarm, saySwarm, setSwarmOn, startSwarm, type SwarmCaller } from "./swarm";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One member of every kind the Inbox wakes: the poll's hosts, the self-woken ones and a paired cloud agent. */
const MEMBERS: SwarmCaller[] = [
  { session: "ses_claude", host: "claude-code", name: null },
  { session: "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b", host: "codex", name: null },
  { session: "7c1f9a52-3b8e-4d61-9f0a-2e5b8c7d4a13", host: "qwen", name: null },
  { session: "t3-thread-1", host: "t3", name: null },
  { session: "6640fa39-c263-49df-b314-312ed85b242f", host: "antigravity", name: null },
  { session: "cloud.0123456789ab", host: "cloud", name: null },
  { session: "ses_pi", host: "pi", name: null },
  { session: "ses_far_opencode", host: "opencode", name: null, machine: "ibx_01KAZ0000000000000000000PI", machine_name: "Mac mini" },
];
const AUTHOR = MEMBERS[0]!;
const OUTSIDER = "ses_outsider";
const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_claude", name: "Claude Code" };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-swarm-wakes-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date() });
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: "Per-berth pricing: the plan.", subject: "Per-berth pricing" }).message.id;
  startSwarm(store, thread);
  for (const member of MEMBERS) joinSwarm(store, thread, member);
  const everyone = new Set([...MEMBERS.map((m) => m.session), OUTSIDER]);
  /** Each session's pending ids, as the one-pass wakes read them. */
  const pending = () => {
    const found = store.pendingRepliesFor(everyone, { tags: true });
    return Object.fromEntries([...everyone].map((s) => [s, (found.get(s) ?? []).map((m) => m.id)]));
  };
  return { dir, store, thread, everyone, pending };
}

test("a ghost message waits once for every other member, of every host, and never for its author or a non-member", () => {
  const { store, thread, pending } = world();
  const said = saySwarm(store, thread, AUTHOR, "Price endpoint: per berth, per night?").message;
  const got = pending();
  for (const member of MEMBERS.slice(1)) {
    expect(got[member.session]).toEqual([said.id]);
    // The bridge poll's one-session read agrees.
    expect(store.pendingReplies(member.session, { tags: true }).map((m) => m.id)).toEqual([said.id]);
  }
  expect(got[AUTHOR.session]).toEqual([]);
  expect(got[OUTSIDER]).toEqual([]);
  expect(store.ghostWaitsFor(said).sort()).toEqual(MEMBERS.slice(1).map((m) => m.session).sort());
  // A connection that does not word tags is never handed it (its wake would read as the person's reply).
  expect(store.pendingReplies(MEMBERS[6]!.session, { tags: false })).toEqual([]);
});

test("the self-woken hosts look at a member a ghost message tags, after a restart too", () => {
  const { dir, store, thread } = world();
  saySwarm(store, thread, AUTHOR, "Who takes the migration?");
  for (const member of MEMBERS.filter((m) => ["codex", "qwen", "t3", "antigravity"].includes(m.host!))) {
    expect(store.wakingSessionsOfHost(member.host!).has(member.session)).toBe(true);
  }
  expect(InboxStore.open(dir).wakingSessionsOfHost("codex").has(MEMBERS[1]!.session)).toBe(true);
});

test("delivered once: a member's delivery settles it for that member alone, and a second one changes nothing", () => {
  const { store, thread, pending } = world();
  const said = saySwarm(store, thread, AUTHOR, "Ready for review.").message;
  const codex = MEMBERS[1]!.session;
  store.recordDelivery(said.id, { host: "codex", session: codex });
  const after = store.message(said.id)!;
  expect(store.recordDelivery(said.id, { host: "codex", session: codex })).toEqual(after);
  const got = pending();
  expect(got[codex]).toEqual([]);
  expect(got[MEMBERS[2]!.session]).toEqual([said.id]);
  expect(store.ghostWaitsFor(store.message(said.id)!)).not.toContain(codex);
});

test("a cloud member's wake is recorded on a ghost message, and its start is that member's delivery only", () => {
  const { store, thread, pending } = world();
  const said = saySwarm(store, thread, AUTHOR, "Cloud: run the load test.").message;
  const cloud = MEMBERS[5]!.session;
  store.recordCloudWake(said.id, { state: "started", name: "Nightly fixer", preset: "other", at: new Date().toISOString() }, cloud, "cloud");
  const got = pending();
  expect(got[cloud]).toEqual([]);
  expect(got[MEMBERS[1]!.session]).toEqual([said.id]);
});

test("nothing waits once the swarm is turned off, while its switch is off, or for a member who left", () => {
  const { store, thread, pending } = world();
  const said = saySwarm(store, thread, AUTHOR, "One more thing.").message;
  const person = saySwarm(store, thread, null, "The person: keep it small.").message;
  const pi = MEMBERS[6]!.session;
  expect(pending()[pi]).toEqual([said.id, person.id]);
  // The switch (the server's experimental `swarm`) off: no ghost words wait for anyone.
  let on = false;
  store.setSwarmSwitch(() => on);
  expect(Object.values(pending()).flat()).toEqual([]);
  // Back on: what was said before is not handed out in a burst; what is said now waits, even when the first words come
  // before anything reads the switch again.
  on = true;
  const now = saySwarm(store, thread, AUTHOR, "Back on.").message;
  const personNow = saySwarm(store, thread, null, "The person, back on.").message;
  expect(pending()[pi]).toEqual([now.id, personNow.id]);
  // A member who left gets neither an agent's words nor the person's.
  leaveSwarm(store, thread, pi);
  expect(pending()[pi]).toEqual([]);
  // The person's Turn off.
  setSwarmOn(store, thread, false);
  expect(Object.values(pending()).flat()).toEqual([]);
  expect(store.ghostWaitsFor(said)).toEqual([]);
});

test("a ghost message's deliveries never touch the main thread's row: no unread, no Delivered line", () => {
  const { store, thread } = world();
  const before = store.listRow(thread)!;
  const said = saySwarm(store, thread, AUTHOR, "Done with the schema.").message;
  for (const member of MEMBERS.slice(1)) store.recordDelivery(said.id, { host: member.host!, session: member.session });
  const after = store.listRow(thread)!;
  expect({ unread: after.unread, unseen: after.unseen, delivery: after.delivery, section: after.section }).toEqual({ unread: before.unread, unseen: before.unseen, delivery: before.delivery, section: before.section });
  expect(store.listRows().map((row) => row.thread_id)).toEqual([thread]);
  // The main thread's own messages carry no delivery for it.
  expect(store.thread(thread)!.messages.some((m) => m.delivery || m.tags?.some((t) => t.delivery))).toBe(false);
});
