import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessage, InboxProject, InboxTag } from "@plannotator/core/inbox-types";
import { checkReviewAnchor, checkReviewLive, ReviewAnchorError, type InboxReviewAnchor, type InboxReviewLive } from "@plannotator/core/review-threads";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { createInboxLiveSessions } from "./inbox-sessions";

export const REVIEW_THREADS_PATH = "/api/inbox/review-threads";
export const REVIEW_THREADS_SEND_PATH = "/api/inbox/review-threads/send";
export const REVIEW_COMMENTS_MAX = 200;
export const REVIEW_OPEN_WAIT_MS = 30_000;

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
  dataDir?: string;
  reviewCommand?: () => string[];
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
      const start = (named: Record<string, unknown>) =>
        store.startPersonThread({
          project_id: project.id,
          body: single ? single.words : words || reviewLeadWords(comments.length),
          to: { host: target.host, session: target.session },
          idempotency_key: `${key}:root`,
          ...named,
          review_live: review,
          ...(single ? { review_anchor: single.anchor } : {}),
          ...(batch ? { review_batch: { id: batch, lead: true } } : {}),
        }).message;
      const name = `Review: ${review.title}`;
      try {
        root = start({ thread_name: name });
      } catch (error) {
        if (!(error instanceof InboxError) || (error.code !== "thread_name_taken" && error.code !== "validation_error")) throw error;
        root = start({ thread_name: name, thread_name_auto: true, thread_name_numbered: true });
      }
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

  const opening = new Map<string, Promise<{ url: string }>>();
  const openReview = (threadId: string): Promise<{ url: string }> => {
    const root = store.message(threadId);
    if (!root || root.thread_id !== threadId || !root.review_live) throw new InboxError("message_not_found", `No live review ${threadId}.`);
    const project = store.project(root.project_id);
    if (!project || !existsSync(project.root)) throw new InboxError("project_not_found", "That review's folder is gone from this computer.");
    const command = options.reviewCommand?.();
    if (!command || command.length === 0) throw new InboxError("review_unavailable", "This Inbox can't start a review.");
    const running = opening.get(threadId);
    if (running) return running;
    const review = root.review_live;
    const started = (async () => {
      const dir = mkdtempSync(join(tmpdir(), "plannotator-live-review-"));
      const ready = join(dir, "ready.jsonl");
      const pr = review.key.startsWith("pr:") ? [review.key.slice(3)] : [];
      const child = spawn(command[0]!, [...command.slice(1), "review", ...pr], {
        cwd: project.root,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          ...(options.dataDir ? { PLANNOTATOR_DATA_DIR: options.dataDir } : {}),
          PLANNOTATOR_READY_FILE: ready,
          PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
          PLANNOTATOR_REVIEW_LIVE_THREAD: threadId,
          PLANNOTATOR_REVIEW_LIVE_KEY: review.key,
          PLANNOTATOR_REVIEW_LIVE_TITLE: review.title,
        },
      });
      child.unref();
      for (let waited = 0; waited < REVIEW_OPEN_WAIT_MS; waited += 100) {
        if (existsSync(ready)) {
          const line = readFileSync(ready, "utf8").split("\n").find((l) => l.includes('"url"'));
          if (line) {
            rmSync(dir, { recursive: true, force: true });
            return { url: (JSON.parse(line) as { url: string }).url };
          }
        }
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      rmSync(dir, { recursive: true, force: true });
      throw new InboxError("review_unavailable", "The review did not start. Run plannotator review in the repository to open it.");
    })().finally(() => opening.delete(threadId));
    opening.set(threadId, started);
    return started;
  };

  const takeBackComment = (messageId: string): string[] => {
    const message = store.message(messageId);
    if (!message || message.author.kind !== "person") throw new InboxError("message_not_found", `No message ${messageId}.`);
    const batch = message.review_batch;
    if (!batch) {
      store.takeBack(messageId);
      return [messageId];
    }
    const members = store.thread(message.thread_id)?.messages.filter((m) => m.review_batch?.id === batch.id) ?? [];
    const lead = members.find((m) => m.review_batch?.lead) ?? message;
    store.takeBack(lead.id);
    const taken = [lead.id];
    for (const member of members) {
      if (member.id === lead.id) continue;
      store.takeBack(member.id);
      taken.push(member.id);
    }
    return taken;
  };

  const route = async (req: Request, url: URL, owner = true): Promise<Response | null> => {
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
    const open = /^\/api\/inbox\/review-threads\/([A-Za-z0-9_]+)\/open$/.exec(path);
    if (open) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (!owner) return json({ error: "Only this computer's owner can open a review from this Inbox.", code: "owner_only" }, 403);
      const body = await options.readBody(req);
      if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      return json(await openReview(open[1]!));
    }
    const takeBack = /^\/api\/inbox\/review-threads\/comments\/([A-Za-z0-9_]+)\/take-back$/.exec(path);
    if (takeBack) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      return json({ taken: takeBackComment(takeBack[1]!) });
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
