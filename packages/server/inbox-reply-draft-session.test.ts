/**
 * The reply draft route's session rule: a page left open across a restart or an update of the SAME Inbox (its session
 * is one of this data folder's earlier runs, `follows`) keeps saving reply drafts, so what the person types is never
 * refused for the page's age; the save is a compare-and-set on the draft's own `updated_at`. Discard from such a page,
 * and any write from a page another Inbox served, are refused as before. The route alone, over a stand-in store: no
 * Inbox runs.
 */
import { describe, expect, test } from "bun:test";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxReplyDraft } from "@plannotator/core/inbox-types";
import { createInboxReplyDrafts } from "./inbox-reply-drafts";

const THREAD = "msg_01M6RF0000000000000000001";

function routeWith(follows?: readonly string[]) {
  const drafts = new Map<string, InboxReplyDraft>();
  const store = {
    thread: (id: string) => (id === THREAD ? { thread_id: id } : null),
    replyDraft: (id: string) => drafts.get(id) ?? null,
    // No save here is sent again under its key (a linked machine's replay, inbox-door-draft-log.test.ts).
    replyDraftSavedBy: () => null,
    saveReplyDraft: (id: string, body: Record<string, unknown>) => {
      const draft: InboxReplyDraft = { v: 1, thread_id: id, body: String(body.body), created_at: "2026-11-24T10:00:00.000Z", updated_at: "2026-11-24T10:00:01.000Z" };
      drafts.set(id, draft);
      return draft;
    },
    deleteReplyDraft: (id: string) => drafts.delete(id),
  } as unknown as InboxStore;
  const { route } = createInboxReplyDrafts({
    store,
    serverSession: "run-now",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    ...(follows ? { follows } : {}),
  });
  const post = async (path: string, body: Record<string, unknown>) => {
    const url = new URL(`http://127.0.0.1/api/inbox/threads/${THREAD}${path}`);
    const answer = (await route(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), url))!;
    return { status: answer.status, json: (await answer.json()) as { code?: string; draft?: InboxReplyDraft | null } };
  };
  return { drafts, post };
}

describe("reply draft saves from a page an earlier run served", () => {
  test("a page from an earlier run of this data folder saves its draft", async () => {
    const { drafts, post } = routeWith(["run-before-update", "run-before-that"]);
    const saved = await post("/draft", { serverSession: "run-before-update", body: "Typed after the update.", base: null });
    expect(saved.status).toBe(200);
    expect(drafts.get(THREAD)?.body).toBe("Typed after the update.");
    expect((await post("/draft", { serverSession: "run-before-that", body: "And again.", base: null })).status).toBe(200);
  });

  test("a page another Inbox served is refused, and nothing is saved", async () => {
    const { drafts, post } = routeWith(["run-before-update"]);
    const refused = await post("/draft", { serverSession: "another-inbox", body: "Not this Inbox's page.", base: null });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("session_mismatch");
    expect(drafts.has(THREAD)).toBe(false);
  });

  test("no earlier runs (a copied or new data folder): another session is refused", async () => {
    const { post } = routeWith();
    expect((await post("/draft", { serverSession: "run-before-update", body: "Words.", base: null })).status).toBe(409);
  });

  test("Discard from an earlier run's page is still refused: only the save, a compare-and-set, is let through", async () => {
    const { drafts, post } = routeWith(["run-before-update"]);
    expect((await post("/draft", { serverSession: "run-now", body: "Kept.", base: null })).status).toBe(200);
    const discard = await post("/draft/delete", { serverSession: "run-before-update" });
    expect(discard.status).toBe(409);
    expect(drafts.get(THREAD)?.body).toBe("Kept.");
  });

  test("this run's own page saves and discards as ever", async () => {
    const { drafts, post } = routeWith(["run-before-update"]);
    expect((await post("/draft", { serverSession: "run-now", body: "Mine.", base: null })).status).toBe(200);
    expect((await post("/draft/delete", { serverSession: "run-now" })).status).toBe(200);
    expect(drafts.has(THREAD)).toBe(false);
  });
});
