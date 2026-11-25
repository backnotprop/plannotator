/**
 * Decision mode's reasons for a linked computer's thread, kept on this Inbox (inbox-comment-drafts.ts): no Inbox
 * starts; the route runs against a stand-in store in a temp folder. What regresses: a reason for a far thread refused
 * (it used to go through the append-only outbox to that computer); two saves leaving two copies, not one overwritten;
 * a computer that is not linked, or a key that is not a reason, taking a draft for a thread this Inbox does not hold;
 * the upload sweep deleting a far reason because its thread is not in this store.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxCommentDraftUploadIds } from "@plannotator/shared/inbox/comment-drafts";
import { createInboxCommentDrafts } from "./inbox-comment-drafts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-reasons-")));
const LAPTOP = "ibx_01JZ0000000000000000000000";
const STRANGER = "ibx_01JZ1111111111111111111111";
const FAR = "msg_01JZ2222222222222222222222";
const KEY = "decision-reason:msg_01JZ3333333333333333333333/a-1b2c3d4e";

const drafts = createInboxCommentDrafts({
  store: { dir, thread: () => null } as unknown as InboxStore,
  serverSession: "s1",
  readBody: (req) => req.json() as Promise<Record<string, unknown>>,
  json: (body, status = 200) => Response.json(body, { status }),
  linked: (machine) => machine === LAPTOP,
});
const url = (search = "") => new URL(`http://127.0.0.1/api/inbox/threads/${FAR}/comment-draft${search}`);
const save = async (body: Record<string, unknown>) => (await drafts.route(new Request(url(), { method: "POST", body: JSON.stringify(body) }), url()))!;
const read = async (machine: string, key = KEY) => {
  const at = url(`?key=${encodeURIComponent(key)}&machine=${machine}`);
  return (await drafts.route(new Request(at), at))!;
};

test("a reason for a linked computer's thread is this Inbox's draft, overwritten on each save, and read back", async () => {
  expect((await save({ key: KEY, text: "Bob Tully holds the key", images: [], base: null, force: true, machine: LAPTOP })).status).toBe(200);
  expect((await save({ key: KEY, text: "Blocked until Friday", images: [], base: null, force: true, machine: LAPTOP })).status).toBe(200);
  expect(((await (await read(LAPTOP)).json()) as { draft: { text: string } }).draft.text).toBe("Blocked until Friday");
  expect(readdirSync(join(dir, "comment-drafts"))).toHaveLength(1);
  // The upload sweep keeps it: its thread is on Laptop, not in this store.
  inboxCommentDraftUploadIds(dir, () => false);
  expect(readdirSync(join(dir, "comment-drafts"))).toHaveLength(1);
});

test("a computer that is not linked, a key that is not a reason, or no computer: no thread here", async () => {
  expect((await save({ key: KEY, text: "x", images: [], base: null, force: true, machine: STRANGER })).status).toBe(404);
  expect((await save({ key: "global-comment", text: "x", images: [], base: null, force: true, machine: LAPTOP })).status).toBe(404);
  expect((await save({ key: KEY, text: "x", images: [], base: null, force: true })).status).toBe(404);
  expect((await read(STRANGER)).status).toBe(404);
  expect((await read(LAPTOP, "global-comment")).status).toBe(404);
});
