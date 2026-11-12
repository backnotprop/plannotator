import { forgeRefKey } from "./forge-ref-card";

export type InboxPullPlatform = "github" | "gitlab";
export type InboxPullState = "open" | "draft" | "merged" | "closed";
export type InboxPullChecks = "success" | "failure" | "pending";
export type InboxPullReview = "approved" | "changes_requested" | "review_required";

export interface InboxPull {
  key: string;
  platform: InboxPullPlatform;
  host: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string | null;
  mine: boolean;
  requested: boolean;
  assigned?: boolean;
  state: InboxPullState;
  base: string;
  head: string;
  head_repo: string | null;
  head_sha?: string | null;
  additions: number;
  deletions: number;
  files: number;
  review: InboxPullReview | null;
  approved_by: string | null;
  reviewers: string[];
  checks: InboxPullChecks | null;
  conflicts?: boolean;
  default_branch?: string;
  updated_at: string;
  merged_at: string | null;
}

export type InboxPullLinkVia = "owner" | "url";

export interface InboxPullCard {
  id: string;
  title: string;
  column: string;
}

export interface InboxPullLink {
  via: InboxPullLinkVia;
  thread_id: string;
  thread_subject: string | null;
  project_id: string;
  agent: { host: string | null; session: string | null; name: string | null; ended?: boolean } | null;
  handed_to?: string | null;
  last: { message_id: string; preview: string; at: string } | null;
  guide: { message_id: string; title: string; steps: number; review: boolean } | null;
  ask?: "guide" | "custom";
}

export interface InboxPullHost {
  cli: "gh" | "glab";
  host: string;
  login: string | null;
  error?: "rate_limited" | "unavailable";
  last_read?: string;
  others_error?: "rate_limited" | "unavailable";
  others_last_read?: string;
  others_pending?: true;
  capped?: { shown: number; total: number | null; of?: "others" };
}

export type InboxPullCliState = "missing" | "signed_out" | "signed_in";

export interface InboxPullsAnswer {
  fetched_at: string | null;
  hosts: InboxPullHost[];
  pulls: InboxPull[];
  links: Record<string, InboxPullLink>;
  projects: Record<string, string[]>;
  cards: Record<string, InboxPullCard>;
  clis?: Partial<Record<"gh" | "glab", InboxPullCliState>>;
  unsigned?: string[];
}

export type InboxPullReviewState = 'approved' | 'changes' | 'commented' | 'waiting';
export type InboxPullCheckState = 'pass' | 'fail' | 'pending';

export interface InboxPullReviewer {
  login: string;
  state: InboxPullReviewState;
  bot?: boolean;
  team?: boolean;
}

export interface InboxPullCheck {
  name: string;
  workflow?: string;
  state: InboxPullCheckState;
  note?: string;
  url?: string;
}

export interface InboxPullDetailComment {
  id: string;
  author: string;
  bot?: boolean;
  at: string;
  body: string;
  url: string;
  file?: string;
  line?: number;
  hidden?: string;
}

export interface InboxPullThread {
  id: string;
  file: string;
  line: number | null;
  start_line: number | null;
  side: 'old' | 'new';
  resolved: boolean;
  outdated: boolean;
  comments: InboxPullDetailComment[];
}

export interface InboxPullDetailsAnswer {
  key: string;
  description: string | null;
  labels: string[];
  reviewers: InboxPullReviewer[];
  checks: InboxPullCheck[];
  comments: InboxPullDetailComment[];
  threads?: InboxPullThread[];
  threads_incomplete?: boolean;
}

export interface InboxPullDiffAnswer {
  key: string;
  scope: InboxPullDiffScope;
  base: string;
  head: string;
  patch: string;
  head_sha?: string | null;
  description?: string | null;
}

export type InboxPullDiffScope = "layer" | "stack";

export interface InboxFileContents {
  failed?: true;
  oldContent: string | null;
  newContent: string | null;
}

export const INBOX_PULLS_SEARCH_MAX = 50;
export const INBOX_PULLS_MERGED_DAYS = 14;

export function inboxPullLabel(pull: Pick<InboxPull, "platform" | "number">): string {
  return `${pull.platform === "gitlab" ? "!" : "#"}${pull.number}`;
}

const repoKey = (pull: Pick<InboxPull, "host" | "repo">) => `${pull.host}/${pull.repo}`.toLowerCase();

export const INBOX_PULL_OWNER_KEYS_MAX = 20;

const BRANCH_NAME = /^[A-Za-z0-9._\/-]{1,250}$/;
export function inboxPullSafeBranch(name: string): boolean {
  return BRANCH_NAME.test(name) && !name.includes("..") && !name.startsWith("-") && !name.startsWith("/");
}

export function inboxPullCompareBranch(name: string): boolean {
  if (name.length === 0 || new TextEncoder().encode(name).length > 255) return false;
  if (/[\u0000- \u007F~^:?*[\\]/.test(name)) return false;
  if (/[؜​-‏‪-‮⁠-⁩﻿]/.test(name)) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{") || name === "@") return false;
  return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function inboxPullRepoKey(host: string, repo: string): string {
  return `${host}/${repo}`.toLowerCase();
}

export function inboxPullIsOpen(pull: Pick<InboxPull, "state">): boolean {
  return pull.state === "open" || pull.state === "draft";
}
const ownHead = (pull: InboxPull) => pull.head_repo === null || pull.head_repo.toLowerCase() === pull.repo.toLowerCase();

export interface InboxPullStack {
  id: string;
  platform: InboxPullPlatform;
  host: string;
  repo: string;
  layers: InboxPull[];
  parents: Record<string, string | null>;
  base: string;
  open_base: string;
}

const LONG_LIVED = /^(main|master|trunk|develop|dev|staging|production|release([/-].*)?)$/;
const TRUNK = /^(main|master)$/;

export function inboxPullLongLived(branch: string): boolean {
  return LONG_LIVED.test(branch);
}

export function inboxPullStacks(pulls: readonly InboxPull[]): InboxPullStack[] {
  const seen = new Set<string>();
  const unique = pulls.filter((pull) => (seen.has(pull.key) ? false : (seen.add(pull.key), true)));
  const open = unique.filter(inboxPullIsOpen);
  const merged = unique.filter((pull) => pull.state === "merged");
  const headOf = new Map<string, InboxPull>();
  const rank = (pull: InboxPull) => (pull.base === pull.default_branch || TRUNK.test(pull.base) ? 0 : LONG_LIVED.test(pull.base) ? 1 : 2);
  for (const pull of open) {
    if (!ownHead(pull)) continue;
    const at = `${repoKey(pull)}\u0000${pull.head}`;
    const was = headOf.get(at);
    if (!was || rank(pull) < rank(was) || (rank(pull) === rank(was) && pull.number < was.number)) headOf.set(at, pull);
  }
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
    if (found && !loops(pull, parentPull)) {
      const list = children.get(found.parent.key) ?? [];
      list.push({ pull, via: found.via });
      children.set(found.parent.key, list);
    } else roots.push(pull);
  }
  const stacks: InboxPullStack[] = [];
  for (const root of roots) {
    const layers: InboxPull[] = [];
    const parents: Record<string, string | null> = {};
    let level: { pull: InboxPull; via: InboxPull[]; parent: string | null }[] = [{ pull: root, via: [], parent: null }];
    while (level.length > 0) {
      for (const { pull, via, parent } of level) {
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
    under.forEach((pull, i) => (parents[pull.key] = i > 0 ? under[i - 1]!.key : null));
    if (under.length > 0) parents[root.key] = under[under.length - 1]!.key;
    const all = [...under, ...layers];
    stacks.push({ id: all[all.length - 1]!.key, platform: root.platform, host: root.host, repo: root.repo, layers: all, parents, base: all[0]!.base, open_base: root.base });
  }
  const order = new Map(unique.map((pull, i) => [pull.key, i]));
  return stacks.sort((a, b) => Math.min(...a.layers.map((l) => order.get(l.key)!)) - Math.min(...b.layers.map((l) => order.get(l.key)!)));
}

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

export function inboxPullLandsNext(stack: InboxPullStack): InboxPull | null {
  return stack.layers.find(inboxPullIsOpen) ?? null;
}

export function inboxPullParent(stack: Pick<InboxPullStack, "layers" | "parents">, key: string): InboxPull | null {
  const parent = stack.parents[key];
  return parent ? (stack.layers.find((l) => l.key === parent) ?? null) : null;
}

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

export interface InboxPullItem {
  stack: InboxPullStack;
  move: InboxPullMove;
  focus: InboxPull;
  reason: InboxPullReason;
  updated_at: string;
}

export function inboxPullItems(stacks: readonly InboxPullStack[], linked: (pull: InboxPull) => boolean): InboxPullItem[] {
  return stacks.map((stack) => {
    const next = inboxPullLandsNext(stack) ?? stack.layers[stack.layers.length - 1]!;
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

export function inboxPullGroups(items: readonly InboxPullItem[]): InboxPullGroups {
  const byNewest = (a: InboxPullItem, b: InboxPullItem) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0);
  return {
    on_you: items.filter((i) => i.move === "on_you").sort(byNewest),
    ready: items.filter((i) => i.move === "ready").sort(byNewest),
    waiting: items.filter((i) => i.move === "waiting").sort(byNewest),
  };
}

const INBOX_PULL_REPO = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

export function inboxPullRefOfUrl(url: string): { key: string; platform: InboxPull["platform"]; host: string; repo: string; number: number } | null {
  const match = /^https:\/\/([A-Za-z0-9.-]+)\/([^?#]+?)\/(pulls?|-\/merge_requests)\/(\d+)(?:[/?#].*)?$/.exec(url);
  if (!match || !INBOX_PULL_REPO.test(match[2]!)) return null;
  const host = match[1]!.toLowerCase();
  const repo = match[2]!;
  const number = Number(match[4]);
  const platform = match[3] === "-/merge_requests" ? "gitlab" : "github";
  const at = repo.lastIndexOf("/");
  const key = forgeRefKey({ platform, host, owner: repo.slice(0, at), repo: repo.slice(at + 1), number, kind: "pull" });
  return { key, platform, host, repo, number };
}

export function inboxPullRefOfKey(key: string): { key: string; platform: InboxPull["platform"]; host: string; repo: string; number: number } | null {
  const match = /^([A-Za-z0-9.-]+)\/(.+)#(\d+)(:pull)?$/.exec(key);
  if (!match || !INBOX_PULL_REPO.test(match[2]!)) return null;
  return { key, platform: match[4] ? "gitlab" : "github", host: match[1]!.toLowerCase(), repo: match[2]!, number: Number(match[3]) };
}

export function inboxPullUrlOfKey(key: string): string | null {
  const ref = inboxPullRefOfKey(key);
  return ref && `https://${ref.host}/${ref.repo}/${ref.platform === "gitlab" ? "-/merge_requests" : "pull"}/${ref.number}`;
}

export function inboxPullUrlsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https:\/\/[A-Za-z0-9.-]+\/[^\s)<>\]"'`]+?\/(?:pulls?|-\/merge_requests)\/\d+/g)) {
    if (!found.includes(match[0])) found.push(match[0]);
  }
  return found;
}
