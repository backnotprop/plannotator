/**
 * The threads a reply draft mentions (approval "inbox-drag-threads", piece 1), kept with the draft on the Inbox, so
 * every device and window reading the draft has them. What regresses: mentions lost on the way to disk or back, a
 * save from a window that never knew them dropping them, a mention kept over words it no longer stands on, a Send
 * that leaves its draft behind because its words carry the mentions, and Take back losing them. No Inbox is started:
 * the store over a temp folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxThreadMentionWords } from "@plannotator/core/inbox-thread-mention";
import type { InboxAuthor, InboxReplyMention } from "@plannotator/core/inbox-types";
import { createInboxTakeBack } from "./inbox-take-back";
import { InboxStore } from "@plannotator/shared/inbox/store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "pi", session: "ses_a", name: null };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-reply-draft-mentions-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "CSV or Parquet?", wakes: true }).message;
  const other = store.sendMessage({ project_id: project.id, author: AGENT, body: "Flaky login test on CI", wakes: false }).message;
  return { dir, store, thread: asked.thread_id, asked, other: other.thread_id };
}

const mentionOf = (thread: string, body: string, label: string): InboxReplyMention => ({ thread_id: thread, title: label, label, at: body.indexOf(label) });

describe("a reply draft carries its mentions", () => {
  test("saved with the draft and read back by another window (the store opened again)", () => {
    const { dir, store, thread, other } = setup();
    const body = "Same cause as Flaky login test on CI, I think.";
    const saved = store.saveReplyDraft(thread, { body, base: null, mentions: [mentionOf(other, body, "Flaky login test on CI")] })!;
    expect(saved.mentions?.map((m) => [m.thread_id, m.at])).toEqual([[other, 14]]);
    expect(InboxStore.open(dir).replyDraft(thread)?.mentions?.map((m) => [m.thread_id, m.at])).toEqual([[other, 14]]);
  });

  test("a save that names none keeps the draft's own, moved with the words; one the edit touched ends", () => {
    const { store, thread, other } = setup();
    const body = "Same cause as Flaky login test on CI.";
    const first = store.saveReplyDraft(thread, { body, base: null, mentions: [mentionOf(other, body, "Flaky login test on CI")] })!;
    const moved = store.saveReplyDraft(thread, { body: `Yes. ${body}`, base: first.updated_at })!;
    expect(moved.mentions?.map((m) => m.at)).toEqual([19]);
    const touched = store.saveReplyDraft(thread, { body: "Yes. Same cause as Flaky logn test on CI.", base: moved.updated_at })!;
    expect(touched.mentions).toBeUndefined();
  });

  test("a mention that does not stand where it says is dropped, never moved onto other words", () => {
    const { store, thread, other } = setup();
    const saved = store.saveReplyDraft(thread, { body: "Plain words about CI.", base: null, mentions: [{ thread_id: other, title: "CI", label: "CI", at: 0 }] })!;
    expect(saved.mentions).toBeUndefined();
    expect(saved.body).toBe("Plain words about CI.");
  });

  test("a Send naming no version clears the draft holding its words, though its words carry the mentions", () => {
    const { store, thread, other } = setup();
    const body = "Same cause as Flaky login test on CI.";
    const mention = mentionOf(other, body, "Flaky login test on CI");
    store.saveReplyDraft(thread, { body, base: null, mentions: [mention] });
    const words = inboxThreadMentionWords(body, [mention]);
    expect(words).not.toBe(body);
    expect(store.clearSentReplyDraft(thread, "", words)).toBe(true);
    expect(store.replyDraft(thread)).toBeNull();
  });

  test("Take back puts the words back with each mention its title again, still a mention", async () => {
    const { store, asked, other } = setup();
    const body = "Same cause as Flaky login test on CI.";
    const words = inboxThreadMentionWords(body, [mentionOf(other, body, "Flaky login test on CI")]);
    const reply = store.sendReply(asked.id, { words, idempotency_key: "k1" }).reply!;
    const takeBack = createInboxTakeBack({ store, serverSession: "s", readBody: async () => ({}), json: (value, status = 200) => Response.json(value, { status }) });
    const answer = await takeBack.route(new Request(`http://127.0.0.1/api/inbox/messages/${reply.id}/take-back`, { method: "POST" }), new URL(`http://127.0.0.1/api/inbox/messages/${reply.id}/take-back`));
    const draft = ((await answer!.json()) as { draft: { body: string; mentions?: InboxReplyMention[] } }).draft;
    expect(draft.body).toBe(body);
    expect(draft.mentions?.map((m) => [m.thread_id, m.at, m.label])).toEqual([[other, 14, "Flaky login test on CI"]]);
  });
});
