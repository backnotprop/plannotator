/**
 * A reply sent to a new session in place of the one that ended (inbox-reply-launch.ts), on a real launch engine and
 * store over a temp data dir, with the engine's fake host (tests/helpers/fake-launch-host.ts). The reply route runs
 * these same three steps (`prepare`, the store's `sendReply`, `settle`). What each test guards: the reply carries the
 * launch and takes the thread over, and the agent starts once, never again for a replayed or doubled Send; the new
 * session's first wake is the redirected and launched one; the thread's run line, its respawn and its owner follow the
 * reply's launch (the engine no longer reads launches off a thread's root alone); a start that fails keeps the reply,
 * on its placeholder, with the failed line; with the switch off nothing is prepared.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxLaunchedWakeOf } from "@plannotator/core/inbox-run-line";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import { createInboxReplyLaunch, replyLaunchRefusal } from "./inbox-reply-launch";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string) {
  const before = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-reply-launch-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "ledger");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  const config = (enabled: boolean) => writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled } }));
  config(true);
  const clock = { now: Date.parse("2026-11-15T18:00:00.000Z") };
  const store = InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "ledger", root: folder });
  const fake = fakeLaunchHost();
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    loginEnv: async () => ({ HOME: home, PATH: "" }),
    ownEnv: () => ({ HOME: home, PATH: "" }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    hosts: () => [fake.host],
    now: () => clock.now,
  });
  restore.push(() => launch.stop());
  /** The sessions the Inbox hears from now: none, so the session that asked has ended. */
  const liveSessions = new Set<string>();
  const replyLaunch = createInboxReplyLaunch({ store, launch, live: { askerLive: (session) => liveSessions.has(session) }, resolveProject: async () => project });
  // The ended session's question: it came through a waking connection, so it can be known to have ended.
  const asked = store.sendMessage({
    project_id: project.id,
    author: { kind: "agent", host: "claude-code", session: "ses-asker", name: "Claude Code" },
    body: "Retry policy for the nightly ledger sync: how many tries?",
    subject: "Retry policy for the nightly ledger sync",
    wakes: true,
    idempotency_key: "asked",
  }).message;
  /** The reply route's three steps, as inbox.ts runs them. */
  const send = async (key: string, words: string) => {
    const body = { idempotency_key: key, words, to: { launch: { agent: FAKE, project_id: project.id } } };
    const prepared = await replyLaunch.prepare(asked.id, body, null);
    const result = store.sendReply(asked.id, { words, idempotency_key: key, ...(prepared ? { to: prepared.to, launch: prepared.launch, took_over: true } : {}) });
    replyLaunch.settle(prepared, { message: result.reply, replayed: result.replayed });
    return result;
  };
  const post = (id: string, action: string) =>
    launch.route(
      new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv" }) }),
      `/api/inbox/launch/${id}/${action}`,
      "local",
    );
  return { store, clock, project, fake, launch, asked, send, post, config, replyLaunch, liveSessions };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

const starts = (calls: string[]) => calls.filter((call) => call.startsWith("start "));

describe("a reply sent to a new session when the asking one ended", () => {
  test("written with its launch on the placeholder, it takes the thread over, and the agent starts once, in the thread's name", async () => {
    const { store, fake, launch, asked, send } = setup();
    const { reply } = await send("k1", "Retry 3 times with backoff.");
    expect(reply.to!.session.startsWith("launch:")).toBe(true);
    expect(reply).toMatchObject({ took_over: true, reply_to: asked.id, launch: { agent: FAKE } });
    await until(() => store.message(reply.id)!.launch!.session_ref === "f1");
    expect(starts(fake.calls)).toEqual(["start Retry policy for the nightly ledger sync"]);
    const now = store.message(reply.id)!;
    expect(now.to).toEqual({ host: FAKE, session: "session-f1" });
    // The thread's run line follows the reply's launch, though its root was never launched.
    expect((await launch.runOf(asked.thread_id))!.state).toBe("starting");
    expect(launch.attachOf(asked.thread_id)).toBe("fake attach f1");
    // Its first wake: the redirected line (it was written to the ended session) and the launched lines.
    expect(store.redirectedFrom(now)).toMatchObject({ session: "ses-asker" });
    expect(inboxLaunchedWakeOf(now)).toEqual({ agent: FAKE, project: true });
    // The new session owns the thread: the next reply goes to it.
    expect(store.threadOwner(asked.thread_id)).toEqual({ host: FAKE, session: "session-f1" });
  });

  test("a replayed Send, or the same Send twice at once, starts no second agent", async () => {
    const { store, fake, asked, send } = setup();
    const [one, two] = await Promise.all([send("k1", "Retry 3 times."), send("k1", "Retry 3 times.")]);
    expect(two.reply.id).toBe(one.reply.id);
    await until(() => !!store.message(one.reply.id)!.launch!.session_ref);
    const again = await send("k1", "Retry 3 times.");
    expect(again).toMatchObject({ replayed: true, reply: { id: one.reply.id } });
    await Bun.sleep(30);
    expect(starts(fake.calls)).toHaveLength(1);
    expect(store.threadMessageIds(asked.thread_id)).toHaveLength(2);
  });

  test("the new session, stopped, is started again by the person's next reply, as a launched root's is", async () => {
    const { store, clock, fake, asked, send, post } = setup();
    const { reply } = await send("k1", "Retry 3 times.");
    await until(() => store.message(reply.id)!.launch!.session_ref === "f1");
    fake.poll("session-f1", false, clock.now);
    store.recordDelivery(reply.id, { host: FAKE, session: "session-f1" });
    const answer = store.sendMessage({ project_id: asked.project_id, author: { kind: "agent", host: FAKE, session: "session-f1", name: "Fake Agent" }, body: "Done.", reply_to: reply.id, idempotency_key: "answer" }).message;
    await post(reply.launch!.id, "stop");
    clock.now += 1_000;
    store.sendReply(answer.id, { words: "And the alert.", idempotency_key: "k2" });
    await until(() => fake.calls.includes("resume f1"));
  });

  test("the note that its questions moved never starts the stopped session again; the person's reply still does", async () => {
    const { store, clock, fake, asked, send, post } = setup();
    const { reply } = await send("k1", "Retry 3 times.");
    await until(() => store.message(reply.id)!.launch!.session_ref === "f1");
    fake.poll("session-f1", false, clock.now);
    store.recordDelivery(reply.id, { host: FAKE, session: "session-f1" });
    const ASK = [":::question", "Alert on the third failure?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
    const question = store.sendMessage({ project_id: asked.project_id, author: { kind: "agent", host: FAKE, session: "session-f1", name: "Fake Agent" }, body: ASK, reply_to: reply.id, idempotency_key: "ask" }).message;
    await post(reply.launch!.id, "stop");
    clock.now += 1_000;
    // An orchestrator moves the question into its brief and archives the thread: the stopped session gets the note.
    const orch = { kind: "agent" as const, host: "claude-code", session: "ses-orch", name: "Claude Code" };
    const brief = store.sendMessage({ project_id: asked.project_id, author: orch, subject: "Morning brief", body: ASK, idempotency_key: "brief" }).message;
    store.resolveThread(asked.thread_id, true, "agent", { to: brief.id, session: "ses-orch" });
    expect(store.pendingReplies("session-f1").some((m) => m.moved_note)).toBe(true);
    await Bun.sleep(50);
    expect(fake.calls).not.toContain("resume f1");
    // The person unarchives and answers there: that reply starts it again, as before.
    store.resolveThread(asked.thread_id, false, "person");
    store.sendReply(question.id, { words: "Yes, alert.", idempotency_key: "k2" });
    await until(() => fake.calls.includes("resume f1"));
  });

  test("a start that fails keeps the reply on its placeholder, with the failed line and Try again", async () => {
    const { store, fake, launch, asked, send } = setup();
    fake.faults.untrusted = true;
    const { reply } = await send("k1", "Retry 3 times.");
    await until(() => !!store.message(reply.id)!.launch!.error);
    const kept = store.message(reply.id)!;
    expect(kept.body).toContain("Retry 3 times.");
    expect(kept.to!.session).toBe(reply.to!.session);
    expect(await launch.runOf(asked.thread_id)).toMatchObject({ state: "failed", untrusted: true, cause: "The folder isn't trusted yet." });
    expect(launch.decorateLaunched(store.listRow(asked.thread_id)!).delivery).toMatchObject({ state: "undelivered" });
  });

  test("with starting agents off: refused in the switch's words, and nothing is written", async () => {
    const { store, asked, replyLaunch, config, project } = setup();
    config(false);
    await expect(replyLaunch.prepare(asked.id, { idempotency_key: "k1", words: "Go.", to: { launch: { agent: FAKE, project_id: project.id } } }, null)).rejects.toMatchObject({ code: "launch_off" });
    expect(store.threadMessageIds(asked.thread_id)).toHaveLength(1);
  });

  test("the session that asked is still there, or never wakes (MCP only): refused as still running, nothing written or started", async () => {
    const { store, fake, asked, replyLaunch, project, liveSessions } = setup();
    const body = { idempotency_key: "k1", words: "Go.", to: { launch: { agent: FAKE, project_id: project.id } } };
    liveSessions.add("ses-asker");
    await expect(replyLaunch.prepare(asked.id, body, null)).rejects.toMatchObject({ code: "session_still_live" });
    const mcp = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "cursor", session: "ses-mcp", name: "Cursor" }, body: "Which bucket?", idempotency_key: "mcp" }).message;
    await expect(replyLaunch.prepare(mcp.id, body, null)).rejects.toMatchObject({ code: "session_still_live" });
    expect(store.threadMessageIds(asked.thread_id)).toHaveLength(1);
    await Bun.sleep(20);
    expect(fake.calls).toEqual([]);
  });
});

describe("the order a reply's new session is refused in", () => {
  const codeOf = (input: Parameters<typeof replyLaunchRefusal>[0]) => replyLaunchRefusal(input)?.code ?? null;
  const there = { from: null, window: true };
  const bare = { from: null, window: false };

  test("a linked machine's call no press in its window made: window_only, before the switch and the asker", () => {
    expect(codeOf({ door: bare, switchOn: false, askerEnded: () => false })).toBe("window_only");
  });

  test("the switch off: launch_off, whether or not the asker ended, in the words for the machine that has it", () => {
    expect(codeOf({ door: null, switchOn: false, askerEnded: () => false })).toBe("launch_off");
    expect(replyLaunchRefusal({ door: null, switchOn: false, askerEnded: () => true })?.message).toBe("Starting agents from the Inbox is off. Turn it on in Settings → Agents.");
    expect(replyLaunchRefusal({ door: there, switchOn: false, askerEnded: () => true })?.message).toBe("Starting agents is off on that computer. Turn it on in its Settings → Agents.");
  });

  test("the asker still there: session_still_live; ended, nothing refuses", () => {
    expect(codeOf({ door: there, switchOn: true, askerEnded: () => false })).toBe("session_still_live");
    expect(codeOf({ door: null, switchOn: true, askerEnded: () => true })).toBeNull();
  });
});
