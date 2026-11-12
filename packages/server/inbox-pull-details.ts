import type { InboxPullCheck, InboxPullCheckState, InboxPullDetailComment, InboxPullDetailsAnswer, InboxPullReviewer, InboxPullReviewState, InboxPullThread } from "@plannotator/core/inbox-types";
import type { PRCheck, PRContext, PRThreadComment } from "@plannotator/shared/pr-types";

export interface PullDetailsRead {
  answer: InboxPullDetailsAnswer;
  avatars: Record<string, string>;
}

const REVIEW_STATE: Readonly<Record<string, InboxPullReviewState>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
};

const goneLogin = (login: string): string => (login.toLowerCase() === "ghost" ? "" : login);

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
    if (standing.get(login)?.state === "approved" && context.reviews.some((r) => r.author === login && r.state === "APPROVED" && !r.submittedAt)) continue;
    standing.set(login, { login, state: "waiting", ...(asked.isBot ? { bot: true } : {}), ...(asked.isTeam ? { team: true } : {}) });
  }
  if (author) standing.delete(author);
  return [...standing.values()];
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "CANCELED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const QUIET_NOTE: Readonly<Record<string, string>> = { SKIPPED: "Skipped", NEUTRAL: "Neutral", STALE: "Stale" };
const FAILED_NOTE: Readonly<Record<string, string>> = {
  FAILURE: "Failed", FAILED: "Failed", TIMED_OUT: "Timed out", CANCELLED: "Cancelled", CANCELED: "Cancelled",
  ACTION_REQUIRED: "Action required", STARTUP_FAILURE: "Startup failure", ERROR: "Error",
};

function checkOf(check: PRCheck): InboxPullCheck | null {
  if (!check.name) return null;
  const conclusion = check.conclusion?.toUpperCase() ?? "";
  const done = (check.status === "COMPLETED" && !!conclusion) || conclusion === "STALE";
  const state: InboxPullCheckState = !done ? "pending" : FAILED.has(conclusion) ? "fail" : "pass";
  const note = state === "fail" ? FAILED_NOTE[conclusion] : QUIET_NOTE[conclusion];
  let url: string | undefined;
  try {
    if (check.detailsUrl && new URL(check.detailsUrl).protocol === "https:") url = check.detailsUrl;
  } catch {
  }
  return { name: check.name, ...(check.workflowName ? { workflow: check.workflowName } : {}), state, ...(note ? { note } : {}), ...(url ? { url } : {}) };
}

function threadComment(file: string, line: number | null, c: PRThreadComment, person: (login: string, avatarUrl?: string) => string): InboxPullDetailComment {
  return {
    id: c.id,
    author: person(c.author, c.avatarUrl),
    ...(c.isBot ? { bot: true } : {}),
    at: c.createdAt,
    body: c.body,
    url: c.url,
    ...(file ? { file } : {}),
    ...(line !== null ? { line } : {}),
    ...(c.isMinimized ? { hidden: (c.minimizedReason ?? "").toLowerCase().replace(/_/g, "-") } : {}),
  };
}

function threadsOf(context: PRContext): InboxPullThread[] {
  const person = (login: string) => goneLogin(login);
  return context.reviewThreads.flatMap((thread): InboxPullThread[] => {
    if (!thread.path || thread.comments.length === 0) return [];
    return [{
      id: thread.id,
      file: thread.path,
      line: thread.line,
      start_line: thread.startLine !== null && thread.line !== null && thread.startLine < thread.line && (!thread.startDiffSide || thread.startDiffSide === thread.diffSide) ? thread.startLine : null,
      side: thread.diffSide === "LEFT" ? "old" : "new",
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      comments: thread.comments.map((c) => threadComment(thread.path, thread.line, c, person)),
    }];
  });
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
  for (const r of context.reviews) {
    if (!r.body.trim()) continue;
    out.push({ id: r.id, author: person(r.author, r.avatarUrl), ...(r.isBot ? { bot: true } : {}), at: r.submittedAt, body: r.body, url: r.url ?? "" });
  }
  for (const thread of context.reviewThreads) {
    for (const c of thread.comments) out.push(threadComment(thread.path, thread.line, c, person));
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
  const body = context.body.replace(/<!-{2}[\s\S]*?(?:-{2}>|$)/g, "").trim();
  return {
    answer: {
      key,
      description: body ? context.body : null,
      labels: context.labels.map((label) => label.name).filter(Boolean),
      reviewers,
      checks: context.checks.flatMap((check) => checkOf(check) ?? []),
      comments,
      threads: threadsOf(context),
      ...(context.threadsIncomplete ? { threads_incomplete: true } : {}),
    },
    avatars,
  };
}
