import { inboxPullIsOpen, inboxPullLongLived, inboxPullRefOfUrl, type InboxPull, type InboxPullHost, type InboxPullLink, type InboxPullReason, type InboxPullStack } from "./inbox-pulls";
import type { InboxReviewVerdict } from "./inbox-review";

/** Where a review's changes came from: the guide snapshot's `source` and `review` (base), as the message records them. */
export interface InboxReviewSource {
  kind: "local" | "pr" | "workspace" | "commit";
  repo?: string;
  branch?: string;
  base?: string;
  git_ref?: string;
  head_sha?: string;
  pr?: { url: string; number?: number; platform?: "github" | "gitlab" };
}

/** A source field is kept as one line of at most this many characters (the agent wrote it). */
export const INBOX_REVIEW_SOURCE_FIELD_MAX = 300;

const KINDS: readonly InboxReviewSource["kind"][] = ["local", "pr", "workspace", "commit"];

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
  comments: number;
  message_id: string;
  at: string;
}

/**
 * One thread's reviews: the per-thread review index (derived from the thread's messages on read,
 * never stored).
 */
export interface InboxReviewThread {
  thread_id: string;
  project_id: string;
  subject: string | null;
  first_review_id: string;
  latest_review_id: string;
  round: number;
  title: string;
  files: number;
  additions: number;
  deletions: number;
  agent: { host: string | null; session: string | null; name: string | null } | null;
  source: InboxReviewSource | null;
  verdict: InboxReviewVerdictMark | null;
  answered: { message_id: string; at: string } | null;
  reviewed_at: string;
  updated_at: string;
  resolved_at: string | null;
  walkthrough?: true;
}

export type InboxReviewMove = "on_you" | "agents" | "ready" | "waiting" | "not_reviewed";

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

export interface InboxReviewLanding {
  key: string;
  thread_id: string;
  state: "merged" | "closed";
  at: string | null;
  url: string;
  number: number;
  title: string;
  platform: InboxPull["platform"];
  head: string | null;
  through_review: string | null;
}

/** The review's time is this machine's and the merge's is the forge's. */
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

/** Which local changes a New review is of. */
export type InboxReviewChanges = "uncommitted" | "last" | "branch";

/** A pull request link's PR, which may be in no project and on no list: enough for its row. */
export interface InboxReviewLinkPull {
  key: string;
  url: string;
  number: number;
  title: string;
  platform: InboxPull["platform"];
  mine: boolean;
}

/** New review on local changes or a link: what the box asked for, so its row shows "Curating…" before any review arrives. */
export interface InboxReviewStart {
  kind: "local" | "link" | "walkthrough";
  changes: InboxReviewChanges | null;
  pull?: InboxReviewLinkPull;
  branch: string | null;
  base: string | null;
  ask: "guide" | "custom";
  host: string;
  project_id: string;
  at: string;
  name?: string | null;
}

/** A `review` field from a Send, checked; null when it isn't one. */
export function inboxReviewStartOf(value: unknown, where: Pick<InboxReviewStart, "host" | "project_id" | "at">): InboxReviewStart | null {
  if (!value || typeof value !== "object") return null;
  const review = value as Record<string, unknown>;
  if (review.kind === "link") {
    const ref = typeof review.url === "string" ? inboxPullRefOfUrl(review.url) : null;
    if (!ref) return null;
    const pull = { key: ref.key, url: review.url as string, number: ref.number, title: typeof review.title === "string" ? review.title.slice(0, 300) : "", platform: ref.platform, mine: review.mine === true };
    return { kind: "link", changes: null, pull, branch: null, base: null, ask: review.ask === "custom" ? "custom" : "guide", ...where };
  }
  if (review.kind === "walkthrough") return { kind: "walkthrough", changes: null, branch: null, base: null, ask: "custom", ...where };
  if (review.kind !== "local" || (review.changes !== "uncommitted" && review.changes !== "last" && review.changes !== "branch")) return null;
  const ref = (ref: unknown) => (typeof ref === "string" && ref.length > 0 && ref.length <= 200 ? ref : null);
  return { kind: "local", changes: review.changes, branch: ref(review.branch), base: ref(review.base), ask: review.ask === "custom" ? "custom" : "guide", ...where };
}

export function inboxReviewLinkOf(text: string): { url: string; ref: NonNullable<ReturnType<typeof inboxPullRefOfUrl>> } | { unsupported: "bitbucket" | "host" } | null {
  const typed = text.trim();
  const short = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)$/.exec(typed);
  const url = short ? `https://github.com/${short[1]}/pull/${short[2]}` : typed;
  const ref = inboxPullRefOfUrl(url);
  if (ref?.host.startsWith("-") || ref?.repo.split("/").some((part) => part.startsWith("-"))) return null;
  if (ref) return { url: `https://${ref.host}/${ref.repo}/${ref.platform === "gitlab" ? "-/merge_requests" : "pull"}/${ref.number}`, ref };
  let address: URL;
  try {
    address = new URL(typed);
  } catch {
    return null;
  }
  if (address.protocol !== "https:" && address.protocol !== "http:") return null;
  if (/(^|\.)bitbucket\./.test(address.hostname)) return { unsupported: "bitbucket" };
  return /pull|merge/i.test(address.pathname) ? { unsupported: "host" } : null;
}

/** `GET /api/inbox/reviews/link`: what a pull request link is, read once. */
export type InboxReviewLinkAnswer =
  | {
      ok: true;
      cli: "gh" | "glab";
      pull: InboxPull;
      projects: string[];
      thread_id: string | null;
    }
  | { ok: false; reason: "not_a_link" | "bitbucket" | "host" }
  | { ok: false; reason: "failed" }
  | { ok: false; reason: "unreadable"; cli: "gh" | "glab"; host: string };

/** `GET /api/inbox/reviews/changes`: the size of those changes. `git: false`: the project is not a repository. */
export interface InboxReviewChangesAnswer {
  git: boolean;
  files: number;
  additions: number;
  deletions: number;
  branch: string | null;
  base: string | null;
}

/** The files and lines a unified patch changes. */
export function inboxReviewPatchSize(patch: string): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files += 1;
      inHunk = false;
    } else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) additions += 1;
    else if (inHunk && line.startsWith("-")) deletions += 1;
  }
  return { files, additions, deletions };
}

/** One row of the Reviews page. */
export interface InboxReviewRow {
  id: string;
  reviewed: boolean;
  move: InboxReviewMove;
  reason: InboxReviewReason;
  thread_id: string | null;
  review: InboxReviewThread | null;
  stacks: InboxPullStack[];
  pull_keys: string[];
  link: InboxPullLink | null;
  pull_reason: InboxPullReason | null;
  landed: InboxReviewLanding[];
  updated_at: string;
  started?: InboxReviewStart | null;
}

/** `GET /api/inbox/reviews`. */
export interface InboxReviewsAnswer {
  fetched_at: string | null;
  hosts: InboxPullHost[];
  rows: InboxReviewRow[];
  projects: Record<string, string[]>;
}

/** Whose move a review thread is. */
export function inboxReviewMove(review: InboxReviewThread | null, pulls: readonly InboxPull[] = [], posted = false): { move: InboxReviewMove; reason: InboxReviewReason } {
  if (!review) return { move: "agents", reason: "curating" };
  const open = pulls.filter(inboxPullIsOpen);
  const theirs = open.length > 0 && open.every((pull) => !pull.mine);
  if (!review.answered && !review.verdict && !(theirs && posted)) return { move: "on_you", reason: "review_ready" };
  if (theirs) return open.some((pull) => pull.requested) ? { move: "on_you", reason: "requested" } : { move: "waiting", reason: "others" };
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

/** The person's last review posted on a PR from here. `head`: the commit it was on; null on one kept before heads were. */
export interface InboxReviewPosted {
  at: string;
  head: string | null;
}

/**
 * A PR row (no review thread): On you when a teammate asked for the person's review, else not
 * reviewed.
 */
export function inboxReviewPullMove(stack: InboxPullStack, posted?: ReadonlyMap<string, InboxReviewPosted>): { move: InboxReviewMove; reason: InboxReviewReason } {
  const theirs = stack.layers.filter((pull) => inboxPullIsOpen(pull) && !pull.mine);
  if (theirs.some((pull) => pull.requested)) return { move: "on_you", reason: "requested" };
  const assigned = theirs.filter((pull) => pull.assigned);
  if (assigned.length === 0) return { move: "not_reviewed", reason: "not_reviewed" };
  const answered = (pull: InboxPull) => {
    const review = posted?.get(pull.key);
    return !!review && (!review.head || !pull.head_sha || review.head === pull.head_sha);
  };
  return assigned.every(answered) ? { move: "waiting", reason: "others" } : { move: "on_you", reason: "assigned" };
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

function reviewIsOfLanding(review: InboxReviewThread, landed: readonly InboxReviewLanding[]): boolean {
  const source = review.source;
  if (!source) return true;
  if (source.pr) return landed.some((landing) => bareUrl(landing.url) === bareUrl(source.pr!.url));
  return !!source.branch && landed.some((landing) => landing.head === source.branch);
}

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

export function inboxReviewRows(input: {
  threads: readonly InboxReviewThread[];
  stacks: readonly InboxPullStack[];
  links: Readonly<Record<string, InboxPullLink>>;
  pulls?: readonly InboxPull[];
  pullReasons?: ReadonlyMap<string, InboxPullReason>;
  landed?: readonly InboxReviewLanding[];
  owners?: ReadonlyMap<string, { thread_id: string }>;
  started?: ReadonlyMap<string, InboxReviewStart>;
  ended?: (threadId: string) => boolean;
  posted?: ReadonlyMap<string, InboxReviewPosted>;
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
    const landed = open.length === 0 ? landingsOf(threadId, pulls, review) : [];
    const allDone = landed.length > 0 && ownedKeys(threadId, review).every((key) => landed.some((landing) => landing.key === key));
    if (allDone && (!review || landed.some((landing) => landing.through_review === review.latest_review_id) || (review.verdict?.verdict === "approved" && reviewIsOfLanding(review, landed)))) return;
    if (review?.resolved_at && review.reviewed_at <= review.resolved_at && open.length === 0) return;
    const stacks = stacksOf(open);
    for (const stack of stacks) attached.add(stack.id);
    rows.push({
      id: threadId,
      reviewed: true,
      ...inboxReviewMove(review, open, !!review && open.every((pull) => (input.posted?.get(pull.key)?.at ?? "") >= review.reviewed_at)),
      thread_id: threadId,
      review,
      stacks,
      pull_keys: pulls.filter((p) => stacks.some((s) => s.layers.some((l) => l.key === p.key))).map((p) => p.key),
      link: own?.link ?? null,
      pull_reason: reasonOf(stacks),
      landed,
      updated_at: latest([review?.updated_at ?? own?.link.last?.at ?? input.started?.get(threadId)?.at ?? "", ...open.map((p) => p.updated_at)]),
      started: input.started?.get(threadId) ?? null,
    });
  };
  for (const thread of input.threads) push(thread.thread_id, thread, owned.get(thread.thread_id));
  for (const [threadId, own] of owned) if (!byThread.has(threadId) && own.link.agent?.ended !== true) push(threadId, null, own);
  for (const threadId of input.started?.keys() ?? []) if (!byThread.has(threadId) && !owned.has(threadId) && !input.ended?.(threadId)) push(threadId, null, undefined);
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
      ...inboxReviewPullMove(stack, input.posted),
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
