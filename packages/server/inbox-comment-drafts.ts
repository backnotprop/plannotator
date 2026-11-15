import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { deleteInboxCommentDraft, readInboxCommentDraft, saveInboxCommentDraft } from "@plannotator/shared/inbox/comment-drafts";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

export const INBOX_COMMENT_DRAFT_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/comment-draft(\/delete)?$/;

export function createInboxCommentDrafts(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { store, serverSession, json } = options;

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_COMMENT_DRAFT_PATH.exec(url.pathname);
    if (!match) return null;
    const threadId = match[1]!;
    if (!store.thread(threadId)) return json({ error: `No thread ${threadId}.`, code: "thread_not_found" }, 404);
    if (!match[2] && req.method === "GET") {
      if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
      return json({ serverSession, draft: readInboxCommentDraft(store.dir, threadId, url.searchParams.get("key")) });
    }
    if (req.method !== "POST") return json({ error: match[2] ? "Use POST." : "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (match[2]) return json({ ok: true, deleted: deleteInboxCommentDraft(store.dir, threadId, body.key, body.base) });
    const saved = saveInboxCommentDraft(store.dir, threadId, body);
    if ("conflict" in saved) return json({ error: "This comment changed in another window.", code: "draft_conflict", draft: saved.conflict }, 409);
    return json(saved);
  };

  return { route };
}
