/**
 * A reply whose session's wake was killed while it delivered it (the owner's ruling: never deliver twice, and let
 * the person move it to another session by hand). The claim the connection left stays, so that session never takes
 * the reply again; the Inbox stops reading it as on its way, and "Send to another session" moves it although the
 * session runs. A delivery still in flight keeps refusing the move. Proved on the Inbox's own pieces (store, live
 * sessions, the compose and sessions routes) with no server started; the claim folders are the ones the
 * connections write (`inboxClaimName`, the Claude Code mod's `claude-code-mod/<session>/inbox/claims/`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BRIDGE_POLL_PATH, inboxClaimName, INBOX_TAGS_POLL_FIELD } from "@plannotator/shared/inbox/connection";
import { InboxAgentConnection, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxCompose } from "./inbox-compose";
import { createInboxLiveSessions } from "./inbox-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SERVER = "srv-stuck";

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-stuck-")));
  roots.push(root);
  const projectDir = join(root, "ledger");
  mkdirSync(projectDir, { recursive: true });
  const store = InboxStore.open(join(root, "data", "inbox"));
  const project = store.ensureProject({ name: "ledger", root: projectDir });
  // The Inbox's clock: `later(ms)` moves it on, so a session that stops polling reads as gone.
  let offset = 0;
  const later = (ms: number) => void (offset += ms);
  const live = createInboxLiveSessions({ store, serverSession: SERVER, resolveRoot: async (path) => path, now: () => Date.now() + offset });
  // The rows read the sessions as the server wires them (inbox.ts `setDeliveryPresence`).
  store.setDeliveryPresence({ connection: live.deliveryConnectionOf, askerLive: live.askerLive, hostOf: live.hostOf, stuck: live.stuck });
  const compose = createInboxCompose({
    store,
    serverSession: SERVER,
    live,
    resolveProject: async () => project,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
  });
  /** One poll of a session's wake, answered at once. */
  const poll = async (session: string, host: string, startedAt: number) => {
    const answered = await live.pollStarted(session, host, { project_path: projectDir, started_at: startedAt, [INBOX_TAGS_POLL_FIELD]: true });
    answered();
  };
  /** Send to another session: the code it is refused with, or "ok". */
  const move = async (messageId: string, to: { host: string; session: string }) => {
    const url = new URL(`http://127.0.0.1/api/inbox/messages/${messageId}/to`);
    const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: SERVER, to }) });
    try {
      const response = await compose.route(req, url, true);
      return response?.status === 200 ? "ok" : `status ${response?.status}`;
    } catch (error) {
      if (error instanceof InboxError) return error.code;
      throw error;
    }
  };
  /** The thread window's read of the session a reply waits on (`?asker=`). */
  const asker = async (threadId: string, session: string) => {
    const path = `/api/inbox/threads/${threadId}/sessions`;
    const response = await live.route(new Request(`http://127.0.0.1${path}?asker=${session}`), path);
    return ((await response!.json()) as { asker: { live: boolean; stuck?: string[] } }).asker;
  };
  /** A Pi wake's claim on a reply (`InboxWake`): named for the session, or an older version's by the reply id alone. */
  const piClaim = (replyId: string, session: string, files: Record<string, string> = {}, name = inboxClaimName(replyId, session)) => {
    const dir = join(store.dir, "claims", name);
    mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return dir;
  };
  /** The Claude Code mod's claim on a reply. */
  const modClaim = (replyId: string, session: string, files: Record<string, string>) => {
    const dir = join(store.dir, "..", "claude-code-mod", session, "inbox", "claims", replyId);
    mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return dir;
  };
  const sendTo = (to: { host: string; session: string }, key: string) =>
    store.startPersonThread({ project_id: project.id, body: `Rotate the staging keys (${key}).`, to, idempotency_key: key }).message;
  /** Whether the row and the thread's read say stuck, and where a move to `to` gets. */
  const reading = async (sent: { id: string; thread_id: string }, session: string) => ({
    row: store.listRow(sent.thread_id)!.delivery?.reason === "stuck",
    thread: ((await asker(sent.thread_id, session)).stuck ?? []).includes(sent.id),
  });
  /**
   * A real Pi wake (`InboxWake`) of `session`, its bridge answered by these live sessions and this store with no
   * server: its polls say its `started_at`, and its `deliver` never returns (the wake is killed mid-delivery).
   */
  const piWake = (session: string) => {
    const connection = new (class extends InboxAgentConnection {
      override async bridge(path: string, from: string, body: Record<string, unknown>) {
        if (path !== INBOX_BRIDGE_POLL_PATH) return { status: 200, text: "{}" };
        (await live.pollStarted(from, "pi", { ...body, project_path: projectDir }))();
        const commands = store.pendingReplies(from).map((m) => ({ type: "reply", id: m.id, thread_id: m.thread_id, body: m.body }));
        return { status: 200, text: JSON.stringify({ commands }) };
      }
    })({ dataDir: join(store.dir, ".."), host: "pi", agentName: "Pi", tools: [] });
    let delivering = false;
    const wake = new InboxWake(connection, session, { isBusy: () => false, deliver: () => ((delivering = true), new Promise<void>(() => {})), notify: () => {} }, 10);
    wake.start();
    return { wake, delivering: () => delivering };
  };
  return { store, project, live, later, poll, move, asker, piClaim, modClaim, sendTo, reading, piWake };
}

const PI_A = { host: "pi", session: "ses-a" };
const PI_B = { host: "pi", session: "ses-b" };
const CC = { host: "claude-code", session: "ses-cc" };
/** A pid no process has: one that ran and exited. */
const deadPid = () => spawnSync("/usr/bin/true").pid!;
/** Set when a claim folder reads as made (its mtime), so a test never leans on the filesystem's clock. */
const madeAt = (dir: string, ms: number) => utimesSync(dir, ms / 1000, ms / 1000);

describe("a reply its session's wake took and never delivered", () => {
  test("Pi, an older wake with no pid: killed mid-delivery, it is stuck once the session's next wake polls; the reply moves by hand and that session is never handed it again", async () => {
    const w = world();
    await w.poll("ses-a", "pi", Date.now() - 60_000);
    await w.poll("ses-b", "pi", Date.now() - 60_000);
    const sent = w.sendTo(PI_A, "k1");
    const claim = w.piClaim(sent.id, "ses-a");
    // The wake polling now made the claim: it may still be delivering.
    expect(await w.reading(sent, "ses-a")).toEqual({ row: false, thread: false });
    // Pi comes back as the same session: a new wake, started a second after the claim, polls. It settles the
    // claim it finds and never delivers it, while the Inbox keeps handing it out.
    const restarted = Date.now();
    madeAt(claim, restarted - 1_000);
    await w.poll("ses-a", "pi", restarted);
    expect(w.store.pendingReplies("ses-a").map((m) => m.id)).toEqual([sent.id]);
    expect(w.store.listRow(sent.thread_id)!.delivery).toMatchObject({ state: "undelivered", reason: "stuck" });
    expect(await w.asker(sent.thread_id, "ses-a")).toMatchObject({ live: true, stuck: [sent.id] });

    // Nothing redelivered it meanwhile, and the person moves it although ses-a runs.
    expect(w.store.message(sent.id)!.delivery ?? null).toBeNull();
    expect(await w.move(sent.id, PI_B)).toBe("ok");
    expect(w.store.message(sent.id)!.to).toEqual(PI_B);
    // Only the session it moved to is handed it; ses-a never is again.
    expect(w.store.pendingReplies("ses-a")).toEqual([]);
    expect(w.store.pendingReplies("ses-b").map((m) => m.id)).toEqual([sent.id]);
    w.store.recordDelivery(sent.id, PI_B);
    expect(w.store.pendingReplies("ses-b")).toEqual([]);
    expect(w.store.listRow(sent.thread_id)!.delivery).toMatchObject({ state: "delivered" });
  });

  test("Pi, a wake that names its pid: stuck exactly when that process is gone, whichever wake of the session polls now", async () => {
    const w = world();
    await w.poll("ses-a", "pi", Date.now() - 60_000);
    await w.poll("ses-b", "pi", Date.now() - 60_000);
    // Another process of ses-a (a second `pi --resume`, or a /reload) still delivers it: a newer wake polling
    // does not make it stuck while the claimant runs.
    const held = w.sendTo(PI_A, "held");
    w.piClaim(held.id, "ses-a", { by: "wake-1", pid: String(process.pid) });
    await Bun.sleep(5);
    await w.poll("ses-a", "pi", Date.now());
    expect(await w.reading(held, "ses-a")).toEqual({ row: false, thread: false });
    expect(await w.move(held.id, PI_B)).toBe("session_still_live");
    // Its claimant's process is gone: stuck, though a wake that started before the claim still polls.
    const gone = w.sendTo(PI_A, "gone");
    w.piClaim(gone.id, "ses-a", { by: "wake-2", pid: String(deadPid()) });
    await w.poll("ses-a", "pi", Date.now() - 60_000);
    expect(await w.reading(gone, "ses-a")).toEqual({ row: true, thread: true });
    expect(await w.move(gone.id, PI_B)).toBe("ok");
  });

  test("Pi, a real wake: its claim names its process, so a newer wake of the session does not make the reply stuck while that process runs", async () => {
    const w = world();
    await w.poll("ses-b", "pi", Date.now() - 60_000);
    const sent = w.sendTo(PI_A, "real");
    const first = w.piWake("ses-a");
    const claim = join(w.store.dir, "claims", inboxClaimName(sent.id, "ses-a"));
    for (let i = 0; i < 200 && !first.delivering(); i++) await Bun.sleep(10);
    expect(first.delivering()).toBe(true);
    expect(readFileSync(join(claim, "pid"), "utf8")).toBe(String(process.pid));
    first.wake.dispose();
    // Another wake of ses-a (a /reload, a second process) polls, started after the claim.
    await Bun.sleep(5);
    const second = w.piWake("ses-a");
    for (let i = 0; i < 50; i++) await Bun.sleep(10);
    second.wake.dispose();
    expect(second.delivering()).toBe(false);
    expect(await w.reading(sent, "ses-a")).toEqual({ row: false, thread: false });
    expect(await w.move(sent.id, PI_B)).toBe("session_still_live");
    // That process is gone: the reply is stuck, and moves.
    writeFileSync(join(claim, "pid"), String(deadPid()));
    expect(await w.reading(sent, "ses-a")).toEqual({ row: true, thread: true });
    expect(await w.move(sent.id, PI_B)).toBe("ok");
  });

  test("Pi: a claim the connection reported, an older version's claim by the reply id alone, and a claim of a session that is gone are each stuck", async () => {
    const w = world();
    const started = Date.now() - 60_000;
    await w.poll("ses-a", "pi", started);
    // `reported` (its deliver failed), the session running, its wake the one that claimed it.
    const reported = w.sendTo(PI_A, "reported");
    w.piClaim(reported.id, "ses-a", { reported: "1" });
    expect(await w.reading(reported, "ses-a")).toEqual({ row: true, thread: true });
    // An older version's claim (`claims/<reply id>`), made before the wake polling now started.
    const legacy = w.sendTo(PI_A, "legacy");
    const restarted = Date.now();
    madeAt(w.piClaim(legacy.id, "ses-a", {}, legacy.id), restarted - 1_000);
    await w.poll("ses-a", "pi", restarted);
    expect(await w.reading(legacy, "ses-a")).toEqual({ row: true, thread: true });
    // The wake that claimed it is the last one the session had, and the session stops polling. It claimed it just
    // after it started, and the folder's time reads a few ms earlier (Linux's coarse file clock): still its own claim.
    const last = w.sendTo(PI_A, "last");
    madeAt(w.piClaim(last.id, "ses-a"), restarted - 8);
    expect(await w.reading(last, "ses-a")).toEqual({ row: false, thread: false });
    w.later(120_000);
    await w.poll("ses-b", "pi", Date.now());
    expect(await w.reading(last, "ses-a")).toEqual({ row: true, thread: true });
    expect(await w.move(last.id, PI_B)).toBe("ok");
  });

  test("the Claude Code mod: while the session runs only `reported` makes a claim stuck, however old its `alive`; once the session is gone, the old `alive` does", async () => {
    const w = world();
    await w.poll("ses-cc", "claude-code", Date.now() - 120_000);
    await w.poll("ses-b", "pi", Date.now() - 60_000);
    const asked = w.store.sendMessage({ project_id: w.project.id, author: { kind: "agent", host: "claude-code", session: "ses-cc", name: null }, body: "CSV or Parquet?", wakes: true }).message;
    const reply = w.store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "r1" }).reply!;
    // Its claimant paused (Ctrl-Z, a slow tick): `alive` is past the mod's 60 s, but the session runs.
    const claim = w.modClaim(reply.id, "ses-cc", { by: "instance-1", alive: String(Date.now() - 61_000) });
    expect(await w.reading({ id: reply.id, thread_id: asked.thread_id }, "ses-cc")).toEqual({ row: false, thread: false });
    expect(await w.move(reply.id, PI_B)).toBe("session_still_live");
    // Another process of the session saw it quit and reported it.
    writeFileSync(join(claim, "reported"), "1");
    expect(w.store.listRow(asked.thread_id)!.delivery).toMatchObject({ state: "undelivered", reason: "stuck" });
    expect(await w.asker(asked.thread_id, "ses-cc")).toMatchObject({ live: true, stuck: [reply.id] });
    expect(await w.move(reply.id, PI_B)).toBe("ok");
    expect(w.store.pendingReplies("ses-cc")).toEqual([]);
    expect(w.store.pendingReplies("ses-b").map((m) => m.id)).toEqual([reply.id]);

    // No process of the session is left to report it: the session gone, `alive` is the only word.
    const toCc = w.sendTo(CC, "cc-gone");
    w.modClaim(toCc.id, "ses-cc", { by: "instance-2", alive: String(Date.now()) });
    w.later(120_000);
    await w.poll("ses-b", "pi", Date.now());
    expect(await w.reading(toCc, "ses-cc")).toEqual({ row: true, thread: true });
  });

  test("a delivery still in flight keeps refusing the move, and the Inbox still says it is on its way", async () => {
    const w = world();
    await w.poll("ses-a", "pi", Date.now() - 60_000);
    await w.poll("ses-cc", "claude-code", Date.now() - 60_000);
    await w.poll("ses-b", "pi", Date.now() - 60_000);
    // Pi: the wake polling now made the claim, and is delivering.
    const toPi = w.sendTo(PI_A, "k1");
    w.piClaim(toPi.id, "ses-a", { by: "wake-1", pid: String(process.pid) });
    // The mod: its claimant renewed `alive` a moment ago.
    const toCc = w.sendTo(CC, "k2");
    const ccClaim = w.modClaim(toCc.id, "ses-cc", { alive: String(Date.now() - 5_000) });

    for (const [sent, session] of [
      [toPi, "ses-a"],
      [toCc, "ses-cc"],
    ] as const) {
      expect(await w.reading(sent, session)).toEqual({ row: false, thread: false });
      expect(await w.move(sent.id, PI_B)).toBe("session_still_live");
      expect(w.store.message(sent.id)!.to?.session).toBe(session);
    }
    // Delivered under its claim: never stuck, whatever else the claim says.
    writeFileSync(join(ccClaim, "reported"), "1");
    writeFileSync(join(ccClaim, "delivered"), String(Date.now()));
    expect(await w.move(toCc.id, PI_B)).toBe("session_still_live");
  });

  test("the thread's read names only the latest item the session owes", async () => {
    const w = world();
    await w.poll("ses-a", "pi", Date.now() - 60_000);
    await w.poll("ses-b", "pi", Date.now() - 60_000);
    const sent = w.sendTo(PI_A, "k1");
    w.piClaim(sent.id, "ses-a", { reported: "1" });
    expect((await w.asker(sent.thread_id, "ses-a")).stuck).toEqual([sent.id]);
    // Moved away, ses-a's leftover claim says nothing about it any more.
    expect(await w.move(sent.id, PI_B)).toBe("ok");
    expect((await w.asker(sent.thread_id, "ses-a")).stuck).toBeUndefined();
  });
});
