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
  /** The person is one of its assignees (GitHub `assignee:@me`, GitLab `assignedMergeRequests`); absent from an older Inbox. */
  assigned?: boolean;
  state: InboxPullState;
  /** The branch it merges into. */
  base: string;
  /** Its own branch. */
  head: string;
  /** The repository its head branch lives in (`owner/repo`); another one is a fork. Null when unknown. */
  head_repo: string | null;
  /**
   * Its head commit as the list read it (GitHub `headRefOid`, GitLab `diffHeadSha`): a review posted to the forge
   * from the Inbox is pinned to it. Absent or null when unknown (an older Inbox, a forge that did not say).
   */
  head_sha?: string | null;
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
  /** The forge says it conflicts with its base branch (GitHub `mergeable: CONFLICTING`, GitLab `conflicts`); absent when unknown. */
  conflicts?: boolean;
  /** Its repository's default branch as the forge answered it (GitHub `defaultBranchRef`, GitLab `rootRef`); absent when unknown. */
  default_branch?: string;
  updated_at: string;
  merged_at: string | null;
}

/**
 * How a PR was tied to an agent's thread: `owner`, the person handed it to an agent (or launched one for it) and
 * the Inbox keeps that choice; `url`, the PR's link in an agent's own message in a project of the PR's repository
 * (the agent opened it). Nothing else ties a PR to a thread: no branch guess, and the Board is never needed.
 */
export type InboxPullLinkVia = "owner" | "url";

/** A Board card that links a PR: a quiet extra, only while the Board is on. */
export interface InboxPullCard {
  id: string;
  title: string;
  column: string;
}

/** The agent's thread a PR is tied to, read on this computer only. */
export interface InboxPullLink {
  via: InboxPullLinkVia;
  thread_id: string;
  thread_subject: string | null;
  project_id: string;
  /**
   * The agent that last wrote in the thread. `ended`: its session sent with a wake (it polls while it runs) and is not
   * live now, or the session the person handed it to is gone: it stays named, marked ended.
   */
  agent: { host: string | null; session: string | null; name: string | null; ended?: boolean } | null;
  /** The person's hand-off (`via: "owner"`): the session it went to, which Hand again for leaves out with `agent`. */
  handed_to?: string | null;
  /** The agent's last message there: what Reply answers, and its words, cut. */
  last: { message_id: string; preview: string; at: string } | null;
  /** The thread's latest Guided Review, when the agent sent one; `review`: sent for a verdict (it opens as Start review). */
  guide: { message_id: string; title: string; steps: number; review: boolean } | null;
  /** `owner` only: what the hand-off asked for first (a guided review, or the person's own curation); absent for an older choice. */
  ask?: "guide" | "custom";
}

/** One host the Inbox asked, and as whom. */
export interface InboxPullHost {
  cli: "gh" | "glab";
  host: string;
  login: string | null;
  /** Why this host gave nothing this time; absent when it answered. */
  error?: "rate_limited" | "unavailable";
  /** With `error`: when the answer still shown for this host was read; absent when there is none (its PRs are not shown). */
  last_read?: string;
  /**
   * Why the Others read (every open PR of the projects' repositories, a read of its own) gave nothing this time; the
   * person's own lists are unaffected. Absent when it answered.
   */
  others_error?: "rate_limited" | "unavailable";
  /** With `others_error`: when the Others answer still shown was read; absent when there is none (Others is not shown). */
  others_last_read?: string;
  /** The Others read is running in the background (the list never waits for it): ask again shortly for its answer. */
  others_pending?: true;
  /**
   * The reads found more open PRs than they take: `shown`, the host's open PRs in this list; `total`, how many there
   * are. Null `total`: not known (the person's own searches were not limited to the projects' repositories, or Others
   * searched only the most active ones). `of: "others"`: only Others left PRs out; the person's own lists are whole.
   */
  capped?: { shown: number; total: number | null; of?: "others" };
}

/** A CLI as the Inbox found it: not installed, installed and signed in to no host, or signed in to at least one. */
export type InboxPullCliState = "missing" | "signed_out" | "signed_in";

/** `GET /api/inbox/pulls`. */
export interface InboxPullsAnswer {
  /** When the oldest of the hosts' answers was read; null when no host was asked. */
  fetched_at: string | null;
  hosts: InboxPullHost[];
  pulls: InboxPull[];
  /** By pull key: the agent's thread, when one is tied to it. */
  links: Record<string, InboxPullLink>;
  /** `host/repo` (lowercased) → the Inbox projects on it (two clones of one origin are two projects). */
  projects: Record<string, string[]>;
  /** By pull key: the Board card that links it. Empty while the Board is off (no Board UI then). */
  cards: Record<string, InboxPullCard>;
  /** The CLIs asked which hosts they are signed in to, as found. Absent on an older Inbox. */
  clis?: Partial<Record<"gh" | "glab", InboxPullCliState>>;
  /** Hosts of the projects' origins that no CLI here is signed in to (never asked). Absent on an older Inbox. */
  unsigned?: string[];
}

/** `GET /api/inbox/pulls/diff`: the patch of one layer, or of the stack up to that layer. */
export interface InboxPullDiffAnswer {
  key: string;
  scope: InboxPullDiffScope;
  /** What the diff runs from and to, for the header ("main...retry-schedule"). */
  base: string;
  head: string;
  patch: string;
  /**
   * The head commit this patch is of, read from the forge just before and just after the patch (null when they differ
   * or the forge did not say). The window keeps comments per this head; a review posted from the patch is pinned to it.
   */
  head_sha?: string | null;
}

export type InboxPullDiffScope = "layer" | "stack";

/**
 * `GET /api/inbox/pulls/description`: what the PR's author wrote on it (GitHub's body, GitLab's description), as
 * markdown, for the review's description line. Null when they wrote nothing. `cut`: longer than the Inbox reads
 * (`INBOX_PULL_DESCRIPTION_MAX`), the rest on the forge.
 */
export interface InboxPullDescriptionAnswer {
  key: string;
  body: string | null;
  cut?: true;
}

/** A description is read up to this many characters. */
export const INBOX_PULL_DESCRIPTION_MAX = 64_000;

/**
 * One changed file's whole text at both ends of its diff, so the viewer's gaps can open. Both null when there is
 * nothing to open into (see `GET /api/inbox/pulls/file`): the diff then shows as it came, with no arrows.
 */
export interface InboxFileContents {
  /** The forge did not answer (rate limited, offline): both texts are null for now, and asking again may work. */
  failed?: true;
  oldContent: string | null;
  newContent: string | null;
}

/** The CLI's answers are this many PRs per search at most. */
export const INBOX_PULLS_SEARCH_MAX = 50;
/** Merged PRs are asked back this many days (to put a stack's merged layers under it). */
export const INBOX_PULLS_MERGED_DAYS = 14;

/** `#412` on GitHub, `!61` on GitLab. */
export function inboxPullLabel(pull: Pick<InboxPull, "platform" | "number">): string {
  return `${pull.platform === "gitlab" ? "!" : "#"}${pull.number}`;
}

const repoKey = (pull: Pick<InboxPull, "host" | "repo">) => `${pull.host}/${pull.repo}`.toLowerCase();

/** At most this many PRs are handed to one agent at once (a stack's open layers): the owner route refuses more. */
export const INBOX_PULL_OWNER_KEYS_MAX = 20;

const BRANCH_NAME = /^[A-Za-z0-9._\/-]{1,250}$/;
/**
 * A branch name safe to put in a command (a compare) or in words an agent reads: letters, digits and `._/-` only,
 * no `..`, never starting with `-` or `/`. A forge's branch name is its author's text: anything else is left out.
 */
export function inboxPullSafeBranch(name: string): boolean {
  return BRANCH_NAME.test(name) && !name.includes("..") && !name.startsWith("-") && !name.startsWith("/");
}

/**
 * A branch name the Inbox may compare on the forge (the Whole stack diff): any name git itself takes as a branch
 * (`check-ref-format`), so `übersetzung/fehlermeldungen` is one; never starting with `-`, and without the
 * bidirectional and zero-width characters that make one name read as another. It goes into the compare's URL
 * percent-encoded; it is never put in words an agent reads (`inboxPullSafeBranch` decides that).
 */
export function inboxPullCompareBranch(name: string): boolean {
  if (name.length === 0 || new TextEncoder().encode(name).length > 255) return false;
  if (/[\u0000- \u007F~^:?*[\\]/.test(name)) return false;
  if (/[؜​-‏‪-‮⁠-⁩﻿]/.test(name)) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{") || name === "@") return false;
  return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** The key of a repository on a host, as `InboxPullsAnswer.projects` holds it. */
export function inboxPullRepoKey(host: string, repo: string): string {
  return `${host}/${repo}`.toLowerCase();
}

/** Open or a draft: a PR still to land (a merged or closed one is done). The one open-PR rule: the server, the stacks, the window. */
export function inboxPullIsOpen(pull: Pick<InboxPull, "state">): boolean {
  return pull.state === "open" || pull.state === "draft";
}
/** A head branch in the repository itself (a fork's branch of the same name is another branch). */
const ownHead = (pull: InboxPull) => pull.head_repo === null || pull.head_repo.toLowerCase() === pull.repo.toLowerCase();

/** A stack: its layers from the bottom (merged first, then the lowest open layer) to the top. */
export interface InboxPullStack {
  /** The top layer's key: one stack, one id, while its top stays. */
  id: string;
  platform: InboxPullPlatform;
  host: string;
  repo: string;
  /** Bottom to top: depth order, siblings by number (a fork's second branch may come after the first's upper layers). */
  layers: InboxPull[];
  /**
   * By layer key: the key of the layer it sits on (its base is that layer's head, a merged layer between included),
   * null for the bottom layer. The one source of the stack's shape: never read it from `layers`' order.
   */
  parents: Record<string, string | null>;
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
/** A repository's usual trunk names, when the forge did not say its default branch. */
const TRUNK = /^(main|master)$/;

/** A long-lived branch (`main`, `develop`, `release/…`): what a stack's bottom layer lands on. */
export function inboxPullLongLived(branch: string): boolean {
  return LONG_LIVED.test(branch);
}

/**
 * The stacks among the PRs: one per chain of open PRs where each one's base is
 * the head of the one under it, in the same repository; every other open PR is
 * a stack of one. Merged PRs whose head is still the base of a stack's lowest
 * open layer go under it (at most 5), unless that head is a long-lived branch
 * or the base of another open PR outside the stack (then it is a shared
 * branch, not a layer). A merged PR in the middle (merged into the branch of a
 * PR still open) keeps the layers above it on that open PR: the stack runs
 * from the open one up, the merged one between. Closed PRs, and merged PRs
 * under no stack, are left out. A branch with two PRs on it (a tree) is one
 * stack, its layers in depth order, siblings by number. Two open PRs from one
 * branch (a backport): the layers based on that branch sit on the one into a
 * long-lived branch, else on the lower number. Stacks come in the PRs' order
 * of their top layers.
 */
export function inboxPullStacks(pulls: readonly InboxPull[]): InboxPullStack[] {
  const seen = new Set<string>();
  const unique = pulls.filter((pull) => (seen.has(pull.key) ? false : (seen.add(pull.key), true)));
  const open = unique.filter(inboxPullIsOpen);
  const merged = unique.filter((pull) => pull.state === "merged");
  const headOf = new Map<string, InboxPull>();
  // The PR a branch's layers sit on, when two open PRs come from one branch (a backport: a second PR from the same
  // branch, into a release branch): the one into the repository's trunk (its default branch when the forge said,
  // else main or master), then into another long-lived branch, then the lowest number, whatever the order.
  const rank = (pull: InboxPull) => (pull.base === pull.default_branch || TRUNK.test(pull.base) ? 0 : LONG_LIVED.test(pull.base) ? 1 : 2);
  for (const pull of open) {
    if (!ownHead(pull)) continue;
    const at = `${repoKey(pull)}\u0000${pull.head}`;
    const was = headOf.get(at);
    if (!was || rank(pull) < rank(was) || (rank(pull) === rank(was) && pull.number < was.number)) headOf.set(at, pull);
  }
  /** The open PR a PR sits on, through the merged layers between (a layer merged into an open PR's branch). */
  const parentOf = (pull: InboxPull): { parent: InboxPull; via: InboxPull[] } | null => {
    const via: InboxPull[] = [];
    let base = pull.base;
    for (let i = 0; i < 5; i++) {
      const parent = headOf.get(`${repoKey(pull)}\u0000${base}`);
      if (parent) return parent.key !== pull.key ? { parent, via } : null;
      const between = merged.find((m) => ownHead(m) && repoKey(m) === repoKey(pull) && m.head === base && !LONG_LIVED.test(m.head) && !via.includes(m));
      if (!between) return null;
      via.unshift(between);
      base = between.base;
    }
    return null;
  };
  const parentPull = (pull: InboxPull) => parentOf(pull)?.parent ?? null;
  const children = new Map<string, { pull: InboxPull; via: InboxPull[] }[]>();
  const roots: InboxPull[] = [];
  for (const pull of open) {
    const found = parentOf(pull);
    // A loop (a's base is b's head and b's base a's head) has no root: its lowest number roots it.
    if (found && !loops(pull, parentPull)) {
      const list = children.get(found.parent.key) ?? [];
      list.push({ pull, via: found.via });
      children.set(found.parent.key, list);
    } else roots.push(pull);
  }
  const stacks: InboxPullStack[] = [];
  for (const root of roots) {
    // Depth order, siblings by number: a chain reads bottom to top, a merged layer in the middle under the one above it.
    const layers: InboxPull[] = [];
    const parents: Record<string, string | null> = {};
    let level: { pull: InboxPull; via: InboxPull[]; parent: string | null }[] = [{ pull: root, via: [], parent: null }];
    while (level.length > 0) {
      for (const { pull, via, parent } of level) {
        // The merged layers between sit one on the other, from the open parent up; this layer on the last of them.
        let under = parent;
        for (const m of via) {
          if (!layers.includes(m)) {
            layers.push(m);
            parents[m.key] = under;
          }
          under = m.key;
        }
        layers.push(pull);
        parents[pull.key] = under;
      }
      level = level.flatMap(({ pull }) => [...(children.get(pull.key) ?? [])].sort((a, b) => a.pull.number - b.pull.number).map((c) => ({ ...c, parent: pull.key })));
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
          !layers.includes(pull) &&
          !LONG_LIVED.test(pull.head) &&
          !open.some((other) => repoKey(other) === repoKey(root) && other.base === pull.head && !layers.includes(other)),
      );
      if (!below) break;
      under.unshift(below);
      base = below.base;
    }
    // The merged layers under the root sit one on the other, the root on the last of them.
    under.forEach((pull, i) => (parents[pull.key] = i > 0 ? under[i - 1]!.key : null));
    if (under.length > 0) parents[root.key] = under[under.length - 1]!.key;
    const all = [...under, ...layers];
    stacks.push({ id: all[all.length - 1]!.key, platform: root.platform, host: root.host, repo: root.repo, layers: all, parents, base: all[0]!.base, open_base: root.base });
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
  return stack.layers.find(inboxPullIsOpen) ?? null;
}

/** The layer a layer sits on (`parents`), or null for the bottom one (or a key not in the stack). */
export function inboxPullParent(stack: Pick<InboxPullStack, "layers" | "parents">, key: string): InboxPull | null {
  const parent = stack.parents[key];
  return parent ? (stack.layers.find((l) => l.key === parent) ?? null) : null;
}

/** The layers under a layer, nearest first, down to the bottom: its own line of the stack, never a sibling's. */
export function inboxPullAncestors(stack: Pick<InboxPullStack, "layers" | "parents">, key: string): InboxPull[] {
  const out: InboxPull[] = [];
  let at = inboxPullParent(stack, key);
  while (at && !out.includes(at)) {
    out.push(at);
    at = inboxPullParent(stack, at.key);
  }
  return out;
}

export type InboxPullMove = "on_you" | "ready" | "waiting";

/**
 * Why a PR is where it is; the window turns it into words:
 * - `requested`: a teammate asked for the person's review;
 * - `assigned`: a teammate's PR the person is assigned to;
 * - `agent_ready`: the person's agent opened it (not a draft, its checks done), so the person reviews it;
 * - `running`: the person's agent opened it and its checks still run;
 * - `changes`: a reviewer asked for changes on the person's PR;
 * - `failing`: its checks failed;
 * - `conflicts`: the person's PR conflicts with its base branch (it can't land until that is resolved);
 * - `approved`: approved, checks passed (or none ran);
 * - `approved_running`: approved, checks still running;
 * - `draft`: still a draft;
 * - `review`: the person's PR, waiting on reviewers;
 * - `others`: a teammate's PR in a stack, not asked of the person;
 * - `merged` / `closed`.
 */
export type InboxPullReason =
  | "requested"
  | "assigned"
  | "agent_ready"
  | "running"
  | "changes"
  | "failing"
  | "conflicts"
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
  if (pull.assigned && !pull.mine) return { move: "on_you", reason: "assigned" };
  if (!pull.mine) return { move: "waiting", reason: "others" };
  if (pull.review === "changes_requested") return { move: "on_you", reason: "changes" };
  if (pull.checks === "failure") return { move: "on_you", reason: "failing" };
  if (pull.conflicts === true) return { move: "on_you", reason: "conflicts" };
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
    const moves = stack.layers.filter(inboxPullIsOpen).map((pull) => ({ pull, ...inboxPullMove(pull, agent || linked(pull)) }));
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

/** A repository path as a forge names one: `owner/repo`, GitLab's groups included. Never `.` or `..`, nor anything a URL could smuggle in. */
const INBOX_PULL_REPO = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

/** A pull or merge request's parts from its web address (`/pull/N`, `/pulls/N`, `/-/merge_requests/N`), its key included; null for anything else. */
export function inboxPullRefOfUrl(url: string): { key: string; platform: InboxPull["platform"]; host: string; repo: string; number: number } | null {
  const match = /^https:\/\/([A-Za-z0-9.-]+)\/([^?#]+?)\/(pulls?|-\/merge_requests)\/(\d+)(?:[/?#].*)?$/.exec(url);
  if (!match || !INBOX_PULL_REPO.test(match[2]!)) return null;
  const host = match[1]!.toLowerCase();
  const repo = match[2]!;
  const number = Number(match[4]);
  return { key: `${host}/${repo}#${number}`, platform: match[3] === "-/merge_requests" ? "gitlab" : "github", host, repo, number };
}

/** A pull key's parts (`host/repo#number`); null for anything else. */
export function inboxPullRefOfKey(key: string): { host: string; repo: string; number: number } | null {
  const match = /^([A-Za-z0-9.-]+)\/(.+)#(\d+)$/.exec(key);
  if (!match || !INBOX_PULL_REPO.test(match[2]!)) return null;
  return { host: match[1]!.toLowerCase(), repo: match[2]!, number: Number(match[3]) };
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
