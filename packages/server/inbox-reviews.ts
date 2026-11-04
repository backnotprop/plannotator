/**
 * Reviews in the Inbox (approval "inbox-reviews-page", 2026-11-04; DESIGN r2,
 * PR 2 "Server index"): the per-thread review index, read from the store's
 * own messages. Nothing is stored and no record is rewritten: the index is
 * derived on read and kept until the store changes (its event-log cursor, or
 * a re-read from disk). A review sent before guide refs carried their
 * `source` has it read once from its snapshot blob (a blob never changes, so
 * that read is kept by its hash). No git, gh or glab here.
 *
 * The rules (whose move, the rows) are core's (`packages/core/inbox-reviews.ts`).
 */

import { readFileSync } from "node:fs";
import { parseGuideSnapshotJson } from "@plannotator/core/guide-format";
import { inboxReviewSourceOf, isInboxNote, type InboxMessage, type InboxReviewSource, type InboxReviewThread } from "@plannotator/core/inbox-types";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";

/** The parts of the store the index reads. */
export interface InboxReviewIndexStore {
  readonly dir: string;
  cursor(): number;
  reloadCount(): number;
  threadIds(): string[];
  threadMessageIds(threadId: string): readonly string[];
  message(id: string): InboxMessage | null;
  threadSubject(threadId: string): string | null;
  canonicalProjectId(projectId: string): string;
}

/** The sources read from snapshot blobs are kept for at most this many reviews. */
const SOURCE_CACHE_MAX = 2000;

/**
 * One thread's reviews, or null when no agent sent a review in it. `sourceOf`
 * gives a review's source when its guide ref does not carry one (an older
 * message).
 */
export function inboxReviewThreadOf(
  store: Pick<InboxReviewIndexStore, "threadMessageIds" | "message" | "threadSubject" | "canonicalProjectId">,
  threadId: string,
  sourceOf: (message: InboxMessage) => InboxReviewSource | null = () => null,
): InboxReviewThread | null {
  const root = store.message(threadId);
  if (!root || root.thread_id !== threadId) return null;
  let first: InboxMessage | null = null;
  let latestReview: InboxMessage | null = null;
  let round = 0;
  let verdict: InboxReviewThread["verdict"] = null;
  let answered: InboxReviewThread["answered"] = null;
  let last: InboxMessage = root;
  for (const id of store.threadMessageIds(threadId)) {
    const message = store.message(id);
    if (!message) continue;
    // The Inbox's own notes (set aside, reopened, a 👍's note, Tidy) are nobody's answer and move no row.
    if (isInboxNote(message)) continue;
    last = message;
    if (message.author.kind === "agent" && message.guide?.review) {
      first ??= message;
      latestReview = message;
      round += 1;
      verdict = null;
      answered = null;
      continue;
    }
    if (!latestReview || message.author.kind !== "person") continue;
    answered = { message_id: message.id, at: message.created_at };
    const mark = message.review_verdict;
    if (mark && mark.of === latestReview.id) verdict = { verdict: mark.verdict, comments: mark.comments, message_id: message.id, at: message.created_at };
  }
  if (!first || !latestReview) return null;
  const guide = latestReview.guide!;
  const author = latestReview.author;
  return {
    thread_id: threadId,
    project_id: store.canonicalProjectId(root.project_id),
    subject: store.threadSubject(threadId),
    first_review_id: first.id,
    latest_review_id: latestReview.id,
    round,
    title: guide.title,
    files: guide.files,
    additions: guide.additions,
    deletions: guide.deletions,
    agent: author.kind === "agent" ? { host: author.host, session: author.session, name: author.name } : null,
    source: guide.source ?? sourceOf(latestReview),
    verdict,
    answered,
    reviewed_at: latestReview.created_at,
    updated_at: last.created_at,
    resolved_at: root.resolved_at,
  };
}

/** The index: every thread with a review, rebuilt only after the store changed. */
export interface InboxReviewIndex {
  threads(): InboxReviewThread[];
}

export function createInboxReviewIndex(store: InboxReviewIndexStore): InboxReviewIndex {
  let built: { cursor: number; reloads: number; threads: InboxReviewThread[] } | null = null;
  const sources = new Map<string, InboxReviewSource | null>();
  // An older review's source, from its snapshot (read once per blob; gone or unreadable: unknown).
  const sourceOf = (message: InboxMessage): InboxReviewSource | null => {
    const sha = message.guide?.sha256;
    if (!sha) return null;
    if (sources.has(sha)) return sources.get(sha)!;
    let source: InboxReviewSource | null = null;
    try {
      const parsed = parseGuideSnapshotJson(readFileSync(inboxBlobPath(store.dir, sha), "utf8"));
      if (parsed.ok) source = inboxReviewSourceOf(parsed.value);
    } catch {
      // Gone from the store: the review is listed without its source.
    }
    if (sources.size >= SOURCE_CACHE_MAX) sources.delete(sources.keys().next().value!);
    sources.set(sha, source);
    return source;
  };
  return {
    threads() {
      const cursor = store.cursor();
      const reloads = store.reloadCount();
      if (built && built.cursor === cursor && built.reloads === reloads) return built.threads;
      const threads: InboxReviewThread[] = [];
      for (const threadId of store.threadIds()) {
        const thread = inboxReviewThreadOf(store, threadId, sourceOf);
        if (thread) threads.push(thread);
      }
      built = { cursor, reloads, threads };
      return threads;
    },
  };
}
