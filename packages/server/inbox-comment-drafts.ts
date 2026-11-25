import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { deleteInboxCommentDraft, readInboxCommentDraft, saveInboxCommentDraft } from "@plannotator/shared/inbox/comment-drafts";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

/** The comment-draft keys of decision mode's reasons (decisions/reasonDrafts.ts `reasonDraftKey`). */
export const FAR_REASON_PREFIX = "decision-reason:";

export const INBOX_COMMENT_DRAFT_PATH =/^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/comment-draft(\/delete)?$/;

export function createInboxCommentDrafts(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** A draft was saved: the person's doing in the thread ("Recent activity", shared's acted.ts). */
  onSaved?: (threadId: string) => void;
  /** Whether `machine` is a linked computer here (its decision reasons are kept on this Inbox). */
  linked?: (machine: string) => boolean;
}) {
  const { store, serverSession, json } = options;

  /**
   * A decision reason typed here for a linked computer's thread (`machine` names it, the key starts `decision-reason:`):
   * kept in this Inbox's comment drafts, one file per computer, thread and key, overwritten on each save. Only the
   * mark, which carries the reason as its note, goes to that computer; the draft never does.
   */
  const farKey = (machine: unknown, key: unknown): string | null =>
    typeof machine === "string" && /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/.test(machine) && options.linked?.(machine) && typeof key === "string" && key.startsWith(FAR_REASON_PREFIX) ? `${machine}\u0000${key}` : null;

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_COMMENT_DRAFT_PATH.exec(url.pathname);
    if (!match) return null;
    const threadId = match[1]!;
    const here = !!store.thread(threadId);
    if (!match[2] && req.method === "GET") {
      if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
      const key = here ? url.searchParams.get("key") : farKey(url.searchParams.get("machine"), url.searchParams.get("key"));
      if (key === null) return json({ error: `No thread ${threadId}.`, code: "thread_not_found" }, 404);
      return json({ serverSession, draft: readInboxCommentDraft(store.dir, threadId, key) });
    }
    if (req.method !== "POST") return json({ error: match[2] ? "Use POST." : "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    const key = here ? body.key : farKey(body.machine, body.key);
    if (key === null) return json({ error: `No thread ${threadId}.`, code: "thread_not_found" }, 404);
    if (match[2]) return json({ ok: true, deleted: deleteInboxCommentDraft(store.dir, threadId, key, body.base) });
    const saved = saveInboxCommentDraft(store.dir, threadId, { ...body, key, ...(here ? {} : { images: [] }) });
    if ("conflict" in saved) return json({ error: "This comment changed in another window.", code: "draft_conflict", draft: saved.conflict }, 409);
    if (here) options.onSaved?.(threadId);
    return json(saved);
  };

  return { route };
}
