import type { InboxMessage, InboxProject, InboxTag } from "@plannotator/core/inbox-types";
import { checkReviewAnchor, checkReviewLive, ReviewAnchorError, type InboxReviewAnchor, type InboxReviewLive } from "@plannotator/core/review-threads";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { createInboxLiveSessions } from "./inbox-sessions";

export const REVIEW_THREADS_PATH = "/api/inbox/review-threads";
export const REVIEW_THREADS_SEND_PATH = "/api/inbox/review-threads/send";
export const REVIEW_COMMENTS_MAX = 200;

interface Comment {
  anchor: InboxReviewAnchor;
  words: string;
}

export function reviewLeadWords(count: number): string {
  return count === 1 ? "1 comment on the code." : `${count} comments on the code.`;
}

function checked<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ReviewAnchorError) throw new InboxError("validation_error", error.message, { field: error.field });
    throw error;
  }
}

function commentsOf(value: unknown): Comment[] {
  if (!Array.isArray(value) || value.length === 0) throw new InboxError("validation_error", "comments: at least one comment.", { field: "comments" });
  if (value.length > REVIEW_COMMENTS_MAX) throw new InboxError("validation_error", `comments: at most ${REVIEW_COMMENTS_MAX} at once.`, { field: "comments" });
  return value.map((item, i) => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const words = typeof raw.words === "string" ? raw.words.trim() : "";
    if (!words) throw new InboxError("validation_error", `comments[${i}].words: write the comment.`, { field: `comments[${i}].words` });
    return { anchor: checked(() => checkReviewAnchor(raw.anchor, `comments[${i}].anchor`)), words };
  });
}

export function createInboxLiveReview(options: {
  store: InboxStore;
  serverSession: string;
  live: ReturnType<typeof createInboxLiveSessions>;
  resolveProject: (path: string) => Promise<InboxProject>;
  findProjects: (path: string) => Promise<{ projects: InboxProject[] }>;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { store, serverSession, live, json } = options;

  const threadOf = async (projectPath: string, key: string): Promise<InboxMessage | null> => {
    const { projects } = await options.findProjects(projectPath);
    for (const project of projects) {
      const found = store.reviewLiveThread(store.canonicalProjectId(project.id), key) ?? store.reviewLiveThread(project.id, key);
      if (found) return found;
    }
    return null;
  };

  const answer = (root: InboxMessage | null) => {
    if (!root) return { serverSession, thread: null, messages: [] };
    const thread = store.thread(root.thread_id);
    return {
      serverSession,
      thread: { id: root.thread_id, title: root.review_live?.title ?? root.thread_name ?? null, to: root.to ?? null, project_id: root.project_id },
      messages: thread?.messages ?? [],
    };
  };

  const tagsOf = (value: unknown): InboxTag[] | undefined => (value === undefined || value === null ? undefined : live.tagTargets(value));

  const send = async (body: Record<string, unknown>): Promise<Response> => {
    const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Send.", { field: "idempotency_key" });
    if (typeof body.project_path !== "string" || !body.project_path.trim()) throw new InboxError("validation_error", "project_path: the review's repository.", { field: "project_path" });
    const review: InboxReviewLive = checked(() => checkReviewLive(body.review));
    const comments = commentsOf(body.comments);
    const words = typeof body.words === "string" ? body.words.trim() : "";
    const tags = tagsOf(body.tags);
    const batch = comments.length > 1 ? `rb_${key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48)}` : null;
    const replayed = store.personThreadByKey(`${key}:root`);
    if (replayed) {
      const siblings = comments.map((_, i) => store.replyByKey(replayed.id, `${key}:${i}`)?.id).filter((id): id is string => !!id);
      return json({ ...answer(replayed), sent: [replayed.id, ...siblings], replayed: true });
    }
    let root = await threadOf(body.project_path, review.key);
    const written: InboxMessage[] = [];
    if (!root) {
      const target = live.composeTarget(body.to) ?? (tags?.[0]?.host ? { host: tags[0].host, session: tags[0].session, root: null } : null);
      if (!target) throw new InboxError("session_not_live", "That agent is not connected any more: nothing was sent. Tag another agent with @.");
      const project = await options.resolveProject(body.project_path);
      const single = comments.length === 1 && !words ? comments[0]! : null;
      root = store.startPersonThread({
        project_id: project.id,
        body: single ? single.words : words || reviewLeadWords(comments.length),
        to: { host: target.host, session: target.session },
        idempotency_key: `${key}:root`,
        thread_name: `Review: ${review.title}`,
        thread_name_auto: true,
        thread_name_numbered: true,
        review_live: review,
        ...(single ? { review_anchor: single.anchor } : {}),
        ...(batch ? { review_batch: { id: batch, lead: true } } : {}),
      }).message;
      written.push(root);
      if (single) return json({ ...answer(root), sent: written.map((m) => m.id) });
      for (const [i, comment] of comments.entries()) {
        written.push(store.sendReply(root.id, { words: comment.words, idempotency_key: `${key}:${i}`, review_anchor: comment.anchor, ...(batch ? { review_batch: { id: batch, lead: false } } : {}) }).reply);
      }
      return json({ ...answer(root), sent: written.map((m) => m.id) });
    }
    const replyTo = typeof body.reply_to === "string" && store.message(body.reply_to)?.thread_id === root.thread_id ? body.reply_to : root.thread_id;
    if (comments.length === 1 && !words) {
      const reply = store.sendReply(replyTo, { words: comments[0]!.words, idempotency_key: `${key}:0`, review_anchor: comments[0]!.anchor, ...(tags && tags.length > 0 ? { tags } : {}) }).reply;
      return json({ ...answer(root), sent: [reply.id] });
    }
    for (const [i, comment] of comments.entries()) {
      written.push(store.sendReply(replyTo, { words: comment.words, idempotency_key: `${key}:${i}`, review_anchor: comment.anchor, review_batch: { id: batch ?? `rb_${key}`, lead: false } }).reply);
    }
    written.push(
      store.sendReply(replyTo, {
        words: words || reviewLeadWords(comments.length),
        idempotency_key: `${key}:lead`,
        review_batch: { id: batch ?? `rb_${key}`, lead: true },
        ...(tags && tags.length > 0 ? { tags } : {}),
      }).reply,
    );
    return json({ ...answer(root), sent: written.map((m) => m.id) });
  };

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (path === REVIEW_THREADS_PATH) {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      const projectPath = url.searchParams.get("project_path") ?? "";
      const key = url.searchParams.get("key") ?? "";
      if (!projectPath || !key) throw new InboxError("validation_error", "project_path and key: the review's repository and key.", { field: "key" });
      return json(answer(await threadOf(projectPath, key)));
    }
    if (path === REVIEW_THREADS_SEND_PATH) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      return send(body);
    }
    const resolve = /^\/api\/inbox\/review-threads\/comments\/([A-Za-z0-9_]+)\/resolve$/.exec(path);
    if (resolve) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      if (typeof body.resolved !== "boolean") throw new InboxError("validation_error", "resolved: true or false.", { field: "resolved" });
      return json({ message: store.setReviewResolved(resolve[1]!, body.resolved) });
    }
    return null;
  };

  return { route };
}
