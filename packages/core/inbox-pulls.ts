/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5; concept B, take 1): the shapes the server answers and the pure rules
 * the window and the server share. Browser-safe, no dependencies. Reached
 * through `@plannotator/core/inbox-types`, so core's export map is unchanged.
 *
 * - A pull request (GitHub) or merge request (GitLab) as the Inbox reads it
 *   from the person's own `gh` / `glab` (`InboxPull`).
 * - Stacks (`inboxPullStacks`): a PR whose base branch is another open PR's
 *   head branch, in the same repository, is the next layer of that PR's
 *   stack. A merged PR whose head is still the base of a stack's lowest open
 *   layer sits under it. Every other open PR is a stack of one.
 * - Whose move it is (`inboxPullMove`, `inboxPullItems`, `inboxPullGroups`):
 *   On you, Ready to land, or waiting on others.
 */

export type InboxPullPlatform = "github" | "gitlab";
export type InboxPullState = "open" | "draft" | "merged" | "closed";
export type InboxPullChecks = "success" | "failure" | "pending";
export type InboxPullReview = "approved" | "changes_requested" | "review_required";

/** One pull request (or merge request) the person's CLI found for them. */
export interface InboxPull {
  /** `host/owner/repo#n` lowercased (GitLab adds `:pull`): the hover cards' key (`forgeRefKey`). */
  key: string;
  platform: InboxPullPlatform;
  host: string;
  /** `owner/repo` (GitLab: the project's full path). */
  repo: string;
  number: number;
  url: string;
  title: string;
  /** The author's login, or null when the forge did not say. */
  author: string | null;
  /** The person (the CLI's signed-in account) wrote it. */
  mine: boolean;
  /** Review was requested from the person (or one of their teams). */
  requested: boolean;
  state: InboxPullState;
  /** The branch it merges into. */
  base: string;
  /** Its own branch. */
  head: string;
  /** The repository its head branch lives in (`owner/repo`); another one is a fork. Null when unknown. */
  head_repo: string | null;
  additions: number;
  deletions: number;
  files: number;
  review: InboxPullReview | null;
  /** Who approved it first, when someone did. */
  approved_by: string | null;
  /** The people (or teams) asked to review who have not yet, at most a few. */
  reviewers: string[];
  /** The latest commit's checks (GitHub's rollup, GitLab's head pipeline); null when none ran. */
  checks: InboxPullChecks | null;
  updated_at: string;
  merged_at: string | null;
}

/** How a PR was tied to an agent's thread. */
export type InboxPullLinkVia = "card" | "url" | "branch";

/** The agent's thread (and Board card) a PR is tied to, read on this computer only. */
export interface InboxPullLink {
  via: InboxPullLinkVia;
  thread_id: string;
  thread_subject: string | null;
  project_id: string;
  /** The agent that last wrote in the thread. */
  agent: { host: string | null; session: string | null; name: string | null } | null;
  /** The agent's last message there: what Reply answers, and its words, cut. */
  last: { message_id: string; preview: string; at: string } | null;
  /** The thread's latest Guided Review, when the agent sent one. */
  guide: { message_id: string; title: string; steps: number } | null;
  /** The Board card that links the PR (or links the thread), when there is one. */
  card: { id: string; title: string; column: string } | null;
}

/** One host the Inbox asked, and as whom. */
export interface InboxPullHost {
  cli: "gh" | "glab";
  host: string;
  login: string | null;
  /** Why this host gave nothing this time; absent when it answered. */
  error?: "rate_limited" | "unavailable";
}

/** `GET /api/inbox/pulls`. */
export interface InboxPullsAnswer {
  /** When the oldest of the hosts' answers was read; null when no host was asked. */
  fetched_at: string | null;
  hosts: InboxPullHost[];
  pulls: InboxPull[];
  /** By pull key: the agent's thread, when one is tied to it. */
  links: Record<string, InboxPullLink>;
  /** `host/repo` (lowercased) → the Inbox project it belongs to. */
  projects: Record<string, string>;
}

/** `GET /api/inbox/pulls/diff`: the patch of one layer, or of the stack up to that layer. */
export interface InboxPullDiffAnswer {
  key: string;
  scope: InboxPullDiffScope;
  /** What the diff runs from and to, for the header ("main...retry-schedule"). */
  base: string;
  head: string;
  patch: string;
}

export type InboxPullDiffScope = "layer" | "stack";

/** The CLI's answers are this many PRs per search at most. */
export const INBOX_PULLS_SEARCH_MAX = 50;
/** Merged PRs are asked back this many days (to put a stack's merged layers under it). */
export const INBOX_PULLS_MERGED_DAYS = 14;

/** `#412` on GitHub, `!61` on GitLab. */
export function inboxPullLabel(pull: Pick<InboxPull, "platform" | "number">): string {
  return `${pull.platform === "gitlab" ? "!" : "#"}${pull.number}`;
}

const repoKey = (pull: Pick<InboxPull, "host" | "repo">) => `${pull.host}/${pull.repo}`.toLowerCase();

/** The key of a repository on a host, as `InboxPullsAnswer.projects` holds it. */
export function inboxPullRepoKey(host: string, repo: string): string {
  return `${host}/${repo}`.toLowerCase();
}

const isOpen = (pull: InboxPull) => pull.state === "open" || pull.state === "draft";
/** A head branch in the repository itself (a fork's branch of the same name is another branch). */
const ownHead = (pull: InboxPull) => pull.head_repo === null || pull.head_repo.toLowerCase() === pull.repo.toLowerCase();

/** A stack: its layers from the bottom (merged first, then the lowest open layer) to the top. */
export interface InboxPullStack {
  /** The top layer's key: one stack, one id, while its top stays. */
  id: string;
  platform: InboxPullPlatform;
  host: string;
  repo: string;
  /** Bottom to top. */
  layers: InboxPull[];
  /** The branch the bottom layer merges into (`main`). */
  base: string;
  /**
   * The branch the lowest open layer is based on: "Whole stack" runs from it, so layers already merged (a squash
   * merge leaves their commits under the open ones) are not read again. `base` when no layer is merged.
   */
  open_base: string;
}

/** Long-lived branches: a merged PR from one of them (a release `develop → main`) is never a stack's bottom layer. */
const LONG_LIVED = /^(main|master|trunk|develop|dev|staging|production|release([/-].*)?)$/;

/**
 * The stacks among the PRs: one per chain of open PRs where each one's base is
 * the head of the one under it, in the same repository; every other open PR is
 * a stack of one. Merged PRs whose head is still the base of a stack's lowest
 * open layer go under it (at most 5), unless that head is a long-lived branch
 * or the base of another open PR outside the stack (then it is a shared
 * branch, not a layer). Closed PRs, and merged PRs under no
 * stack, are left out. A branch with two PRs on it (a tree) is one stack, its
 * layers in depth order, siblings by number. Stacks come in the PRs' order of
 * their top layers.
 */
export function inboxPullStacks(pulls: readonly InboxPull[]): InboxPullStack[] {
  const seen = new Set<string>();
  const unique = pulls.filter((pull) => (seen.has(pull.key) ? false : (seen.add(pull.key), true)));
  const open = unique.filter(isOpen);
  const merged = unique.filter((pull) => pull.state === "merged");
  const headOf = new Map<string, InboxPull>();
  for (const pull of open) {
    if (!ownHead(pull)) continue;
    const at = `${repoKey(pull)}\u0000${pull.head}`;
    if (!headOf.has(at)) headOf.set(at, pull);
  }
  const parentOf = (pull: InboxPull): InboxPull | null => {
    const parent = headOf.get(`${repoKey(pull)}\u0000${pull.base}`);
    return parent && parent.key !== pull.key ? parent : null;
  };
  const children = new Map<string, InboxPull[]>();
  const roots: InboxPull[] = [];
  for (const pull of open) {
    const parent = parentOf(pull);
    // A loop (a's base is b's head and b's base a's head) has no root: its lowest number roots it.
    if (parent && !loops(pull, parentOf)) {
      const list = children.get(parent.key) ?? [];
      list.push(pull);
      children.set(parent.key, list);
    } else roots.push(pull);
  }
  const stacks: InboxPullStack[] = [];
  for (const root of roots) {
    // Depth order, siblings by number: a chain reads bottom to top.
    const layers: InboxPull[] = [];
    let level = [root];
    while (level.length > 0) {
      layers.push(...level);
      level = level.flatMap((pull) => [...(children.get(pull.key) ?? [])].sort((a, b) => a.number - b.number));
    }
    const under: InboxPull[] = [];
    let base = root.base;
    for (let i = 0; i < 5; i++) {
      const below = merged.find(
        (pull) =>
          ownHead(pull) &&
          repoKey(pull) === repoKey(root) &&
          pull.head === base &&
          !under.includes(pull) &&
          !LONG_LIVED.test(pull.head) &&
          !open.some((other) => repoKey(other) === repoKey(root) && other.base === pull.head && !layers.includes(other)),
      );
      if (!below) break;
      under.unshift(below);
      base = below.base;
    }
    const all = [...under, ...layers];
    stacks.push({ id: all[all.length - 1]!.key, platform: root.platform, host: root.host, repo: root.repo, layers: all, base: all[0]!.base, open_base: root.base });
  }
  const order = new Map(unique.map((pull, i) => [pull.key, i]));
  return stacks.sort((a, b) => Math.min(...a.layers.map((l) => order.get(l.key)!)) - Math.min(...b.layers.map((l) => order.get(l.key)!)));
}

/** In a loop of PRs (each one's base the next one's head), the lowest number is the bottom: it takes no parent. */
function loops(pull: InboxPull, parentOf: (pull: InboxPull) => InboxPull | null): boolean {
  const path = [pull];
  let at = parentOf(pull);
  while (at && !path.some((p) => p.key === at!.key)) {
    path.push(at);
    at = parentOf(at);
  }
  if (!at || at.key !== pull.key) return false;
  return pull.number === Math.min(...path.map((p) => p.number));
}

/** The lowest layer still open: the next to land. Null when none is. */
export function inboxPullLandsNext(stack: InboxPullStack): InboxPull | null {
  return stack.layers.find(isOpen) ?? null;
}

export type InboxPullMove = "on_you" | "ready" | "waiting";

/**
 * Why a PR is where it is; the window turns it into words:
 * - `requested`: a teammate asked for the person's review;
 * - `agent_ready`: the person's agent opened it (not a draft, its checks done), so the person reviews it;
 * - `running`: the person's agent opened it and its checks still run;
 * - `changes`: a reviewer asked for changes on the person's PR;
 * - `failing`: its checks failed;
 * - `approved`: approved, checks passed (or none ran);
 * - `approved_running`: approved, checks still running;
 * - `draft`: still a draft;
 * - `review`: the person's PR, waiting on reviewers;
 * - `others`: a teammate's PR in a stack, not asked of the person;
 * - `merged` / `closed`.
 */
export type InboxPullReason =
  | "requested"
  | "agent_ready"
  | "running"
  | "changes"
  | "failing"
  | "approved"
  | "approved_running"
  | "draft"
  | "review"
  | "others"
  | "merged"
  | "closed";

/** Whose move one PR is, and why. `linked`: an agent's thread is tied to it. */
export function inboxPullMove(pull: InboxPull, linked: boolean): { move: InboxPullMove; reason: InboxPullReason } {
  if (pull.state === "merged") return { move: "waiting", reason: "merged" };
  if (pull.state === "closed") return { move: "waiting", reason: "closed" };
  if (pull.state === "draft") return { move: "waiting", reason: "draft" };
  if (pull.requested && !pull.mine) return { move: "on_you", reason: "requested" };
  if (!pull.mine) return { move: "waiting", reason: "others" };
  if (pull.review === "changes_requested") return { move: "on_you", reason: "changes" };
  if (pull.checks === "failure") return { move: "on_you", reason: "failing" };
  if (pull.review === "approved") return pull.checks === "pending" ? { move: "waiting", reason: "approved_running" } : { move: "ready", reason: "approved" };
  if (linked) return pull.checks === "pending" ? { move: "waiting", reason: "running" } : { move: "on_you", reason: "agent_ready" };
  return { move: "waiting", reason: "review" };
}

/** One row of the list: a stack (one PR or several), whose move it is, and the layer the row speaks of. */
export interface InboxPullItem {
  stack: InboxPullStack;
  move: InboxPullMove;
  /** The layer the row's words are about: the first that is on the person, else the next to land. */
  focus: InboxPull;
  reason: InboxPullReason;
  /** The latest update of any layer. */
  updated_at: string;
}

/**
 * Each stack as one row. A stack is on the person when any open layer is; it
 * is ready to land when its next layer to land is ready; else it waits on
 * others.
 */
export function inboxPullItems(stacks: readonly InboxPullStack[], linked: (pull: InboxPull) => boolean): InboxPullItem[] {
  return stacks.map((stack) => {
    const next = inboxPullLandsNext(stack) ?? stack.layers[stack.layers.length - 1]!;
    // A link on any layer of the stack is the stack's agent.
    const agent = stack.layers.some(linked);
    const moves = stack.layers.filter(isOpen).map((pull) => ({ pull, ...inboxPullMove(pull, agent || linked(pull)) }));
    const onYou = moves.find((m) => m.move === "on_you");
    const lands = moves.find((m) => m.pull.key === next.key) ?? { pull: next, ...inboxPullMove(next, agent) };
    const pick = onYou ?? lands;
    const move: InboxPullMove = onYou ? "on_you" : lands.move === "ready" ? "ready" : "waiting";
    const updated_at = stack.layers.map((l) => l.updated_at).sort().at(-1) ?? next.updated_at;
    return { stack, move, focus: pick.pull, reason: pick.reason, updated_at };
  });
}

export interface InboxPullGroups {
  on_you: InboxPullItem[];
  ready: InboxPullItem[];
  waiting: InboxPullItem[];
}

/** The rows by whose move it is, the latest update first in each group. */
export function inboxPullGroups(items: readonly InboxPullItem[]): InboxPullGroups {
  const byNewest = (a: InboxPullItem, b: InboxPullItem) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0);
  return {
    on_you: items.filter((i) => i.move === "on_you").sort(byNewest),
    ready: items.filter((i) => i.move === "ready").sort(byNewest),
    waiting: items.filter((i) => i.move === "waiting").sort(byNewest),
  };
}

/**
 * Pull and merge request URLs in a message's text, in order, each once, as
 * `host/owner/repo#n` keys' parts. Only https links that name a pull or merge
 * request (`/pull/N`, `/pulls/N`, `/-/merge_requests/N`).
 */
export function inboxPullUrlsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https:\/\/[A-Za-z0-9.-]+\/[^\s)<>\]"'`]+?\/(?:pulls?|-\/merge_requests)\/\d+/g)) {
    if (!found.includes(match[0])) found.push(match[0]);
  }
  return found;
}
