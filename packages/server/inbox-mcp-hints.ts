/**
 * send_message's quiet hints (approval "inbox-quiet-hints", 2026-11-10): extra
 * lines on the answer to a send when the Inbox sees a plain fact about the
 * message. The message is never blocked or changed.
 *
 *  1. `attach_pull`: the body names a pull or merge request that is on no
 *     thread's row after this send: its URL, a GitLab `group/project!45`, or
 *     a GitHub `owner/repo#12` or bare `#12` (the thread's project's
 *     repository) that this Inbox already knows is a PR. One line per PR, at
 *     most three, each said once per (thread, PR) (the owner's words,
 *     2026-11-15).
 *  2. `question_options`: the body asks a question with two or more choices,
 *     and no question in it has a `Pros:`, `Cons:` or `Prototype:` line. Said
 *     once per session (`agent_session`, which every connection fills with
 *     the host's own session id; see inbox-session-reads.ts); a send with no
 *     session never gets it.
 *
 * At most one kind per send: the PR lines first, the question one on a later
 * send that still qualifies. A replay gets neither (the first answer stands).
 * The memory is per store, in this process: an Inbox restart forgets it, so a
 * thread or session may hear a hint once more after one.
 *
 * The older "choices have no pictures" advice is not one of these: it keeps
 * its own rule and words (inbox-picture-choices.ts) and is said on every send
 * it holds for.
 */

import { forgePullUrl, forgeRefKey, forgeRefLabel, parseForgeRefUrl, type ForgeRef } from "@plannotator/core/forge-ref-card";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { inboxPullUrlsIn, inboxThreadPullText, parseInboxThreadPullRef, type InboxThreadPullRef } from "@plannotator/core/inbox-types";
import { blankCode } from "@plannotator/shared/inbox/message-images";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export type InboxHintKind = "attach_pull" | "question_options";

/**
 * What this Inbox already knows of a project's PRs, with no forge call: its
 * repository (the cached `origin`) and whether a key is a PR that a list or
 * a card read named. A number it does not know counts as no PR.
 */
export interface InboxKnownPulls {
  /** `repo` is `owner/repo`. */
  repo: { host: string; repo: string } | null;
  isPull(key: string): boolean;
}

/** At most this many (session, hint) and (thread, PR) marks kept per store; the oldest go first. */
const MAX_SAID = 20_000;
/** The most PRs the attach lines name. */
const HINT_PULLS_MAX = 3;

const saidByStore = new WeakMap<InboxStore, Set<string>>();
const keyOf = (session: string, kind: InboxHintKind) => `${session}\u0000${kind}`;
const pullSaidKey = (threadId: string, pull: string) => `pull\u0000${threadId}\u0000${pull}`;

function said(store: InboxStore, key: string): boolean {
  return saidByStore.get(store)?.has(key) ?? false;
}

function noteSaid(store: InboxStore, key: string): void {
  let marks = saidByStore.get(store);
  if (!marks) {
    marks = new Set();
    saidByStore.set(store, marks);
  }
  marks.add(key);
  if (marks.size > MAX_SAID) {
    const oldest = marks.values().next().value;
    if (oldest !== undefined) marks.delete(oldest);
  }
}

/** Whether this session was already given the hint. No session: never. */
export function hintSaid(store: InboxStore, session: string | null | undefined, kind: InboxHintKind): boolean {
  const who = session?.trim();
  return !!who && said(store, keyOf(who, kind));
}

/** The session was given the hint now. No session: nothing to remember. */
export function noteHintSaid(store: InboxStore, session: string | null | undefined, kind: InboxHintKind): void {
  const who = session?.trim();
  if (who) noteSaid(store, keyOf(who, kind));
}

/** Per store and project: the PR keys its messages link to (as the Pull requests page reads them), and the messages read. */
const linkedByStore = new WeakMap<InboxStore, Map<string, { read: Set<string>; keys: Set<string> }>>();

/**
 * The PR keys the store itself shows are this project's PRs: one a message in
 * it (the agent's or the person's) links by URL, read as the Pull requests
 * page reads them, or one taken off a thread's row (one still on a row is
 * quiet anyway). Each message is read once per store.
 */
export function storePullKeys(store: InboxStore, projectId: string): ReadonlySet<string> {
  let projects = linkedByStore.get(store);
  if (!projects) linkedByStore.set(store, (projects = new Map()));
  let linked = projects.get(projectId);
  if (!linked) projects.set(projectId, (linked = { read: new Set(), keys: new Set() }));
  for (const thread of store.threadsOf(projectId)) {
    for (const pull of store.threadPullsRemoved(thread.thread_id, "")) linked.keys.add(pull.pull);
    for (const id of store.threadMessageIds(thread.thread_id)) {
      if (linked.read.has(id)) continue;
      linked.read.add(id);
      for (const url of inboxPullUrlsIn(store.message(id)?.body ?? "")) {
        const ref = parseForgeRefUrl(url);
        if (ref?.kind === "pull") linked.keys.add(forgeRefKey(ref));
      }
    }
  }
  return linked.keys;
}

/** A GitLab merge request written short (`group/sub/project!45`). */
const SHORT_MERGE_REQUEST = /(?<![\w/.!-])[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+![1-9]\d{0,9}(?!\w)/g;

/** A Bitbucket Cloud pull request's URL: `inboxPullUrlsIn` reads only the forges the Reviews page reads. */
const BITBUCKET_PULL_URL = /https:\/\/bitbucket\.org\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull-requests\/[1-9]\d{0,9}(?![\w-])/g;

/** A GitHub `owner/repo#12`: a PR or an issue, so it counts only as a PR this Inbox knows. */
const SHORT_GITHUB_REF = /(?<![\w/.#-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d{0,9})(?![\w-])/g;

/** A bare `#12` (or `PR#12`): not an HTML entity (`&#12;`), a link's fragment, or the end of `owner/repo#12`. */
const BARE_NUMBER = /(?<![\w/&#.-])(?:[Pp][Rr])?#([1-9]\d{0,9})(?![\w-])/g;

/** A GitHub PR's ref, or null when `known` does not know the number as a PR. */
function knownGithubPull(known: InboxKnownPulls, host: string, owner: string, repo: string, number: number): InboxThreadPullRef | null {
  if ([owner, repo].some((part) => part === "." || part === "..")) return null;
  const ref: ForgeRef = { platform: "github", host, owner, repo, number, kind: "pull" };
  const key = forgeRefKey(ref);
  return known.isPull(key) ? { key, url: forgePullUrl(ref), ref } : null;
}

/**
 * The pull and merge requests the agent's own words name, each once, in text
 * order: a PR's or MR's https URL, a GitLab `group/project!45`, and a GitHub
 * `owner/repo#12` or bare `#12` (the project's repository) only when `known`
 * says it is a PR, so an issue's number never counts. Not read: code (fenced
 * or inline), quoted lines (`>`: someone else's words) and an issue link.
 * Pure; never throws.
 */
export function pullsNamedInBody(body: string, projectHost?: string | null, known?: InboxKnownPulls): InboxThreadPullRef[] {
  if (typeof body !== "string" || (!body.includes("https://") && !body.includes("!") && !body.includes("#"))) return [];
  const text = blankCode(body)
    .split("\n")
    .map((line) => (/^\s{0,3}>/.test(line) ? "" : line))
    .join("\n");
  const found: { index: number; ref: InboxThreadPullRef }[] = [];
  const add = (index: number, ref: InboxThreadPullRef | { error: string } | null) => {
    if (ref && !("error" in ref) && !found.some((other) => other.ref.key === ref.key)) found.push({ index, ref });
  };
  const take = (index: number, value: string) => add(index, parseInboxThreadPullRef(value, projectHost));
  for (const url of inboxPullUrlsIn(text)) take(text.indexOf(url), url);
  for (const match of text.matchAll(SHORT_MERGE_REQUEST)) take(match.index ?? 0, match[0]);
  for (const match of text.matchAll(BITBUCKET_PULL_URL)) take(match.index ?? 0, match[0]);
  if (known && text.includes("#")) {
    for (const match of text.matchAll(SHORT_GITHUB_REF)) add(match.index ?? 0, knownGithubPull(known, "github.com", match[1]!, match[2]!, Number(match[3])));
    const repo = known.repo;
    const at = repo ? repo.repo.lastIndexOf("/") : -1;
    if (repo && at > 0) {
      const owner = repo.repo.slice(0, at);
      const name = repo.repo.slice(at + 1);
      for (const match of text.matchAll(BARE_NUMBER)) add(match.index ?? 0, knownGithubPull(known, repo.host, owner, name, Number(match[1])));
    }
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.ref);
}

/**
 * The PRs the body names that are on no thread's row: on no thread now (the
 * lists the rows show: added earlier, by the person, or with this send's
 * `pulls`), not passed in this send's `pulls` (its add may have been
 * refused), and never one taken off this thread (removed on purpose: never
 * asked back there).
 */
export function pullsNotAttached(
  store: InboxStore,
  threadId: string,
  body: string,
  projectHost?: string | null,
  known?: InboxKnownPulls,
  passed: readonly string[] = [],
): InboxThreadPullRef[] {
  const named = pullsNamedInBody(body, projectHost, known);
  if (named.length === 0) return [];
  const quiet = new Set([
    ...passed,
    ...store.allThreadPulls().map((pull) => pull.pull),
    ...store.threadPullsRemoved(threadId, "").map((pull) => pull.pull),
  ]);
  return named.filter((ref) => !quiet.has(ref.key));
}

/** The attach lines (the approved words): one per PR, at most three. */
export function attachPullText(refs: readonly InboxThreadPullRef[]): string {
  return refs
    .slice(0, HINT_PULLS_MAX)
    .map((ref) => `You named ${forgeRefLabel(ref.ref)}, which is on no thread's row. If it is this work's PR, attach it: thread_pulls with add [${JSON.stringify(inboxThreadPullText({ pull: ref.key, url: ref.url }))}].`)
    .join("\n");
}

/**
 * Whether the body asks a pick-one or pick-several question with two or more
 * choices while no question in it has a `Pros:`, `Cons:` or `Prototype:` line
 * (under a choice, or the block's shared `Prototype:`). Read from the format
 * only: a yes/no question counts like any other. A free-text question and a
 * `:::action` block never count. Pure; never throws.
 */
export function questionWithBareOptions(body: string): boolean {
  if (typeof body !== "string" || !body.includes(":::question")) return false;
  let blocks: ReturnType<typeof parseInboxQuestionBlocks>;
  try {
    blocks = parseInboxQuestionBlocks(body);
  } catch {
    return false;
  }
  const asked = blocks.filter((q) => q.kind === "single" || q.kind === "multi");
  if (!asked.some((q) => q.parsed.choices.length >= 2)) return false;
  return !asked.some((q) => q.parsed.prototype || q.parsed.choices.some((c) => (c.pros?.length ?? 0) > 0 || (c.cons?.length ?? 0) > 0 || c.prototype));
}

/** The options line (the approved words). */
export const QUESTION_OPTIONS_HINT =
  "If it helps the person choose, options can carry pros and cons, and a prototype they can try: `Pros:`, `Cons:` and `Prototype:` lines indented under a choice (send_message's body says how).";

/**
 * The quiet hint this send's answer carries, or null; the thread (for each PR
 * it names) or the session (for the question line) is marked as told. Advice
 * for a message already stored: a failure here is no hint, never an error.
 */
export function quietHint(
  store: InboxStore,
  sent: {
    session: string | null | undefined;
    threadId: string;
    body: string;
    replayed: boolean;
    projectHost?: string | null;
    known?: InboxKnownPulls;
    /** The thread's project: what the store shows of its PRs counts as known too (`storePullKeys`). */
    projectId?: string;
    /** The keys of this send's own `pulls`. */
    passed?: readonly string[];
  },
): { kind: "attach_pull" | "question_options"; line: string } | null {
  if (sent.replayed) return null;
  try {
    const context = sent.known;
    const projectId = sent.projectId;
    let fromStore: ReadonlySet<string> | null = null;
    const known: InboxKnownPulls | undefined =
      context && projectId ? { repo: context.repo, isPull: (key) => context.isPull(key) || (fromStore ??= storePullKeys(store, projectId)).has(key) } : context;
    const refs = pullsNotAttached(store, sent.threadId, sent.body, sent.projectHost, known, sent.passed)
      .filter((ref) => !said(store, pullSaidKey(sent.threadId, ref.key)))
      .slice(0, HINT_PULLS_MAX);
    if (refs.length > 0) {
      for (const ref of refs) noteSaid(store, pullSaidKey(sent.threadId, ref.key));
      return { kind: "attach_pull", line: attachPullText(refs) };
    }
    if (sent.session?.trim() && !hintSaid(store, sent.session, "question_options") && questionWithBareOptions(sent.body)) {
      noteHintSaid(store, sent.session, "question_options");
      return { kind: "question_options", line: QUESTION_OPTIONS_HINT };
    }
  } catch {
    return null;
  }
  return null;
}
