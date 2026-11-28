/**
 * A swarm's ghost message through the wakes the Inbox runs itself (docs/agent-guides/inbox-swarm.md, "Who is woken
 * how"), each with a store in a temp folder and no Inbox: the Antigravity wake against the fake agent API
 * (tests/helpers/fake-agy.ts), and the cloud wake against a fake webhook (its `fetch`). The real agents are never run.
 *
 * The failures these guard: a member woken only at that host's next sweep (or never), woken twice, worded as the
 * person's reply, its author or a non-member woken, words woken while the switch is off, and a second cloud member
 * never woken because the first one's wake was recorded on the same message.
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { InboxAuthor, InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { SWARM_WORDS, joinSwarm, saySwarm, startSwarm } from "@plannotator/shared/inbox/swarm";
import { createFakeAgy, type FakeAgy } from "../../tests/helpers/fake-agy";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { createInboxAntigravityWake, type InboxAntigravityWake } from "./inbox-antigravity-wake";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import { createInboxCloudWake, type InboxCloudWaker } from "./inbox-cloud-wake";
import { swarmWakeOf } from "./inbox-swarm-wake";

const MEMBER = "6640fa39-c263-49df-b314-312ed85b242f";
const OUTSIDER = "2cb0b3d5-163d-4a94-a19b-5b564a906739";
const TOKEN = "app-token-0123456789abcdef";
const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_claude", name: "Claude Code" };
const CLAUDE = { session: "ses_claude", host: "claude-code", name: null };

const fakes: FakeAgy[] = [];
const stops: (InboxAntigravityWake | InboxCloudWaker)[] = [];
afterEach(() => {
  for (const wake of stops.splice(0)) wake.stop();
  for (const fake of fakes.splice(0)) fake.remove();
});

const waitFor = async (check: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await Bun.sleep(20);
  return check();
};

/** The bridge's command for an item, as inbox.ts `replyCommand` makes it: a ghost thread's words a notice. */
const commandOf = (store: InboxStore) => (item: InboxMessage): InboxReplyCommand =>
  swarmWakeOf(store, item, { type: "reply", id: item.id, thread_id: item.thread_id, reply_to: item.reply_to ?? null, subject: null, body: item.body, url: "http://127.0.0.1/#thread" }, true);

function swarmIn(store: InboxStore) {
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: "The plan.", subject: "Ledger" }).message.id;
  startSwarm(store, thread);
  joinSwarm(store, thread, CLAUDE);
  return thread;
}

test("Antigravity: a member is woken at once, once, as a notice; never the author, a non-member, or with the switch off", async () => {
  const fake = createFakeAgy();
  fakes.push(fake);
  fake.server("localhost:57930", { up: true, token: TOKEN, product: "app", conversations: [MEMBER, OUTSIDER] });
  fake.hub("app", 57930, TOKEN);
  const store = InboxStore.open(join(fake.root, "data", "inbox"));
  const thread = swarmIn(store);
  joinSwarm(store, thread, { session: MEMBER, host: "antigravity", name: null });
  const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { PATH: "/usr/bin:/bin", HOME: fake.home } });
  const start = () => {
    const wake = createInboxAntigravityWake({ store, environment, commandOf: commandOf(store), log: () => {}, appClients: [], waitCheckMs: 50 });
    stops.push(wake);
    return wake;
  };
  const wake = start();
  const meta = (c: string) => ({ "antigravity.google/artifacts_dir": `/home/x/.gemini/antigravity/brain/${c}`, "antigravity.google/conversation_id": c, "antigravity.google/root_conversation_id": c, progressToken: "t:1" });
  expect(await wake.wakes("antigravity", MEMBER, meta(MEMBER))).toBe(true);
  expect(await wake.wakes("antigravity", OUTSIDER, meta(OUTSIDER))).toBe(true);
  await wake.sweep();

  // Nobody calls sweep: the line itself is the moment to look.
  const said = saySwarm(store, thread, CLAUDE, "Antigravity: take the importer?").message;
  expect(await waitFor(() => fake.sends().length > 0)).toBe(true);
  await wake.sweep();
  wake.stop();
  await start().sweep();
  const sends = fake.sends();
  expect(sends.map((s) => s.args[1])).toEqual([MEMBER]);
  expect(sends[0]!.args[2]).toContain(SWARM_WORDS.wake("Claude Code"));
  expect(sends[0]!.args[2]).toContain("Antigravity: take the importer?");
  expect(store.message(said.id)!.tags!.find((t) => t.session === MEMBER)!.delivery).toMatchObject({ host: "antigravity", session: MEMBER });

  // The switch off: nothing is handed.
  store.setSwarmSwitch(() => false);
  saySwarm(store, thread, CLAUDE, "Not while it is off.");
  await Bun.sleep(150);
  await stops.at(-1)!.sweep();
  expect(fake.sends()).toHaveLength(1);
});

test("cloud: every cloud member is woken once with the notice first; the author is not", async () => {
  // Only its temp folder is used (removed after the test).
  const scratch = createFakeAgy();
  fakes.push(scratch);
  const store = InboxStore.open(join(scratch.root, "data"));
  const thread = swarmIn(store);
  const agent = (session: string, name: string): InboxCloudAgent => ({ session, name, preset: "other", url: `https://hooks.example.test/${name}`, key: "k-0123456789", project_id: null, created_at: "", key_set_at: "", key_rejected_at: null });
  const list = [agent("cloud.0000000000a1", "Nightly fixer"), agent("cloud.0000000000b2", "Load tester"), agent("cloud.0000000000c3", "Writer")];
  // The writer is the author: a cloud member that says something is never woken for it.
  for (const a of list) joinSwarm(store, thread, { session: a.session, host: "cloud", name: a.name });
  const agents = { list: () => list, agent: (s: string) => list.find((a) => a.session === s) ?? null, markKeyRejected: () => {}, homeRoot: () => null } as unknown as InboxCloudAgents;
  const posts: { url: string; body: { text?: string } }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const wake = createInboxCloudWake({ store, agents, pin: () => {}, threadUrl: (id) => `http://127.0.0.1/#thread=${id}`, fetch, gapMs: 0, log: () => {} });
  stops.push(wake);
  await wake.sweep();
  saySwarm(store, thread, { session: list[2]!.session, host: "cloud", name: "Writer" }, "Run the load test on staging.");
  expect(await waitFor(() => posts.length >= 2)).toBe(true);
  await wake.sweep();
  await wake.sweep();
  expect(posts.map((p) => p.url).sort()).toEqual(["https://hooks.example.test/Load tester", "https://hooks.example.test/Nightly fixer"]);
  for (const post of posts) expect(post.body.text).toContain(SWARM_WORDS.wake("Writer"));
  expect(store.pendingRepliesFor(new Set(list.map((a) => a.session)), { tags: true }).size).toBe(0);
});

test("cloud: each member keeps its own wake state; one that must retry keeps its backoff and the other is woken once", async () => {
  const scratch = createFakeAgy();
  fakes.push(scratch);
  const store = InboxStore.open(join(scratch.root, "data"));
  const thread = swarmIn(store);
  const agent = (session: string, name: string): InboxCloudAgent => ({ session, name, preset: "other", url: `https://hooks.example.test/${name}`, key: "k-0123456789", project_id: null, created_at: "", key_set_at: "", key_rejected_at: null });
  const down = agent("cloud.0000000000a1", "Down");
  const up = agent("cloud.0000000000b2", "Up");
  const list = [down, up];
  for (const a of list) joinSwarm(store, thread, { session: a.session, host: "cloud", name: a.name });
  const agents = { list: () => list, agent: (s: string) => list.find((a) => a.session === s) ?? null, markKeyRejected: () => {}, homeRoot: () => null } as unknown as InboxCloudAgents;
  const posts: string[] = [];
  const fetch = (async (url: string) => {
    posts.push(url);
    return new Response("{}", { status: url.endsWith("/Down") ? 503 : 200 });
  }) as unknown as typeof globalThis.fetch;
  let clock = Date.parse("2026-11-24T09:00:00.000Z");
  const start = () => {
    const wake = createInboxCloudWake({ store, agents, pin: () => {}, threadUrl: (id) => `http://127.0.0.1/#thread=${id}`, fetch, gapMs: 0, retryMs: 60_000, now: () => clock, log: () => {} });
    stops.push(wake);
    return wake;
  };
  const wake = start();
  await wake.sweep();
  const said = saySwarm(store, thread, CLAUDE, "Both: rerun the nightly.").message;
  expect(await waitFor(() => posts.length >= 2)).toBe(true);
  await wake.sweep();
  await wake.sweep();
  expect(posts.sort()).toEqual(["https://hooks.example.test/Down", "https://hooks.example.test/Up"]);
  const latest = store.message(said.id)!;
  expect(store.cloudWakeOf(latest, down.session)).toMatchObject({ state: "retrying", name: "Down" });
  expect(store.cloudWakeOf(latest, up.session)).toMatchObject({ state: "started", name: "Up" });
  // After a restart, nobody is woken again before the backoff ends; then only the one that failed.
  wake.stop();
  const again = start();
  await again.sweep();
  expect(posts).toHaveLength(2);
  clock += 61_000;
  await again.sweep();
  expect(posts.filter((u) => u.endsWith("/Up"))).toHaveLength(1);
  expect(posts.filter((u) => u.endsWith("/Down"))).toHaveLength(2);
});
