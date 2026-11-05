/**
 * Reviews in the Inbox (approval "inbox-reviews-page", 2026-11-04; DESIGN r2,
 * PR 2 "Server index"): the per-thread review index, read from the store's
 * own messages. Nothing is stored and no record is rewritten: the index is
 * derived on read and kept until the store changes (its event-log cursor, or
 * a re-read from disk). A review sent before guide refs carried their
 * `source` has it read once from its snapshot blob (a blob never changes, so
 * that read is kept by its hash). No git, gh or glab in the index.
 *
 * The rules (whose move, the rows) are core's (`packages/core/inbox-reviews.ts`).
 */

import { readFileSync } from "node:fs";
import { parseGuideSnapshotJson } from "@plannotator/core/guide-format";
import {
  inboxPullRefOfUrl,
  inboxReviewLandingOf,
  inboxReviewSourceOf,
  isInboxNote,
  type InboxMessage,
  type InboxPull,
  type InboxPullHost,
  type InboxReviewLanding,
  type InboxReviewSource,
  type InboxReviewThread,
} from "@plannotator/core/inbox-types";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { refCliRunner, type RefRunner } from "./ref-cards";

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
    const mark = message.review_verdict;
    // A verdict on an earlier review card answers that card, not the newest one.
    if (mark && mark.of !== latestReview.id) continue;
    answered = { message_id: message.id, at: message.created_at };
    if (mark) verdict = { verdict: mark.verdict, comments: mark.comments, message_id: message.id, at: message.created_at };
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
  // Older reviews' sources read from their snapshots, by blob hash. Only the latest review of each indexed thread is
  // read, and each rebuild keeps only those, so the cache is as large as the index and a blob is never read twice.
  let sources = new Map<string, InboxReviewSource | null>();
  return {
    threads() {
      const cursor = store.cursor();
      const reloads = store.reloadCount();
      if (built && built.cursor === cursor && built.reloads === reloads) return built.threads;
      const kept = new Map<string, InboxReviewSource | null>();
      const sourceOf = (message: InboxMessage): InboxReviewSource | null => {
        const sha = message.guide?.sha256;
        if (!sha) return null;
        let source = sources.has(sha) ? sources.get(sha)! : kept.get(sha);
        if (source === undefined) {
          source = null;
          try {
            const parsed = parseGuideSnapshotJson(readFileSync(inboxBlobPath(store.dir, sha), "utf8"));
            if (parsed.ok) source = inboxReviewSourceOf(parsed.value);
          } catch {
            // Gone from the store: the review is listed without its source.
          }
        }
        kept.set(sha, source);
        return source;
      };
      const threads: InboxReviewThread[] = [];
      for (const threadId of store.threadIds()) {
        const thread = inboxReviewThreadOf(store, threadId, sourceOf);
        if (thread) threads.push(thread);
      }
      sources = kept;
      built = { cursor, reloads, threads };
      return threads;
    },
  };
}

/** A PR read that said it is still open is not read again for this long. */
export const INBOX_PULL_STATE_AGAIN_MS = 30 * 60_000;
/** At most this many PRs are read after one read of the list; the rest wait for the next. */
export const INBOX_PULL_STATE_READS = 5;

/** A PR gone from the forge's list: what one read answered, or null when it could not say. */
export async function readInboxPullState(
  run: RefRunner,
  ref: { platform: InboxPull["platform"]; host: string; repo: string; number: number },
): Promise<{ state: "open" | "merged" | "closed"; at: string | null; title: string; url: string } | null> {
  const github = ref.platform === "github";
  const endpoint = github ? `repos/${ref.repo}/pulls/${ref.number}` : `projects/${encodeURIComponent(ref.repo)}/merge_requests/${ref.number}`;
  const read = await run(github ? "gh" : "glab", ["api", "--hostname", ref.host, endpoint]).catch(() => null);
  if (!read || read.exitCode !== 0) return null;
  try {
    const pr = JSON.parse(read.stdout) as { state?: unknown; merged_at?: unknown; closed_at?: unknown; title?: unknown; html_url?: unknown; web_url?: unknown };
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    const merged = text(pr.merged_at);
    const closed = pr.state === "closed";
    const state = merged || pr.state === "merged" ? "merged" : closed ? "closed" : pr.state === "open" || pr.state === "opened" ? "open" : null;
    const url = text(pr.html_url) ?? text(pr.web_url);
    if (!state || !url) return null;
    return { state, at: merged ?? text(pr.closed_at), title: text(pr.title) ?? "", url };
  } catch {
    return null;
  }
}

/**
 * Reads the state of a review thread's PRs that left the list: the list never carries a closed PR, and a merged one only
 * for a while, so a thread would read as a local review again. In the background (the list never waits for it), and
 * only for hosts that answered this list; one that merged or closed is recorded through `onLanded` and not read again.
 */
export function createInboxPullStates(options: { run?: RefRunner; now?: () => number; onLanded: (landing: InboxReviewLanding) => void }) {
  const run = options.run ?? refCliRunner;
  const now = options.now ?? Date.now;
  const lastRead = new Map<string, number>();
  let reading: Promise<void> | null = null;
  return {
    /** Starts the reads this list leaves to do; resolves when they are done (the tests' wait). */
    look(input: {
      threads: readonly InboxReviewThread[];
      pulls: readonly InboxPull[];
      hosts: readonly InboxPullHost[];
      owners: ReadonlyMap<string, { thread_id: string }>;
      landed: readonly InboxReviewLanding[];
    }): Promise<void> {
      if (reading) return reading;
      const byThread = new Map(input.threads.map((thread) => [thread.thread_id, thread]));
      const listed = new Set(input.pulls.map((pull) => pull.key));
      const known = new Set(input.landed.map((landing) => landing.key));
      const hosts = new Set(input.hosts.filter((host) => !host.error).map((host) => host.host));
      const wanted = new Map<string, { url: string | null; threadId: string }>();
      // Only review threads have a row to get wrong: a thread with no review leaves Reviews with its PR.
      for (const [key, owner] of input.owners) if (byThread.has(owner.thread_id)) wanted.set(key, { url: null, threadId: owner.thread_id });
      for (const thread of input.threads) {
        const ref = thread.source?.pr ? inboxPullRefOfUrl(thread.source.pr.url) : null;
        if (ref && !wanted.has(ref.key)) wanted.set(ref.key, { url: thread.source!.pr!.url, threadId: thread.thread_id });
      }
      const due: { key: string; threadId: string; ref: NonNullable<ReturnType<typeof inboxPullRefOfUrl>> }[] = [];
      for (const [key, want] of wanted) {
        if (due.length >= INBOX_PULL_STATE_READS) break;
        if (listed.has(key) || known.has(key) || now() - (lastRead.get(key) ?? -Infinity) < INBOX_PULL_STATE_AGAIN_MS) continue;
        const ref = inboxPullRefOfKey(key, want.url);
        if (ref && hosts.has(ref.host)) due.push({ key, threadId: want.threadId, ref });
      }
      if (due.length === 0) return Promise.resolve();
      reading = (async () => {
        for (const { key, threadId, ref } of due) {
          lastRead.set(key, now());
          const state = await readInboxPullState(run, ref);
          if (!state || state.state === "open") continue;
          options.onLanded(inboxReviewLandingOf({ key, url: state.url, number: ref.number, title: state.title, platform: ref.platform, state: state.state, at: state.at }, threadId, byThread.get(threadId) ?? null));
        }
      })().finally(() => {
        reading = null;
      });
      return reading;
    },
  };
}

/** A key's parts. Which forge a key is on is in its URL when one is known; a key alone reads as GitHub unless its host says GitLab. */
function inboxPullRefOfKey(key: string, url: string | null): (ReturnType<typeof inboxPullRefOfUrl> & {}) | null {
  if (url) return inboxPullRefOfUrl(url);
  const match = /^([^/]+)\/(.+)#(\d+)$/.exec(key);
  if (!match) return null;
  return { key, host: match[1]!, repo: match[2]!, number: Number(match[3]), platform: /gitlab/i.test(match[1]!) ? "gitlab" : "github" };
}
