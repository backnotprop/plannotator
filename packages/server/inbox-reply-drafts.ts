/**
 * Plannotator Inbox: reply drafts (approval "inbox-reply-drafts"), the words
 * the person typed in a thread's reply box and did not send, kept per thread
 * so they survive leaving the thread, a reload and a restart. The window's
 * routes (same origin for every POST, as every window write; the page's
 * `serverSession`; another site's read refused):
 *
 *   GET  /api/inbox/threads/:id/draft          `{ draft }` (null when none)
 *   POST /api/inbox/threads/:id/draft          `{ body, base, files_add?, files_remove?, files_place? }`: save (a
 *                                              compare-and-set on `updated_at`; 409 `draft_conflict` with the
 *                                              newer draft); an empty body with no files deletes it
 *   POST /api/inbox/threads/:id/draft/delete   Discard
 *
 * The draft's files are every file in the box (paperclip, drop, paste), each a
 * pending upload, a long paste (approval "inbox-paste-attachment") with where
 * it goes back in the words (`pasted`). The window's save names its changes to
 * them (`files_add`, `files_remove`, `files_place`), applied to the draft's
 * files as they are, and then only different words refuse it. A save with a
 * list (`files`) instead: `all_files: true` says the list is all of them;
 * without it (an older page, which knew long pastes only) the draft's other
 * files stay. The Send that carries the draft settles it (`clear_draft:
 * <updated_at>` on the reply route): the words and the files it carried go, a
 * file it did not carry stays; with an older `updated_at`, only a draft holding
 * exactly the reply's words and only files the reply carried goes. A save may
 * name `base_body` and `base_files` (the words and file
 * ids the window saved last), which the page's save as it goes uses when its
 * `base` is a step behind. Drafts are files under `inbox/reply-drafts/`, outside the
 * event log (shared/inbox/reply-drafts.ts): agents, the MCP and search never
 * see them. A change tells every open window (`event: drafts` on the window's
 * stream), so its list reads the rows' `unsent` again. The phone's door
 * forwards the GET only (read-only, contract 7.62).
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxReplyDraft } from "@plannotator/core/inbox-types";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

export const INBOX_REPLY_DRAFT_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/draft(\/delete)?$/;

export function createInboxReplyDrafts(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** A draft was saved or deleted: the windows' streams say so. */
  onChange: (threadId: string) => void;
  /**
   * The person changed the draft (its words, files, recipients, quote or mentions), or deleted it: their doing in the
   * thread ("Recent activity", shared's acted.ts). A save that changes nothing (the box saving an untouched draft)
   * is not one.
   */
  onEdited?: (threadId: string) => void;
}) {
  const { store, serverSession, json } = options;

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_REPLY_DRAFT_PATH.exec(url.pathname);
    if (!match) return null;
    const threadId = match[1]!;
    if (!match[2] && req.method === "GET") {
      if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
      if (!store.thread(threadId)) return json({ error: `No thread ${threadId}.`, code: "thread_not_found" }, 404);
      return json({ serverSession, draft: store.replyDraft(threadId) });
    }
    if (req.method !== "POST") return json({ error: match[2] ? "Use POST." : "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (match[2]) {
      if (!store.thread(threadId)) return json({ error: `No thread ${threadId}.`, code: "thread_not_found" }, 404);
      const deleted = store.deleteReplyDraft(threadId);
      if (deleted) {
        options.onChange(threadId);
        options.onEdited?.(threadId);
      }
      return json({ ok: true, deleted });
    }
    const before = store.replyDraft(threadId);
    const draft = store.saveReplyDraft(threadId, body);
    options.onChange(threadId);
    if (!sameReplyDraftContent(before, draft)) options.onEdited?.(threadId);
    return json({ draft });
  };

  return { route };
}

/** What a draft holds, whatever its times: two drafts the same here are the same draft to the person (null: none). */
export function sameReplyDraftContent(a: InboxReplyDraft | null, b: InboxReplyDraft | null): boolean {
  const content = (draft: InboxReplyDraft | null) =>
    draft === null ? null : sorted({ body: draft.body, files: draft.files ?? [], recipients: draft.recipients ?? [], quote: draft.quote ?? null, mentions: draft.mentions ?? [] });
  return JSON.stringify(content(a)) === JSON.stringify(content(b));
}

/** A value with every object's keys in order, so two equal values write the same JSON. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  return value;
}
