/**
 * A thread's pull and merge requests (approval "inbox-pr-binding",
 * 2026-11-08): the tight coupling of related work to a thread, so the person
 * sees where it stands on the thread's row and in its header. The thread's
 * agent owns the list (it adds a PR it opens or takes on for the thread's
 * work, and removes one that stops being part of it); the person can add and
 * remove too.
 *
 * Each coupling is its own record (store.ts, `pulls.jsonl`, kind
 * `thread_pull`), one per (thread, PR), a full snapshot per change: nothing
 * that routes, lists unread or notifies reads it. The union of its lines is
 * the event log: an add, a remove (`removed_by`, `removed_at`), a re-add, and
 * a state change the reader saw.
 *
 * Pure: no runtime APIs, so the window, the server and the tools share it.
 */

import { forgePullRefText, forgePullUrl, forgeRefKey, forgeRefLabel, parseForgePullRef, type ForgeRef } from "./forge-ref-card";
import { inboxPullStacks, type InboxPull } from "./inbox-pulls";

/** The most PRs a thread holds at once (removed ones do not count). */
export const INBOX_THREAD_PULLS_MAX = 20;
/** How long read_thread shows a removed PR, so an agent does not add back what the person took off. */
export const INBOX_THREAD_PULLS_REMOVED_MS = 7 * 24 * 60 * 60_000;

/** A coupled PR's state as last read: `unknown` until the reader's first answer (or with no gh or glab). */
export type InboxThreadPullState = "open" | "draft" | "merged" | "closed" | "unknown";
/** The head commit's checks, as the reader last saw them (never stored). */
export type InboxThreadPullChecks = "passing" | "failing" | "running";
/** The review verdict, as the reader last saw it (never stored). */
export type InboxThreadPullReview = "approved" | "changes_requested" | "review_required";

/** Who added or removed a PR: an agent session, or the person. */
export type InboxThreadPullActor = { kind: "agent"; session: string; host: string | null; name: string | null } | { kind: "person" };

/** One PR on one thread: the stored record (the last line per id is current). */
export interface InboxThreadPull {
  /** `<thread_id>:<pull key>`. */
  id: string;
  project_id: string;
  thread_id: string;
  /** The PR's key (`forgeRefKey`): `host/owner/repo#n`, GitLab `host/group/project#n:pull`. */
  pull: string;
  url: string;
  added_by: InboxThreadPullActor;
  added_at: string;
  /** Set once removed; a re-add writes a line without them. */
  removed_by?: InboxThreadPullActor;
  removed_at?: string;
  /** The forge's last known state, written by the reader only. */
  state: InboxThreadPullState;
  title: string | null;
  /** The branch it merges into and its own branch: how stacks are found. */
  base: string | null;
  head: string | null;
  /** When the reader last wrote a state; null until then. */
  read_at: string | null;
}

/** A PR as the window and the tools show it: the record plus its parts and what the reader knows now. */
export interface InboxThreadPullWire extends InboxThreadPull {
  platform: ForgeRef["platform"];
  host: string;
  /** `owner/repo` (GitLab: the project's full path). */
  repo: string;
  number: number;
  /** `#12` or `!12`. */
  label: string;
  /** How an agent writes it: `owner/repo#12`, `group/project!12`, or the URL. */
  ref: string;
  checks: InboxThreadPullChecks | null;
  review: InboxThreadPullReview | null;
}

/** The stack and related groups, in the order they show: each stack base first, then related PRs in the order they were added. */
export interface InboxThreadPullGroup {
  kind: "stack" | "related";
  /** PR keys. */
  pulls: string[];
}

/** `GET /api/inbox/threads/:id/pulls` (and the POST's answer). */
export interface InboxThreadPullsAnswer {
  pulls: InboxThreadPullWire[];
  groups: InboxThreadPullGroup[];
  /** Removed in the last 7 days and not back on the thread, the latest first. */
  removed: InboxThreadPullWire[];
}

/** A list row's PRs, from the stored state: the row paints them without a read of its own. */
export interface InboxThreadPullsSummary {
  count: number;
  headline: { key: string; state: InboxThreadPullState };
}

/** A PR named for a thread, read into its parts; `key` is the store's. */
export interface InboxThreadPullRef {
  key: string;
  url: string;
  ref: ForgeRef;
}

/** The refusal for a ref that does not name a PR, with how to write one. */
export function inboxThreadPullRefError(text: string): string {
  const shown = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return `'${shown}' is not a full PR ref. Write owner/repo#123, group/project!45 or the PR's URL; nothing was changed.`;
}

/** One ref as an agent or the person writes it, or its refusal. `projectHost`: the thread's project's remote host (`parseForgePullRef`). */
export function parseInboxThreadPullRef(value: unknown, projectHost?: string | null): InboxThreadPullRef | { error: string } {
  if (typeof value !== "string" || value.trim() === "") return { error: inboxThreadPullRefError(typeof value === "string" ? value : String(value)) };
  const ref = value.length > 600 ? null : parseForgePullRef(value, projectHost);
  if (!ref) return { error: inboxThreadPullRefError(value.trim()) };
  return { key: forgeRefKey(ref), url: forgePullUrl(ref), ref };
}

/** Every ref of a list read, each once, or the first refusal (then nothing is changed). */
export function parseInboxThreadPullRefs(values: unknown, field: string, projectHost?: string | null): { refs: InboxThreadPullRef[] } | { error: string; field: string } {
  if (!Array.isArray(values)) return { error: `${field}: a list of PRs, e.g. ["owner/repo#123"].`, field };
  const refs: InboxThreadPullRef[] = [];
  for (const [index, value] of values.entries()) {
    const parsed = parseInboxThreadPullRef(value, projectHost);
    if ("error" in parsed) return { error: parsed.error, field: `${field}[${index}]` };
    if (!refs.some((ref) => ref.key === parsed.key)) refs.push(parsed);
  }
  return { refs };
}

/** A stored key's parts (`host/owner/repo#n`, GitLab and Bitbucket with `:pull`), or null. */
export function inboxThreadPullRefOfKey(key: string, url: string): ForgeRef | null {
  const match = /^([a-z0-9.-]+)\/(.+)#(\d+)(:pull)?$/.exec(key);
  if (!match) return null;
  // The key is lowercased; the URL keeps the forge's own spelling, so the parts come from it when they agree.
  const fromUrl = parseForgePullRef(url);
  if (fromUrl && forgeRefKey(fromUrl) === key) return fromUrl;
  const path = match[2]!;
  const at = path.lastIndexOf("/");
  if (at <= 0) return null;
  const platform = match[1] === "bitbucket.org" ? "bitbucket" : match[4] ? "gitlab" : "github";
  return { platform, host: match[1]!, owner: path.slice(0, at), repo: path.slice(at + 1), number: Number(match[3]), kind: "pull" };
}

/** How an agent writes a stored PR back (`owner/repo#12`, `group/project!12`, or the URL). */
export function inboxThreadPullText(pull: Pick<InboxThreadPull, "pull" | "url">): string {
  const ref = inboxThreadPullRefOfKey(pull.pull, pull.url);
  return ref ? forgePullRefText(ref) : pull.url;
}

/** A record as the window and the tools show it, with what the reader knows now. */
export function inboxThreadPullWire(
  pull: InboxThreadPull,
  live: { checks?: InboxThreadPullChecks | null; review?: InboxThreadPullReview | null } = {},
): InboxThreadPullWire {
  const ref = inboxThreadPullRefOfKey(pull.pull, pull.url);
  return {
    ...pull,
    platform: ref?.platform ?? "github",
    host: ref?.host ?? "",
    repo: ref ? `${ref.owner}/${ref.repo}` : "",
    number: ref?.number ?? 0,
    label: ref ? forgeRefLabel(ref) : pull.url,
    ref: ref ? forgePullRefText(ref) : pull.url,
    checks: live.checks ?? null,
    review: live.review ?? null,
  };
}

/** Still in play: open, a draft, or not read yet. */
function inPlay(state: InboxThreadPullState): boolean {
  return state === "open" || state === "draft";
}

/**
 * The stack and related groups of a thread's PRs (live ones, in the order they
 * were added). Nothing is stored about stacks: a chain of PRs in one
 * repository, each based on the head of the one under it, is a stack
 * (`inboxPullStacks`, the PR page's rule), base first; every other PR is
 * related, in the order it was added. With no base or head known, every PR is
 * related.
 */
export function inboxThreadPullGroups(pulls: readonly InboxThreadPull[]): InboxThreadPullGroup[] {
  const shaped: InboxPull[] = [];
  for (const pull of pulls) {
    const ref = inboxThreadPullRefOfKey(pull.pull, pull.url);
    if (!ref || !pull.base || !pull.head || (pull.state !== "open" && pull.state !== "draft" && pull.state !== "merged")) continue;
    shaped.push({
      key: pull.pull,
      // The PR page's pull type knows GitHub and GitLab only. Grouping reads the key, host, repository, base, head
      // and state, never the platform, and only the keys come back out.
      platform: ref.platform === "gitlab" ? "gitlab" : "github",
      host: ref.host,
      repo: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      url: pull.url,
      title: pull.title ?? "",
      author: null,
      mine: false,
      requested: false,
      state: pull.state,
      base: pull.base,
      head: pull.head,
      head_repo: null,
      additions: 0,
      deletions: 0,
      files: 0,
      review: null,
      approved_by: null,
      reviewers: [],
      checks: null,
      updated_at: pull.added_at,
      merged_at: null,
    });
  }
  const stacks = inboxPullStacks(shaped).filter((stack) => stack.layers.length >= 2);
  const inStack = new Set(stacks.flatMap((stack) => stack.layers.map((layer) => layer.key)));
  const order = new Map(pulls.map((pull, index) => [pull.pull, index]));
  // Stacks in the order their first PR was added.
  const ordered = stacks
    .map((stack) => ({ keys: stack.layers.map((layer) => layer.key), first: Math.min(...stack.layers.map((layer) => order.get(layer.key) ?? 0)) }))
    .sort((a, b) => a.first - b.first);
  const groups: InboxThreadPullGroup[] = ordered.map((stack) => ({ kind: "stack", pulls: stack.keys }));
  const related = pulls.filter((pull) => !inStack.has(pull.pull)).map((pull) => pull.pull);
  if (related.length > 0) groups.push({ kind: "related", pulls: related });
  return groups;
}

/**
 * The one PR a row's mark shows: the first still open or a draft, stacks
 * first and then related PRs; else the first not read yet; else, when every
 * one is merged or closed, the last.
 */
export function inboxThreadPullHeadline<T extends Pick<InboxThreadPull, "pull" | "state">>(pulls: readonly T[], groups: readonly InboxThreadPullGroup[]): T | null {
  const byKey = new Map(pulls.map((pull) => [pull.pull, pull]));
  const shown = groups.flatMap((group) => group.pulls).flatMap((key) => byKey.get(key) ?? []);
  return shown.find((pull) => inPlay(pull.state)) ?? shown.find((pull) => pull.state === "unknown") ?? shown.at(-1) ?? null;
}

/** A row's summary of its thread's live PRs, or undefined when it has none. */
export function inboxThreadPullsSummary(pulls: readonly InboxThreadPull[]): InboxThreadPullsSummary | undefined {
  const headline = inboxThreadPullHeadline(pulls, inboxThreadPullGroups(pulls));
  return headline ? { count: pulls.length, headline: { key: headline.pull, state: headline.state } } : undefined;
}

/** Whether a stored record reads as one (a line an older or broken writer left is skipped). */
export function isInboxThreadPullRecord(value: unknown): value is InboxThreadPull {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<InboxThreadPull>;
  const actor = (a: unknown) => {
    const x = a as { kind?: unknown; session?: unknown } | undefined;
    return x?.kind === "person" || (x?.kind === "agent" && typeof x.session === "string");
  };
  return (
    typeof record.id === "string" &&
    typeof record.project_id === "string" &&
    typeof record.thread_id === "string" &&
    typeof record.pull === "string" &&
    typeof record.url === "string" &&
    record.id === `${record.thread_id}:${record.pull}` &&
    actor(record.added_by) &&
    typeof record.added_at === "string" &&
    (record.removed_at === undefined || (typeof record.removed_at === "string" && actor(record.removed_by))) &&
    ["open", "draft", "merged", "closed", "unknown"].includes(record.state as string)
  );
}
