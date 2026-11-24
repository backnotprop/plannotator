/**
 * Tag an agent on another linked computer when this Inbox wakes that agent itself (inbox-far-host-wakes.ts): a wake
 * the thread's computer handed a Codex thread here goes in through the Codex wake's own `codex queue --thread
 * --message`, as a tag here does. A real store and the real Codex wake in a temp folder; the Codex CLI is a stand-in
 * `run` (nothing is started). What regresses: a far wake for Codex (Qwen, T3, Antigravity) never sent, sent twice,
 * sent after it was taken back, its delivery never told to the thread's computer, written into this store, or a far
 * wake for a polling session handed by the wake too (twice with the poll); and these sessions left out of the list a
 * linked computer tags from.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { AgentEnvironment, AgentRunResult } from "./inbox-agents";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import { createInboxCloudWake } from "./inbox-cloud-wake";
import { createInboxCodexWake } from "./inbox-codex-wake";
import { farWakeStore } from "./inbox-far-host-wakes";
import { createInboxFarWakes, type FarWake } from "./inbox-far-wakes";
import { createInboxLiveSessions } from "./inbox-sessions";
import { createInboxTagsRoute } from "./inbox-tags";

const STUDIO = `ibx_01JZ${"0".repeat(20)}S1`;
const MSG = (n: number) => `msg_01JZ${"0".repeat(20)}${String(n).padStart(2, "0")}`;
const THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const CLOUD = "cloud.0123456789ab";

const roots: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function laptop() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-host-wakes-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(root, "bin"), { recursive: true });
  const cli = join(root, "bin", "codex");
  writeFileSync(cli, "");
  const runs: string[][] = [];
  const environment: AgentEnvironment = {
    platform: "linux",
    homeDir: root,
    env: { PLANNOTATOR_TEST_SANDBOX: "1", CODEX_HOME: join(root, "codex") },
    which: (command) => (command === "codex" ? cli : null),
    run: async (argv): Promise<AgentRunResult> => {
      runs.push([...argv]);
      return { exitCode: 0, timedOut: false, stdout: argv[1] === "--version" ? "codex-cli 0.160.0\n" : "", stderr: "" };
    },
  };
  const store = InboxStore.open(dataDir);
  const farWakes = createInboxFarWakes({ dataDir });
  const told: { wake: FarWake; session: string }[] = [];
  const far = farWakeStore(store, farWakes, (wake, session) => told.push({ wake, session }));
  let clock = Date.parse("2026-11-24T09:00:00.000Z");
  const codex = createInboxCodexWake({
    store: far.store,
    environment,
    commandOf: (item, session) => far.commandOf(item, session) ?? (() => { throw new Error(`no far wake for ${item.id}`); })(),
    extraClis: [],
    now: () => clock,
    log: () => {},
  });
  stops.push(() => codex.stop());
  const queued = () => runs.filter((argv) => argv[1] === "queue");
  const tag = (n: number, session = THREAD, host = "codex") =>
    farWakes.receive(
      STUDIO,
      {
        reply_id: MSG(n),
        thread_id: MSG(1),
        session,
        host,
        command: { type: "reply", id: MSG(n), thread_id: MSG(1), reply_to: MSG(1), subject: "Retry queue", body: `Can you look at the retry order? (${n})`, url: "http://studio/", tagged: { owner: "Claude Code" } },
      },
      () => "http://laptop/#thread",
    );
  return { root, store, farWakes, far, codex, told, queued, tag, tick: (ms: number) => (clock += ms) };
}

const until = async (done: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("a far tag for a session this Inbox wakes itself", () => {
  test("goes into the Codex thread through codex queue once, and its delivery is told to the thread's computer", async () => {
    const w = laptop();
    expect(w.tag(2).kept).toBe(true);
    await until(() => w.queued().length === 1);
    const [argv] = w.queued();
    expect(argv![2]).toBe(`--thread=${THREAD}`);
    expect(argv![3]).toStartWith("--message=");
    expect(argv![3]).toContain("Can you look at the retry order? (2)");
    // Queued is not delivered: nothing is told until the thread's next turn calls an Inbox tool.
    expect(w.told).toEqual([]);
    await w.codex.sweep();
    expect(w.queued()).toHaveLength(1);

    w.tick(1_000);
    w.codex.noteToolCall(THREAD, w.tick(0));
    expect(w.told.map((t) => [t.wake.reply_id, t.session])).toEqual([[MSG(2), THREAD]]);
    expect(w.farWakes.pendingFor(THREAD)).toEqual([]);
    await w.codex.sweep();
    expect(w.queued()).toHaveLength(1);
    // Nothing of the far thread is written here.
    expect(w.store.message(MSG(2))).toBeNull();
    expect(w.store.thread(MSG(1))).toBeNull();
  });

  test("one taken back on the thread's computer before it went is never sent", async () => {
    const w = laptop();
    w.tag(3);
    w.farWakes.receive(STUDIO, { reply_id: MSG(3), thread_id: MSG(1), session: THREAD, host: "codex", withdrawn: true }, () => "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await w.codex.sweep();
    expect(w.queued()).toEqual([]);
    expect(w.told).toEqual([]);
  });

  test("a far wake for a session that polls is left to its poll, never added to the self-waking hosts' items", () => {
    const w = laptop();
    w.tag(4, "ses_claude_here", "claude-code");
    expect(w.far.store.pendingRepliesFor(new Set(["ses_claude_here"]), { tags: true }).get("ses_claude_here")).toBeUndefined();
    expect(w.far.store.wakingSessionsOfHost("claude-code").has("ses_claude_here")).toBe(false);
    w.tag(5);
    expect(w.far.store.pendingRepliesFor(new Set([THREAD]), { tags: true }).get(THREAD)?.map((m) => m.id)).toEqual([MSG(5)]);
    expect(w.far.store.wakingSessionsOfHost("codex").has(THREAD)).toBe(true);
  });
});

describe("a far tag for a cloud agent paired here", () => {
  test("is posted to its webhook once with the far thread's words, and the started run is told to the thread's computer", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-cloud-")));
    roots.push(root);
    const dataDir = join(root, "data");
    const store = InboxStore.open(dataDir);
    const farWakes = createInboxFarWakes({ dataDir });
    const told: string[] = [];
    const far = farWakeStore(store, farWakes, (wake, session) => told.push(`${wake.reply_id} ${session}`));
    const agent = { session: CLOUD, name: "Nightly fixer", preset: "other", url: "https://hooks.example.test/wake", key: "k", project_id: null, created_at: "2026-11-24T09:00:00.000Z", key_set_at: null, key_rejected_at: null, device_id: null } as InboxCloudAgent;
    const agents = { list: () => [agent], agent: (s: string) => (s === CLOUD ? agent : null), homeRoot: () => null, markKeyRejected: () => {} } as unknown as InboxCloudAgents;
    const posts: Record<string, unknown>[] = [];
    const cloud = createInboxCloudWake({
      store: far.store,
      agents,
      pin: () => {},
      threadUrl: (threadId) => `http://laptop/#thread=${threadId}`,
      gapMs: 0,
      log: () => {},
      fetch: (async (_url: string, init: { body: string }) => {
        posts.push(JSON.parse(init.body) as Record<string, unknown>);
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
    });
    stops.push(() => cloud.stop());
    farWakes.receive(
      STUDIO,
      { reply_id: MSG(6), thread_id: MSG(1), session: CLOUD, host: "cloud-other", command: { type: "reply", id: MSG(6), thread_id: MSG(1), reply_to: MSG(1), subject: "Retry queue", body: "Nightly fixer, can you rerun the flaky job?", url: "http://studio/", tagged: { owner: "Claude Code" } } },
      () => "http://laptop/#thread",
    );
    await until(() => told.length === 1);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0])).toContain("Nightly fixer, can you rerun the flaky job?");
    expect(posts[0]!.thread).toEqual(expect.objectContaining({ id: MSG(1), subject: "Retry queue" }));
    expect(told).toEqual([`${MSG(6)} ${CLOUD}`]);
    await cloud.sweep();
    expect(posts).toHaveLength(1);
    expect(store.message(MSG(6))).toBeNull();
  });
});

describe("the list a linked computer tags from (taggable-agents)", () => {
  test("offers a Codex thread this Inbox wakes, with the polling sessions", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-host-list-")));
    roots.push(root);
    const store = InboxStore.open(join(root, "data"));
    const live = createInboxLiveSessions({ store, serverSession: "srv", resolveRoot: async (path) => path });
    await live.seenWakeOnly(THREAD, "codex", root);
    (await live.pollStarted("ses_claude_here", "claude-code", { project_path: root, tags: true }))();
    const route = createInboxTagsRoute({ store, serverSession: "srv", live, json: (body, status) => Response.json(body, { status: status ?? 200 }) });
    const rows = route.liveHere();
    expect(rows.map((row) => [row.session, row.host, row.taggable])).toEqual(expect.arrayContaining([[THREAD, "codex", true], ["ses_claude_here", "claude-code", expect.any(Boolean)]]));
    // A cloud agent paired here, listed while this Inbox has a wake for it.
    live.pinCloud(CLOUD, root, "Nightly fixer", "cloud-other");
    const withWake = createInboxTagsRoute({ store, serverSession: "srv", live, json: (body) => Response.json(body), wokenHere: (session) => session === CLOUD });
    expect(withWake.liveHere().map((row) => row.session)).toContain(CLOUD);
  });
});
