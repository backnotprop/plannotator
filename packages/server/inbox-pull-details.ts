/**
 * What a PR's details page shows, from the forge's own answer (`fetchPRContextWithReviewers`, GitHub and GitLab in one
 * shape): who stands where, how the checks stand, and every comment in time order. Nothing is cut: a long list is the
 * page's to lay out.
 */

import type { InboxPullCheck, InboxPullCheckState, InboxPullDetailComment, InboxPullDetailsAnswer, InboxPullReviewer, InboxPullReviewState } from "@plannotator/core/inbox-types";
import type { PRCheck, PRContext } from "@plannotator/shared/pr-types";

export interface PullDetailsRead {
  answer: InboxPullDetailsAnswer;
  /** The avatar URLs the forge gave for the people named: login to URL, for the avatar route's allow-list. */
  avatars: Record<string, string>;
}

const REVIEW_STATE: Readonly<Record<string, InboxPullReviewState>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
};

/** A login the forge answers for an account that is gone (GitHub drops the author, GitLab's and GitHub's "ghost"). */
const goneLogin = (login: string): string => (login.toLowerCase() === "ghost" ? "" : login);

/**
 * Each person's last review that counts, as the forge's own page reads it: a comment never takes back an approval or a
 * request for changes, a dismissed review or a draft says nothing, and being asked again means waiting.
 */
function reviewersOf(context: PRContext, author: string | null, avatars: Record<string, string>): InboxPullReviewer[] {
  const standing = new Map<string, InboxPullReviewer>();
  const dated = context.reviews
    .map((review, index) => ({ review, index }))
    .sort((a, b) => (a.review.submittedAt || "").localeCompare(b.review.submittedAt || "") || a.index - b.index);
  for (const { review } of dated) {
    const login = goneLogin(review.author);
    if (!login) continue;
    if (review.avatarUrl) avatars[login] ??= review.avatarUrl;
    if (review.state === "DISMISSED") {
      standing.delete(login);
      continue;
    }
    const state = REVIEW_STATE[review.state];
    if (!state) continue;
    const was = standing.get(login)?.state;
    if (state === "commented" && (was === "approved" || was === "changes")) continue;
    standing.set(login, { login, state, ...(review.isBot ? { bot: true } : {}) });
  }
  for (const asked of context.requestedReviewers ?? []) {
    const login = goneLogin(asked.login);
    if (!login) continue;
    if (asked.avatarUrl) avatars[login] ??= asked.avatarUrl;
    // GitLab keeps an approver among its reviewers: the approval stands. GitHub takes one off when they are asked again.
    if (standing.get(login)?.state === "approved" && context.reviews.some((r) => r.author === login && r.state === "APPROVED" && !r.submittedAt)) continue;
    standing.set(login, { login, state: "waiting", ...(asked.isBot ? { bot: true } : {}), ...(asked.isTeam ? { team: true } : {}) });
  }
  if (author) standing.delete(author);
  return [...standing.values()];
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "CANCELED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
/** A check that passed by not running, or was overtaken by a newer run: quiet, counted on the line. */
const QUIET_NOTE: Readonly<Record<string, string>> = { SKIPPED: "Skipped", NEUTRAL: "Neutral", STALE: "Stale" };
/** How a check failed, in the forge's own words. */
const FAILED_NOTE: Readonly<Record<string, string>> = {
  FAILURE: "Failed", FAILED: "Failed", TIMED_OUT: "Timed out", CANCELLED: "Cancelled", CANCELED: "Cancelled",
  ACTION_REQUIRED: "Action required", STARTUP_FAILURE: "Startup failure", ERROR: "Error",
};

function checkOf(check: PRCheck): InboxPullCheck | null {
  if (!check.name) return null;
  // gh answers a queued or running check with an empty conclusion, not null.
  const conclusion = check.conclusion?.toUpperCase() ?? "";
  // A stale check was overtaken and will never finish: it counts as done, quietly, never as running forever.
  const done = (check.status === "COMPLETED" && !!conclusion) || conclusion === "STALE";
  const state: InboxPullCheckState = !done ? "pending" : FAILED.has(conclusion) ? "fail" : "pass";
  const note = state === "fail" ? FAILED_NOTE[conclusion] : QUIET_NOTE[conclusion];
  let url: string | undefined;
  try {
    if (check.detailsUrl && new URL(check.detailsUrl).protocol === "https:") url = check.detailsUrl;
  } catch {
    // Not an address: the row is its name.
  }
  return { name: check.name, ...(check.workflowName ? { workflow: check.workflowName } : {}), state, ...(note ? { note } : {}), ...(url ? { url } : {}) };
}

function commentsOf(context: PRContext, avatars: Record<string, string>): InboxPullDetailComment[] {
  const out: InboxPullDetailComment[] = [];
  const person = (login: string, avatarUrl?: string) => {
    const author = goneLogin(login);
    if (author && avatarUrl) avatars[author] ??= avatarUrl;
    return author;
  };
  for (const c of context.comments) {
    out.push({ id: c.id, author: person(c.author, c.avatarUrl), ...(c.isBot ? { bot: true } : {}), at: c.createdAt, body: c.body, url: c.url });
  }
  // A review's own words; a review with none is on the reviewers' list and nowhere here.
  for (const r of context.reviews) {
    if (!r.body.trim()) continue;
    out.push({ id: r.id, author: person(r.author, r.avatarUrl), ...(r.isBot ? { bot: true } : {}), at: r.submittedAt, body: r.body, url: r.url ?? "" });
  }
  for (const thread of context.reviewThreads) {
    for (const c of thread.comments) {
      out.push({
        id: c.id,
        author: person(c.author, c.avatarUrl),
        ...(c.isBot ? { bot: true } : {}),
        at: c.createdAt,
        body: c.body,
        url: c.url,
        ...(thread.path ? { file: thread.path } : {}),
        ...(thread.line !== null ? { line: thread.line } : {}),
      });
    }
  }
  return out
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => (a.comment.at || "").localeCompare(b.comment.at || "") || a.index - b.index)
    .map(({ comment }) => comment);
}

export function pullDetailsOf(key: string, context: PRContext, author: string | null): PullDetailsRead {
  const avatars: Record<string, string> = {};
  const reviewers = reviewersOf(context, author, avatars);
  const comments = commentsOf(context, avatars);
  // `-{2}`, not a literal `--`: Semgrep's TypeScript parser reads `<!--` and `-->` as HTML-like comments.
  const body = context.body.replace(/<!-{2}[\s\S]*?(?:-{2}>|$)/g, "").trim();
  return {
    answer: {
      key,
      description: body ? context.body : null,
      labels: context.labels.map((label) => label.name).filter(Boolean),
      reviewers,
      checks: context.checks.flatMap((check) => checkOf(check) ?? []),
      comments,
      ...(context.threadsIncomplete ? { threads_incomplete: true } : {}),
    },
    avatars,
  };
}
