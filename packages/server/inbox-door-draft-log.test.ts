/**
 * The reply draft's save and Discard through the device door (inbox-devices.ts `claim`, `carries: "draft"`), in
 * process: the window's handler is the real draft routes (inbox-reply-drafts.ts) on a real store in a temp folder.
 * What regresses: a linked machine's draft save (each pause in typing), a Discard or either's conflict written to the
 * door's command log (inbox/device-commands.jsonl), which is appended to and never compacted, so the person's words
 * stay there after they Discard or Send; a Discard taken without naming its version (`base`); a save under the key the
 * draft was last saved with written again, or told to the windows again, instead of answered by the store
 * (`last_key`); other door routes no longer recorded and replayed. No Inbox.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_DEVICE_COMMANDS_FILE } from "@plannotator/shared/inbox/devices";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxDevices } from "./inbox-devices";
import { createInboxReplyDrafts } from "./inbox-reply-drafts";

type Json = Record<string, any>;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function door() {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-door-draft-log-"));
  roots.push(dataDir);
  const store = InboxStore.open(join(dataDir, "store"));
  const project = store.ensureProject({ name: "billing-svc", root: join(dataDir, "billing-svc") });
  const thread = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: null }, body: "Retry the webhook?", thread: "refunds" }).message.thread_id;
  const told: string[] = [];
  const drafts = createInboxReplyDrafts({ store, serverSession: "0".repeat(32), readBody: async (req) => (await req.json()) as Record<string, unknown>, json: (body, status = 200) => Response.json(body, { status }), onChange: (threadId) => told.push(threadId) });
  const handed: string[] = [];
  const devices = createInboxDevices({
    dataDir,
    serverSession: "0".repeat(32),
    port: () => 1,
    registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    dispatch: async (req) => {
      const url = new URL(req.url);
      handed.push(url.pathname);
      try {
        return (await drafts.route(req, url)) ?? Response.json({ ok: true }, { status: 200 });
      } catch (error) {
        // As the Inbox answers a store's refusal (inbox.ts ERROR_STATUS): a conflict is 409 with the draft there.
        if (!(error instanceof InboxError)) throw error;
        return Response.json({ error: error.message, code: error.code, ...error.details }, { status: error.code === "draft_conflict" ? 409 : 400 });
      }
    },
  });
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const machine = (await (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ name: "MacBook", platform: "machine", secret: devices.machineDoor.openMachineOffer().secret }) }), pairUrl)).json()) as Json;
  const post = async (route: string, body: Json) => {
    const url = new URL(`http://127.0.0.1/api/inbox/device/${route}`);
    const answer = await devices.door(new Request(url, { method: "POST", headers: { Authorization: `Bearer ${machine.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), url);
    return { status: answer.status, body: (await answer.json()) as Json, replayed: answer.headers.get("Idempotent-Replayed") };
  };
  const logFile = join(inboxDir(dataDir), INBOX_DEVICE_COMMANDS_FILE);
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
  const lines = () => log().split("\n").filter(Boolean);
  return { store, storeRoot: join(dataDir, "store"), thread, handed, told, post, log, lines };
}

const ops = { files_add: [], files_remove: [], files_place: [] };

describe("the reply draft through the door keeps no words in the command log", () => {
  test("autosaves, a save's conflict, a Discard and a Discard's conflict: no draft words in the log, and it does not grow per save", async () => {
    const d = await door();
    const secret = "Charlie's refund for the March invoice";
    let base: string | null = null;
    let saved = "";
    for (let i = 1; i <= 5; i++) {
      const words = `${secret}, take ${i}`;
      const answer = await d.post(`threads/${d.thread}/draft`, { idempotency_key: `save-${i}`, body: words, base, base_body: saved || null, ...ops });
      expect(answer.status).toBe(200);
      expect(answer.body.draft.body).toBe(words);
      base = answer.body.draft.updated_at;
      saved = words;
    }
    // A save a step behind: its conflict answers with the draft there, words and all.
    const behind = await d.post(`threads/${d.thread}/draft`, { idempotency_key: "save-behind", body: "Older words", base: null, base_body: null, ...ops });
    expect([behind.status, behind.body.code, behind.body.draft.body]).toEqual([409, "draft_conflict", saved]);
    // A Discard naming an older version: refused with the draft there.
    const stale = await d.post(`threads/${d.thread}/draft/delete`, { idempotency_key: "discard-stale", base: "2000-01-01T00:00:00.000Z" });
    expect([stale.status, stale.body.draft.body]).toEqual([409, saved]);
    expect(d.lines()).toEqual([]);
    // A Discard that names no version is refused before it reaches the draft: a replay of it could delete words typed since.
    const bare = await d.post(`threads/${d.thread}/draft/delete`, { idempotency_key: "discard-bare" });
    expect([bare.status, bare.body.field]).toEqual([422, "base"]);
    expect(d.store.replyDraft(d.thread)?.body).toBe(saved);
    // The Discard of the version shown: nothing kept. Again under its key, it is the compare-and-set again: gone already.
    const discard = await d.post(`threads/${d.thread}/draft/delete`, { idempotency_key: "discard", base });
    expect([discard.status, discard.body]).toEqual([200, { ok: true, deleted: true }]);
    const again = await d.post(`threads/${d.thread}/draft/delete`, { idempotency_key: "discard", base });
    expect([again.status, again.body, again.replayed]).toEqual([200, { ok: true, deleted: false }, null]);
    expect(d.store.replyDraft(d.thread)).toBeNull();
    expect(d.lines()).toEqual([]);
    // A replay after newer words were typed there: refused, and they stay.
    const newer = d.store.saveReplyDraft(d.thread, { body: "Typed there after the Discard", base: null })!;
    const late = await d.post(`threads/${d.thread}/draft/delete`, { idempotency_key: "discard", base });
    expect([late.status, late.body.draft?.body]).toEqual([409, newer.body]);
    expect(d.store.replyDraft(d.thread)?.body).toBe(newer.body);
    expect(d.log()).toBe("");
  });

  test("a save under the key the draft was last saved with is answered with the draft by the store: nothing written again, no window told", async () => {
    const d = await door();
    const first = await d.post(`threads/${d.thread}/draft`, { idempotency_key: "save-once", body: "Ship it after the deploy", base: null, base_body: null, ...ops });
    expect(first.status).toBe(200);
    expect(d.told).toEqual([d.thread]);
    const again = await d.post(`threads/${d.thread}/draft`, { idempotency_key: "save-once", body: "Ship it after the deploy", base: null, base_body: null, ...ops });
    expect([again.status, again.body.draft, again.replayed]).toEqual([200, first.body.draft, null]);
    expect(d.handed.filter((path) => path.endsWith("/draft")).length).toBe(2);
    expect(d.told).toEqual([d.thread]);
    expect(d.store.replyDraft(d.thread)).toEqual(first.body.draft);
    // Through a restart of that Inbox too: the key is on the draft's own file.
    const reopened = InboxStore.open(d.storeRoot);
    expect(reopened.saveReplyDraft(d.thread, { idempotency_key: "save-once", body: "Ship it after the deploy", base: null, ...ops })).toEqual(first.body.draft);
    expect(d.lines()).toEqual([]);
  });

  test("another door route is still recorded and replayed: applied once", async () => {
    const d = await door();
    const first = await d.post(`threads/${d.thread}/seen`, { idempotency_key: "seen-1" });
    expect(first.status).toBe(200);
    const again = await d.post(`threads/${d.thread}/seen`, { idempotency_key: "seen-1" });
    expect([again.status, again.replayed]).toEqual([200, "true"]);
    expect(d.handed.filter((path) => path.endsWith("/seen")).length).toBe(1);
    expect(d.lines().length).toBe(1);
  });
});
