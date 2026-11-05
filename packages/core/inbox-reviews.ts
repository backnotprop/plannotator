/**
 * Reviews in the Inbox (approval "inbox-reviews-page", 2026-11-04; DESIGN r2,
 * PR 2 "Server index"): the shapes `GET /api/inbox/reviews` answers and the
 * pure rules the server and the window share. Browser-safe, no dependencies
 * beyond core's pull rules. Reached through `@plannotator/core/inbox-types`,
 * so core's export map is unchanged.
 *
 * Reviews is a pivot view of the Inbox's own threads, never a copy (the
 * owner, q-74deff12: "it doesn't really move threads … Same thread, it shows
 * up differently in the list"):
 * - every thread holding a review card (an agent's submit_guide with
 *   `review: true`, in any thread, whatever started it) is one row;
 * - a thread the person handed a PR to (`via: "owner"`) is a row before its
 *   review arrives (the agent is curating);
 * - a PR (or a stack) with no review thread is a row of its own, flagged not
 *   reviewed.
 *
 * Whose move (`inboxReviewMove`) reads the person's own answer to the review
 * first, then the forge: a review waiting on the person is On you, feedback
 * sent is With your agents, approved is Ready to land, and work waiting on a
 * teammate or the forge is Waiting on others.
 */

import { inboxPullIsOpen, inboxPullLongLived, inboxPullRefOfUrl, type InboxPull, type InboxPullHost, type InboxPullLink, type InboxPullReason, type InboxPullStack } from "./inbox-pulls";
import type { InboxReviewVerdict } from "./inbox-review";

/** Where a review's changes came from: the guide snapshot's `source` and `review` (base), as the message records them. */
export interface InboxReviewSource {
  /** The snapshot's kind: local changes, a PR, a workspace, a commit. */
  kind: "local" | "pr" | "workspace" | "commit";
  /** `owner/repo` or a folder name, as the producer knew it. */
  repo?: string;
  branch?: string;
  /** The branch or ref the diff runs from ("origin/main"). */
  base?: string;
  /** The diff's label ("origin/main...HEAD", "PR #12"). */
  git_ref?: string;
  head_sha?: string;
  /** The PR the guide is of, when it says. */
  pr?: { url: string; number?: number; platform?: "github" | "gitlab" };
}

/** A source field is kept as one line of at most this many characters (the agent wrote it). */
export const INBOX_REVIEW_SOURCE_FIELD_MAX = 300;

const KINDS: readonly InboxReviewSource["kind"][] = ["local", "pr", "workspace", "commit"];

/**
 * A review's source from its guide snapshot's `source` and `review`: the
 * fields it names, each one line, cut at `INBOX_REVIEW_SOURCE_FIELD_MAX`;
 * null when the snapshot names no kind Reviews knows.
 */
export function inboxReviewSourceOf(snapshot: {
  source?: { kind?: unknown; repo?: unknown; branch?: unknown; headSha?: unknown; pr?: unknown } | null;
  review?: { gitRef?: unknown; base?: unknown } | null;
}): InboxReviewSource | null {
  const source = snapshot.source;
  if (!source || !KINDS.includes(source.kind as InboxReviewSource["kind"])) return null;
  const line = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const one = value.replace(/\s+/g, " ").trim();
    return one ? Array.from(one).slice(0, INBOX_REVIEW_SOURCE_FIELD_MAX).join("") : undefined;
  };
  const pr = source.pr && typeof source.pr === "object" ? (source.pr as { url?: unknown; number?: unknown; platform?: unknown }) : null;
  const url = pr ? line(pr.url) : undefined;
  const out: InboxReviewSource = { kind: source.kind as InboxReviewSource["kind"] };
  const repo = line(source.repo);
  const branch = line(source.branch);
  const base = line(snapshot.review?.base);
  const gitRef = line(snapshot.review?.gitRef);
  const head = line(source.headSha);
  if (repo) out.repo = repo;
  if (branch) out.branch = branch;
  if (base) out.base = base;
  if (gitRef) out.git_ref = gitRef;
  if (head) out.head_sha = head;
  if (url && /^https:\/\//.test(url)) {
    out.pr = {
      url,
      ...(typeof pr!.number === "number" && Number.isInteger(pr!.number) && pr!.number > 0 ? { number: pr!.number } : {}),
      ...(pr!.platform === "github" || pr!.platform === "gitlab" ? { platform: pr!.platform } : {}),
    };
  }
  return out;
}

/** The person's verdict on a review, from their reply's `review_verdict`. */
export interface InboxReviewVerdictMark {
  verdict: InboxReviewVerdict;
  /** How many of their comments rode it. */
  comments: number;
  /** The reply that carried it. */
  message_id: string;
  at: string;
}

/**
 * One thread's reviews: the per-thread review index (derived from the
 * thread's messages on read, never stored). A thread is in the index once
 * an agent sent a review in it.
 */
export interface InboxReviewThread {
  thread_id: string;
  /** The thread's project (canonical id). */
  project_id: string;
  subject: string | null;
  /** The first review message: the page folds the messages before it. */
  first_review_id: string;
  /** The latest review message: the card the row opens. */
  latest_review_id: string;
  /** How many reviews the thread holds (each `review: true` guide is a round). */
  round: number;
  /** The latest review's title and size. */
  title: string;
  files: number;
  additions: number;
  deletions: number;
  /** The agent that sent the latest review. */
  agent: { host: string | null; session: string | null; name: string | null } | null;
  /** The latest review's source, when its guide says (older messages: read once from its snapshot). */
  source: InboxReviewSource | null;
  /** The person's latest verdict on the latest review, or null. */
  verdict: InboxReviewVerdictMark | null;
  /**
   * The person's latest message after the latest review (a verdict, a reply
   * with comments, or words), or null while the review waits on them.
   */
  answered: { message_id: string; at: string } | null;
  /** When the latest review arrived. */
  reviewed_at: string;
  /** The thread's latest activity (its last message, the Inbox's own notes left out). */
  updated_at: string;
  /** The thread was resolved (archived), and when; null while open. */
  resolved_at: string | null;
}

/**
 * Whose move a Reviews row is:
 * - `on_you`: a review waits on the person, or a teammate asked for their review;
 * - `agents`: the agent has it (feedback sent, or the review is being curated);
 * - `ready`: the person approved and nothing else holds it (Ready to land);
 * - `waiting`: waiting on a teammate or on the forge (Waiting on others);
 * - `not_reviewed`: a listed PR no agent has reviewed (Open, not reviewed).
 */
export type InboxReviewMove = "on_you" | "agents" | "ready" | "waiting" | "not_reviewed";

/**
 * Why a row is where it is; the window turns it into words:
 * - `review_ready`: a review waits on the person's verdict;
 * - `feedback_sent`: the person asked for changes or answered; the agent has it;
 * - `curating`: the person handed it to an agent; no review yet;
 * - `approved`: the person approved it, nothing else holds it;
 * - `requested`: a teammate asked for the person's review;
 * - `changes`, `failing`: after the person's approval, a reviewer asked for changes on their PR, or its checks failed;
 * - `checks_running`, `draft`, `forge_review`: after the approval, its checks still run, it is a draft, or it waits on reviewers;
 * - `others`: a teammate's PR, not asked of the person;
 * - `not_reviewed`: a PR only listed.
 */
export type InboxReviewReason =
  | "review_ready"
  | "feedback_sent"
  | "curating"
  | "approved"
  | "requested"
  | "changes"
  | "failing"
  | "checks_running"
  | "draft"
  | "forge_review"
  | "others"
  | "assigned"
  | "not_reviewed";

/**
 * A PR a review thread owned that merged or closed, recorded once the Inbox has seen it (`inbox/pull-links.json`):
 * the list reads merged PRs for `INBOX_PULLS_MERGED_DAYS` and never reads closed ones, so without this the thread would
 * read as a local review again. It keeps what the row needs to still link to the PR.
 */
export interface InboxReviewLanding {
  /** The PR's key (`host/repo#number`). */
  key: string;
  thread_id: string;
  state: "merged" | "closed";
  /** When the forge says it happened, by the forge's clock; null when it did not say. */
  at: string | null;
  url: string;
  number: number;
  title: string;
  platform: InboxPull["platform"];
  /** The PR's head branch, when known: a review of that branch is a review of this PR. */
  head: string | null;
  /**
   * The thread's latest review when this was first seen, when that review was not newer than the landing; else null.
   * Later on the row compares review ids, never clocks: a review with another id came after the record.
   */
  through_review: string | null;
}

/**
 * The review's time is this machine's and the merge's is the forge's. A review within this much after the landing
 * is not counted as newer, so a clock running a little fast never keeps a finished review listed.
 */
export const INBOX_REVIEW_CLOCK_SKEW_MS = 5 * 60_000;

/** A record's identity: two threads on one PR each have their own, against their own review. */
export function inboxReviewLandingId(landing: Pick<InboxReviewLanding, "key" | "thread_id">): string {
  return `${landing.thread_id} ${landing.key}`;
}

/** The record for a PR seen merged or closed now, against the thread's review as it stands. */
export function inboxReviewLandingOf(
  pull: Pick<InboxReviewLanding, "key" | "url" | "number" | "title" | "platform" | "state" | "at" | "head">,
  threadId: string,
  review: Pick<InboxReviewThread, "latest_review_id" | "reviewed_at"> | null,
): InboxReviewLanding {
  const landedAt = pull.at ? Date.parse(pull.at) : NaN;
  const newer = !!review && !Number.isNaN(landedAt) && Date.parse(review.reviewed_at) > landedAt + INBOX_REVIEW_CLOCK_SKEW_MS;
  return { key: pull.key, thread_id: threadId, state: pull.state, at: pull.at, url: pull.url, number: pull.number, title: pull.title, platform: pull.platform, head: pull.head, through_review: review && !newer ? review.latest_review_id : null };
}

/** One row of the Reviews page. */
export interface InboxReviewRow {
  /** The thread's id for a thread's row; the stack's id for a PR row. */
  id: string;
  /** It has a review thread (or one is being curated): false only for a PR row. */
  reviewed: boolean;
  move: InboxReviewMove;
  reason: InboxReviewReason;
  /** The thread the row opens: the review thread, or the agent's thread a PR row's URL link names; null when none. */
  thread_id: string | null;
  /** The thread's reviews; null for a handed PR not reviewed yet and for a PR row. */
  review: InboxReviewThread | null;
  /** The stacks of PRs this row is about (a PR row: exactly one). */
  stacks: InboxPullStack[];
  /** The PRs the thread owns (owner choice or the agent's own link), or a PR row's open layers. */
  pull_keys: string[];
  /** The agent's thread behind the PRs, as the pulls list links it; null when none. */
  link: InboxPullLink | null;
  /** The pulls rule's reason for the PR part (its words: checks, reviewers); null without PRs. */
  pull_reason: InboxPullReason | null;
  /** The PRs of a thread with none still open that merged or closed: a review newer than them stays listed, with a link to each. */
  landed: InboxReviewLanding[];
  /** The latest activity: the thread's or any of its PRs'. */
  updated_at: string;
}

/** `GET /api/inbox/reviews`. */
export interface InboxReviewsAnswer {
  /** When the oldest of the forge hosts' answers was read; null when no host was asked. */
  fetched_at: string | null;
  /** The forge hosts asked, as the pulls list answers them. */
  hosts: InboxPullHost[];
  /** Newest first. */
  rows: InboxReviewRow[];
  /** `host/repo` (lowercased) → the Inbox projects on it. */
  projects: Record<string, string[]>;
}

/**
 * Whose move a review thread is. `pulls`: the open PRs the thread owns (none
 * for a local review). `review` null: a thread the person handed a PR to,
 * whose review has not arrived (the agent is curating).
 *
 * The person's own answer decides first: no answer yet is On you. Once they
 * gave the latest review a verdict, the verdict decides, whatever chat follows
 * it ("Thanks!", a yes to the agent's question): changes requested is With
 * your agents; an approval is Ready to land unless the forge holds the
 * person's own PR (a reviewer asked for changes or its checks failed: On you;
 * checks running, a draft, or reviewers still to answer: Waiting on others).
 * An answer with no verdict (comments or words) is With your agents. A review
 * of only a teammate's PRs takes no verdict here: answered, it is On you
 * while their review of it is asked of the person, else Waiting on others.
 */
export function inboxReviewMove(review: InboxReviewThread | null, pulls: readonly InboxPull[] = []): { move: InboxReviewMove; reason: InboxReviewReason } {
  if (!review) return { move: "agents", reason: "curating" };
  if (!review.answered && !review.verdict) return { move: "on_you", reason: "review_ready" };
  const open = pulls.filter(inboxPullIsOpen);
  if (open.length > 0 && open.every((pull) => !pull.mine)) {
    if (open.some((pull) => pull.requested)) return { move: "on_you", reason: "requested" };
    // Assigned stays on the person until they've given a verdict, like a request GitHub clears once they review.
    return !review.verdict && open.some((pull) => pull.assigned) ? { move: "on_you", reason: "assigned" } : { move: "waiting", reason: "others" };
  }
  if (review.verdict?.verdict !== "approved") return { move: "agents", reason: "feedback_sent" };
  const own = open.filter((pull) => pull.mine);
  if (own.some((pull) => pull.review === "changes_requested")) return { move: "on_you", reason: "changes" };
  if (own.some((pull) => pull.checks === "failure")) return { move: "on_you", reason: "failing" };
  if (own.some((pull) => pull.checks === "pending")) return { move: "waiting", reason: "checks_running" };
  if (own.some((pull) => pull.state === "draft")) return { move: "waiting", reason: "draft" };
  if (own.some((pull) => pull.review === "review_required" && pull.reviewers.length > 0)) return { move: "waiting", reason: "forge_review" };
  return { move: "ready", reason: "approved" };
}

const bareUrl = (url: string) => url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();

/**
 * The review is of this PR: its source names the PR (`source.pr`), or, for
 * the person's own PR from the repository itself (not a fork), its branch is
 * the PR's head branch, never a long-lived one (`main`, `develop`, …), in the
 * PR's repository when the source names one. A PR's URL merely mentioned in
 * the thread is not enough, and neither is a teammate's branch of the same name.
 */
export function inboxReviewIsOf(source: InboxReviewSource | null, pull: Pick<InboxPull, "url" | "head" | "repo" | "mine" | "head_repo">): boolean {
  if (!source) return false;
  if (source.pr) return bareUrl(source.pr.url) === bareUrl(pull.url);
  if (!pull.mine || (pull.head_repo !== null && pull.head_repo.toLowerCase() !== pull.repo.toLowerCase())) return false;
  if (!source.branch || source.branch !== pull.head || inboxPullLongLived(pull.head)) return false;
  if (!source.repo) return true;
  const repo = source.repo.toLowerCase();
  const of = pull.repo.toLowerCase();
  return repo === of || of.endsWith(`/${repo}`);
}

/** A PR row (no review thread): On you when a teammate asked for the person's review, else not reviewed. */
export function inboxReviewPullMove(stack: InboxPullStack): { move: InboxReviewMove; reason: InboxReviewReason } {
  const theirs = stack.layers.filter((pull) => inboxPullIsOpen(pull) && !pull.mine);
  if (theirs.some((pull) => pull.assigned) && !theirs.some((pull) => pull.requested)) return { move: "on_you", reason: "assigned" };
  return theirs.some((pull) => pull.requested) ? { move: "on_you", reason: "requested" } : { move: "not_reviewed", reason: "not_reviewed" };
}

export interface InboxReviewGroups {
  on_you: InboxReviewRow[];
  agents: InboxReviewRow[];
  ready: InboxReviewRow[];
  waiting: InboxReviewRow[];
  not_reviewed: InboxReviewRow[];
}

/** The rows by whose move it is, the latest first in each group. */
export function inboxReviewGroups(rows: readonly InboxReviewRow[]): InboxReviewGroups {
  const groups: InboxReviewGroups = { on_you: [], agents: [], ready: [], waiting: [], not_reviewed: [] };
  for (const row of [...rows].sort(byNewest)) groups[row.move].push(row);
  return groups;
}

const byNewest = (a: { updated_at: string }, b: { updated_at: string }) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0);
const latest = (times: readonly string[]) => times.reduce((a, b) => (b > a ? b : a), "");

const landingFields = (pull: InboxPull) => ({
  key: pull.key,
  url: pull.url,
  number: pull.number,
  title: pull.title,
  platform: pull.platform,
  state: pull.state === "closed" ? ("closed" as const) : ("merged" as const),
  at: pull.merged_at ?? pull.updated_at,
  head: pull.head,
});

/** The review is of a landed PR: its source names it or its branch; a review with no source is taken to be of it. */
function reviewIsOfLanding(review: InboxReviewThread, landed: readonly InboxReviewLanding[]): boolean {
  const source = review.source;
  if (!source) return true;
  if (source.pr) return landed.some((landing) => bareUrl(landing.url) === bareUrl(source.pr!.url));
  return !!source.branch && landed.some((landing) => landing.head === source.branch);
}

/**
 * Per thread: the PRs it owns and the link that ties them. A PR the person handed it (`via: "owner"`), or one the
 * thread's latest review is of (`inboxReviewIsOf`).
 */
function reviewOwned(byThread: ReadonlyMap<string, InboxReviewThread>, pulls: Iterable<InboxPull>, links: Readonly<Record<string, InboxPullLink>>): Map<string, { pulls: InboxPull[]; link: InboxPullLink }> {
  const owned = new Map<string, { pulls: InboxPull[]; link: InboxPullLink }>();
  for (const pull of pulls) {
    const link = links[pull.key];
    if (!link) continue;
    const thread = byThread.get(link.thread_id);
    if (link.via !== "owner" && !(thread && inboxReviewIsOf(thread.source, pull))) continue;
    const entry = owned.get(link.thread_id) ?? { pulls: [], link };
    entry.pulls.push(pull);
    owned.set(link.thread_id, entry);
  }
  return owned;
}

/**
 * What a read of the list changes in the records: a PR a thread owns seen merged is recorded (once: it keeps the review
 * it was first seen against), and a recorded PR seen open again (reopened) is forgotten.
 */
export function inboxReviewLandingChanges(input: {
  threads: readonly InboxReviewThread[];
  pulls: readonly InboxPull[];
  links: Readonly<Record<string, InboxPullLink>>;
  landed: readonly InboxReviewLanding[];
}): { record: InboxReviewLanding[]; forget: string[] } {
  const byThread = new Map(input.threads.map((thread) => [thread.thread_id, thread]));
  const known = new Set(input.landed.map((landing) => inboxReviewLandingId(landing)));
  const record: InboxReviewLanding[] = [];
  for (const [threadId, own] of reviewOwned(byThread, input.pulls, input.links)) {
    for (const pull of own.pulls) if (!inboxPullIsOpen(pull) && !known.has(inboxReviewLandingId({ key: pull.key, thread_id: threadId }))) record.push(inboxReviewLandingOf(landingFields(pull), threadId, byThread.get(threadId) ?? null));
  }
  const openNow = new Set(input.pulls.filter(inboxPullIsOpen).map((pull) => pull.key));
  return { record, forget: input.landed.filter((landing) => openNow.has(landing.key)).map((landing) => landing.key) };
}

/**
 * The Reviews rows: one per review thread (with the PRs it owns), one per
 * thread handed a PR whose review has not arrived, and one per stack no row
 * owns (not reviewed). `links`: the pulls list's links (the person's owner
 * choice, else the agent's own URL), by pull key. `pulls`: every PR the list
 * read, merged ones included (default: the stacks' layers).
 *
 * - A thread owns a PR the person handed it (`via: "owner"`); through the
 *   agent's own URL only when the thread's latest review is of that PR
 *   (`inboxReviewIsOf`), so a PR merely mentioned stays its own row.
 * - Landed: a thread whose PRs all merged or closed leaves Reviews while its
 *   latest review is the one it had then (`through_review`; the work is done;
 *   the thread stays in the Inbox, and the approved page has no group for done
 *   work). A later review is listed, as a review with no open PR and links to
 *   the PRs (`landed`), until the person approves it. `landed`: the records
 *   (`inboxReviewLandingChanges`), which outlive the list's read of merged PRs.
 * - Archived: a resolved thread is left out while its latest review is no
 *   newer than the archive, unless it still owns an open PR. A review sent
 *   after the archive brings it back, as the Inbox brings the thread back.
 */
export function inboxReviewRows(input: {
  threads: readonly InboxReviewThread[];
  stacks: readonly InboxPullStack[];
  links: Readonly<Record<string, InboxPullLink>>;
  pulls?: readonly InboxPull[];
  /** The pulls rule's reason per stack (`inboxPullItems`), by stack id. */
  pullReasons?: ReadonlyMap<string, InboxPullReason>;
  /** The recorded landings. A merged PR in `pulls` with no record yet counts the same. */
  landed?: readonly InboxReviewLanding[];
  /** Every PR the person handed to a thread (pull key → thread), on the list or not: one with no record may still be open. */
  owners?: ReadonlyMap<string, { thread_id: string }>;
  /** The thread is archived or gone. One that owns PRs and has no review stops curating: its PRs are listed again. */
  closed?: (threadId: string) => boolean;
}): InboxReviewRow[] {
  const byThread = new Map(input.threads.map((thread) => [thread.thread_id, thread]));
  const all = new Map<string, InboxPull>();
  for (const pull of input.pulls ?? input.stacks.flatMap((s) => s.layers)) if (!all.has(pull.key)) all.set(pull.key, pull);
  const owned = reviewOwned(byThread, all.values(), input.links);
  const recorded = input.landed ?? [];
  const ownersOf = new Map<string, string[]>();
  for (const [key, owner] of input.owners ?? []) ownersOf.set(owner.thread_id, [...(ownersOf.get(owner.thread_id) ?? []), key]);
  const ownedKeys = (threadId: string, review: InboxReviewThread | null): string[] => {
    const named = review?.source?.pr ? inboxPullRefOfUrl(review.source.pr.url)?.key : null;
    return [...(ownersOf.get(threadId) ?? []), ...(owned.get(threadId)?.pulls.map((pull) => pull.key) ?? []), ...(named ? [named] : [])];
  };
  const landingsOf = (threadId: string, pulls: readonly InboxPull[], review: InboxReviewThread | null): InboxReviewLanding[] => [
    ...recorded.filter((landing) => landing.thread_id === threadId),
    ...pulls.filter((pull) => !inboxPullIsOpen(pull) && !recorded.some((landing) => landing.key === pull.key && landing.thread_id === threadId)).map((pull) => inboxReviewLandingOf(landingFields(pull), threadId, review)),
  ];
  const stacksOf = (pulls: readonly InboxPull[]) => input.stacks.filter((stack) => stack.layers.some((layer) => inboxPullIsOpen(layer) && pulls.some((p) => p.key === layer.key)));

  const rows: InboxReviewRow[] = [];
  const attached = new Set<string>();
  const reasonOf = (stacks: readonly InboxPullStack[]) => (stacks[0] ? input.pullReasons?.get(stacks[0].id) ?? null : null);
  const push = (threadId: string, review: InboxReviewThread | null, own: { pulls: InboxPull[]; link: InboxPullLink } | undefined) => {
    const pulls = own?.pulls ?? [];
    const open = pulls.filter(inboxPullIsOpen);
    // Landed: every PR it owns merged or closed, and no review came after, or the person approved the one that did.
    const landed = open.length === 0 ? landingsOf(threadId, pulls, review) : [];
    // Only when every PR it owns is accounted for: one with no record may be open, just off this list.
    const allDone = landed.length > 0 && ownedKeys(threadId, review).every((key) => landed.some((landing) => landing.key === key));
    if (allDone && (!review || landed.some((landing) => landing.through_review === review.latest_review_id) || (review.verdict?.verdict === "approved" && reviewIsOfLanding(review, landed)))) return;
    if (review?.resolved_at && review.reviewed_at <= review.resolved_at && open.length === 0) return;
    const stacks = stacksOf(open);
    for (const stack of stacks) attached.add(stack.id);
    rows.push({
      id: threadId,
      reviewed: true,
      ...inboxReviewMove(review, open),
      thread_id: threadId,
      review,
      stacks,
      pull_keys: pulls.filter((p) => stacks.some((s) => s.layers.some((l) => l.key === p.key))).map((p) => p.key),
      link: own?.link ?? null,
      pull_reason: reasonOf(stacks),
      landed,
      updated_at: latest([review?.updated_at ?? own?.link.last?.at ?? "", ...open.map((p) => p.updated_at)]),
    });
  };
  for (const thread of input.threads) push(thread.thread_id, thread, owned.get(thread.thread_id));
  // Curating only while someone can: with the agent ended or the thread closed, the PR is back to not reviewed (its stack row, the stack view's Start a new review thread).
  for (const [threadId, own] of owned) if (!byThread.has(threadId) && own.link.agent?.ended !== true && !input.closed?.(threadId)) push(threadId, null, own);
  for (const stack of input.stacks) {
    if (attached.has(stack.id)) continue;
    // The agent's own thread, when its message names one of the layers (topmost open first): shown, never a review.
    const link =
      [...stack.layers].reverse().map((layer) => (inboxPullIsOpen(layer) ? input.links[layer.key] : undefined)).find((l): l is InboxPullLink => !!l) ??
      stack.layers.map((layer) => input.links[layer.key]).find((l): l is InboxPullLink => !!l) ??
      null;
    rows.push({
      id: stack.id,
      reviewed: false,
      ...inboxReviewPullMove(stack),
      thread_id: link?.thread_id ?? null,
      review: null,
      stacks: [stack],
      pull_keys: stack.layers.filter(inboxPullIsOpen).map((p) => p.key),
      link,
      pull_reason: reasonOf([stack]),
      landed: [],
      updated_at: latest(stack.layers.map((p) => p.updated_at)),
    });
  }
  return rows.sort(byNewest);
}
