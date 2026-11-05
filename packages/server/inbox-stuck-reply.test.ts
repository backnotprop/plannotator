/**
 * A reply whose session's wake was killed while it delivered it (the owner's ruling: never deliver twice, and let
 * the person move it to another session by hand). The claim the connection left stays, so that session never takes
 * the reply again; the Inbox stops reading it as on its way, and "Send to another session" moves it although the
 * session runs. A delivery still in flight keeps refusing the move. Proved on the Inbox's own pieces (store, live
 * sessions, the compose and sessions routes) with no server started; the claim folders are the ones the
 * connections write (`inboxClaimName`, the Claude Code mod's `claude-code-mod/<session>/inbox/claims/`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxClaimName, INBOX_TAGS_POLL_FIELD } from "@plannotator/shared/inbox/connection";
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
  const live = createInboxLiveSessions({ store, serverSession: SERVER, resolveRoot: async (path) => path });
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
    const response = await live.route(new Request(`http://127.0.0.1${path}?asker=${session}`), path, true);
    return ((await response!.json()) as { asker: { live: boolean; stuck?: string[] } }).asker;
  };
  return { store, project, live, poll, move, asker };
}

const PI_A = { host: "pi", session: "ses-a" };
const PI_B = { host: "pi", session: "ses-b" };

describe("a reply its session's wake took and never delivered", () => {
  test("Pi: a wake killed mid-delivery leaves it stuck; once the session's next wake polls, the reply moves by hand and is never handed to that session again", async () => {
    const w = world();
    await w.poll("ses-a", "pi", Date.now() - 60_000);
    await w.poll("ses-b", "pi", Date.now() - 60_000);
    const sent = w.store.startPersonThread({ project_id: w.project.id, body: "Rotate the staging keys.", to: PI_A, idempotency_key: "k1" }).message;
    // The wake of ses-a claims it (InboxWake's mkdir), and is killed before it delivers or reports.
    const claim = join(w.store.dir, "claims", inboxClaimName(sent.id, "ses-a"));
    mkdirSync(claim, { recursive: true });
    // Pi comes back as the same session: a new wake, started after the claim, polls. It settles the claim it
    // finds and never delivers it, while the Inbox keeps handing it out.
    await Bun.sleep(5);
    await w.poll("ses-a", "pi", Date.now());
    expect(w.store.pendingReplies("ses-a").map((m) => m.id)).toEqual([sent.id]);

    // The Inbox no longer says it is on its way to that session.
    const row = w.store.listRow(sent.thread_id)!;
    expect(row.delivery).toMatchObject({ state: "undelivered", reason: "stuck" });
    expect(await w.asker(sent.thread_id, "ses-a")).toMatchObject({ live: true, stuck: [sent.id] });

    // Nothing redelivered it meanwhile, and the person moves it although ses-a runs.
    expect(w.store.message(sent.id)!.delivery ?? null).toBeNull();
    expect(await w.move(sent.id, PI_B)).toBe("ok");
    expect(w.store.message(sent.id)!.to).toEqual(PI_B);
    // Only the session it moved to is handed it; ses-a never is again, and its claim still stands.
    expect(w.store.pendingReplies("ses-a")).toEqual([]);
    expect(w.store.pendingReplies("ses-b").map((m) => m.id)).toEqual([sent.id]);
    expect(existsSync(claim)).toBe(true);
    w.store.recordDelivery(sent.id, PI_B);
    expect(w.store.pendingReplies("ses-b")).toEqual([]);
    expect(w.store.listRow(sent.thread_id)!.delivery).toMatchObject({ state: "delivered" });
  });

  test("a plain reply the Claude Code mod claimed, whose claimant stopped renewing it, moves off its live asker", async () => {
    const w = world();
    await w.poll("ses-cc", "claude-code", Date.now() - 120_000);
    await w.poll("ses-b", "pi", Date.now() - 60_000);
    const asked = w.store.sendMessage({ project_id: w.project.id, author: { kind: "agent", host: "claude-code", session: "ses-cc", name: null }, body: "CSV or Parquet?", wakes: true }).message;
    const reply = w.store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "r1" }).reply!;
    const claim = join(w.store.dir, "..", "claude-code-mod", "ses-cc", "inbox", "claims", reply.id);
    mkdirSync(claim, { recursive: true });
    writeFileSync(join(claim, "by"), "instance-1");
    // Its claimant's last `alive` is older than the mod's 60 s: the process that took it quit.
    writeFileSync(join(claim, "alive"), String(Date.now() - 61_000));

    expect(w.store.listRow(asked.thread_id)!.delivery).toMatchObject({ state: "undelivered", reason: "stuck" });
    expect(await w.asker(asked.thread_id, "ses-cc")).toMatchObject({ live: true, stuck: [reply.id] });
    expect(await w.move(reply.id, PI_B)).toBe("ok");
    expect(w.store.pendingReplies("ses-cc")).toEqual([]);
    expect(w.store.pendingReplies("ses-b").map((m) => m.id)).toEqual([reply.id]);
  });

  test("a delivery still in flight keeps refusing the move, and the Inbox still says it is on its way", async () => {
    const w = world();
    await w.poll("ses-a", "pi", Date.now() - 60_000);
    await w.poll("ses-cc", "claude-code", Date.now() - 60_000);
    await w.poll("ses-b", "pi", Date.now() - 60_000);
    // Pi: the wake polling now made the claim, and is delivering.
    const toPi = w.store.startPersonThread({ project_id: w.project.id, body: "Rotate the staging keys.", to: PI_A, idempotency_key: "k1" }).message;
    mkdirSync(join(w.store.dir, "claims", inboxClaimName(toPi.id, "ses-a")), { recursive: true });
    // The mod: its claimant renewed `alive` a moment ago.
    const toCc = w.store.startPersonThread({ project_id: w.project.id, body: "Bump the lockfile.", to: { host: "claude-code", session: "ses-cc" }, idempotency_key: "k2" }).message;
    const ccClaim = join(w.store.dir, "..", "claude-code-mod", "ses-cc", "inbox", "claims", toCc.id);
    mkdirSync(ccClaim, { recursive: true });
    writeFileSync(join(ccClaim, "alive"), String(Date.now() - 5_000));

    for (const [sent, session] of [
      [toPi, "ses-a"],
      [toCc, "ses-cc"],
    ] as const) {
      expect(w.store.listRow(sent.thread_id)!.delivery?.reason).not.toBe("stuck");
      expect((await w.asker(sent.thread_id, session)).stuck).toBeUndefined();
      expect(await w.move(sent.id, PI_B)).toBe("session_still_live");
      expect(w.store.message(sent.id)!.to?.session).toBe(session);
    }
    // Delivered under its claim: never stuck, whatever its age.
    writeFileSync(join(ccClaim, "alive"), String(Date.now() - 120_000));
    writeFileSync(join(ccClaim, "delivered"), String(Date.now()));
    expect(await w.move(toCc.id, PI_B)).toBe("session_still_live");
  });
});
