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
 *     2026-11-15). A number it does not know yet is looked up after the send
 *     (inbox-pull-lookups.ts); a PR found so is named on that agent's next
 *     send in the thread.
 *  2. `question_options`: the body asks a question with three or more
 *     choices, and no question in it has a `Pros:`, `Cons:` or `Prototype:`
 *     line or a scenario table. Said
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
import { LOOKUPS_PER_SEND } from "./inbox-pull-lookups";

export type InboxHintKind = "attach_pull" | "question_options";

/**
 * What this Inbox already knows of a project's PRs, with no forge call: its
 * repository (the cached `origin`) and whether a key is a PR that a list or
 * a card read named. A number it does not know counts as no PR on this send.
 */
export interface InboxKnownPulls {
  /** `repo` is `owner/repo`. */
  repo: { host: string; repo: string } | null;
  isPull(key: string): boolean;
  /** Whether the Inbox already knows what the number is, a PR or not (a card of either kind, a lookup's answer). */
  settled?(key: string): boolean;
  /** Looks the numbers up in the background (inbox-pull-lookups.ts); `found` hears each that is a PR. Never waits. */
  lookUp?(refs: readonly ForgeRef[], found: (ref: ForgeRef) => void): void;
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

/** The body with what is not the agent's own prose blanked: code (fenced or inline) and quoted `>` lines. */
function ownWords(body: string): string {
  return blankCode(body)
    .split("\n")
    .map((line) => (/^\s{0,3}>/.test(line) ? "" : line))
    .join("\n");
}

/** The text with pictures (`![alt](path "caption")`) and URLs blanked, so a number inside one is never read as a PR; offsets keep. */
function withoutPicturesAndUrls(text: string): string {
  return text.replace(/!\[[^\]\n]*\]\([^)\n]*\)|\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/gi, (match) => " ".repeat(match.length));
}

/** The most distinct refs of each form one body is read for: a body listing thousands of numbers costs no more. */
const BODY_REFS_MAX = 50;
/** GitHub numbers are 32-bit: a larger one is never a PR, so it is never named or looked up. */
const GITHUB_NUMBER_MAX = 2 ** 31 - 1;

/**
 * The GitHub numbers the text names, as PR refs in text order, read lazily so
 * a caller can stop: `owner/repo#12` (github.com, or the project's host when
 * it is the project's repository) and a bare `#12` (the project's
 * repository). `own` marks the project's.
 */
function* githubNumbersIn(text: string, repo: InboxKnownPulls["repo"]): Generator<{ index: number; ref: ForgeRef; own: boolean }> {
  const at = repo ? repo.repo.lastIndexOf("/") : -1;
  const project = repo && at > 0 ? { host: repo.host, owner: repo.repo.slice(0, at), name: repo.repo.slice(at + 1) } : null;
  const entry = (index: number, host: string, owner: string, name: string, number: number, own: boolean) =>
    number > GITHUB_NUMBER_MAX || [owner, name].some((part) => part === "." || part === "..")
      ? null
      : { index, ref: { platform: "github" as const, host, owner, repo: name, number, kind: "pull" as const }, own };
  const short = text.matchAll(SHORT_GITHUB_REF);
  const bare = project ? text.matchAll(BARE_NUMBER) : null;
  // Each scan is in text order; merged by position, so the stream is too.
  let a = short.next();
  let b = bare?.next();
  while (!a.done || (b && !b.done)) {
    if (!a.done && (!b || b.done || (a.value.index ?? 0) <= (b.value.index ?? 0))) {
      const match = a.value;
      a = short.next();
      const own = !!project && `${match[1]}/${match[2]}`.toLowerCase() === `${project.owner}/${project.name}`.toLowerCase();
      const found = entry(match.index ?? 0, own ? project!.host : "github.com", match[1]!, match[2]!, Number(match[3]), own);
      if (found) yield found;
    } else {
      const match = b!.value as RegExpExecArray;
      b = bare!.next();
      const found = entry(match.index ?? 0, project!.host, project!.owner, project!.name, Number(match[1]), true);
      if (found) yield found;
    }
  }
}

/** A GitHub number as a thread-PR ref. */
function pullRefOf(ref: ForgeRef): InboxThreadPullRef {
  return { key: forgeRefKey(ref), url: forgePullUrl(ref), ref };
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
  const text = ownWords(body);
  const found: { index: number; ref: InboxThreadPullRef }[] = [];
  const keys = new Set<string>();
  const add = (index: number, ref: InboxThreadPullRef | { error: string } | null) => {
    if (ref && !("error" in ref) && !keys.has(ref.key)) {
      keys.add(ref.key);
      found.push({ index, ref });
    }
  };
  const take = (index: number, value: string) => add(index, parseInboxThreadPullRef(value, projectHost));
  let from = 0;
  for (const url of inboxPullUrlsIn(text).slice(0, BODY_REFS_MAX)) {
    const after = text.indexOf(url, from);
    const index = after < 0 ? text.indexOf(url) : after;
    if (after >= 0) from = after + url.length;
    take(index, url);
  }
  let seen = 0;
  for (const match of text.matchAll(SHORT_MERGE_REQUEST)) if (seen++ < BODY_REFS_MAX) take(match.index ?? 0, match[0]); else break;
  seen = 0;
  for (const match of text.matchAll(BITBUCKET_PULL_URL)) if (seen++ < BODY_REFS_MAX) take(match.index ?? 0, match[0]); else break;
  if (known && text.includes("#")) {
    const considered = new Set<string>();
    for (const { index, ref } of githubNumbersIn(withoutPicturesAndUrls(text), known.repo)) {
      const pull = pullRefOf(ref);
      if (!considered.has(pull.key)) {
        if (considered.size >= BODY_REFS_MAX) break;
        considered.add(pull.key);
      }
      if (known.isPull(pull.key)) add(index, pull);
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
  const quiet = quietPulls(store, threadId, passed);
  return named.filter((ref) => !quiet.has(ref.key));
}

/** The PRs never named in this thread: on any thread's row, passed in this send's `pulls`, or taken off this thread. */
function quietPulls(store: InboxStore, threadId: string, passed: readonly string[]): Set<string> {
  return new Set([...passed, ...store.allThreadPulls().map((pull) => pull.pull), ...store.threadPullsRemoved(threadId, "").map((pull) => pull.pull)]);
}

/** At most this many PRs a lookup found wait for their agent's next send in a thread, per store; the oldest go first. */
const MAX_FOUND_LATER = 2_000;
/** Per store: (thread, session) → the PRs a lookup found after a send there, waiting for that agent's next send. */
const foundLaterByStore = new WeakMap<InboxStore, Map<string, Map<string, InboxThreadPullRef>>>();
const foundLaterKey = (threadId: string, session: string | null | undefined) => `${threadId}\u0000${session?.trim() ?? ""}`;

/** A lookup found that a number this agent named in the thread is a PR: its line waits for the agent's next send there. */
export function notePullFoundLater(store: InboxStore, threadId: string, session: string | null | undefined, ref: ForgeRef): void {
  let waiting = foundLaterByStore.get(store);
  if (!waiting) foundLaterByStore.set(store, (waiting = new Map()));
  const key = foundLaterKey(threadId, session);
  const refs = waiting.get(key) ?? new Map<string, InboxThreadPullRef>();
  const pull = pullRefOf(ref);
  refs.set(pull.key, pull);
  waiting.delete(key);
  waiting.set(key, refs);
  while (waiting.size > MAX_FOUND_LATER) waiting.delete(waiting.keys().next().value!);
}

/**
 * The numbers this send names in the project's GitHub repository (a bare
 * `#12`, or its own `owner/repo#12`) that the Inbox does not know yet, to look
 * up after the send: not a PR it knows, not one whose kind it already holds,
 * and not one that would be quiet anyway. At most `LOOKUPS_PER_SEND`, from the
 * first `BODY_REFS_MAX` distinct numbers. Pure but for the store reads.
 */
export function pullsToLookUp(
  store: InboxStore,
  sent: { threadId: string; body: string; known?: InboxKnownPulls; projectId?: string; passed?: readonly string[] },
): ForgeRef[] {
  const known = sent.known;
  if (!known?.lookUp || !known.repo || typeof sent.body !== "string" || !sent.body.includes("#")) return [];
  let quiet: Set<string> | null = null;
  let fromStore: ReadonlySet<string> | null = null;
  const considered = new Set<string>();
  const out: ForgeRef[] = [];
  // Stops at LOOKUPS_PER_SEND to look up, or after BODY_REFS_MAX distinct numbers: never the whole of a huge body.
  for (const { ref, own } of githubNumbersIn(withoutPicturesAndUrls(ownWords(sent.body)), known.repo)) {
    if (!own) continue;
    const key = forgeRefKey(ref);
    if (considered.has(key)) continue;
    if (considered.size >= BODY_REFS_MAX) break;
    considered.add(key);
    quiet ??= quietPulls(store, sent.threadId, sent.passed ?? []);
    fromStore ??= sent.projectId ? storePullKeys(store, sent.projectId) : new Set<string>();
    if (quiet.has(key) || fromStore.has(key) || known.isPull(key) || known.settled?.(key) || said(store, pullSaidKey(sent.threadId, key))) continue;
    out.push(ref);
    if (out.length >= LOOKUPS_PER_SEND) break;
  }
  return out;
}

/** The attach lines (the approved words): one per PR, at most three. */
export function attachPullText(refs: readonly InboxThreadPullRef[]): string {
  return refs
    .slice(0, HINT_PULLS_MAX)
    .map((ref) => `You named ${forgeRefLabel(ref.ref)}, which is on no thread's row. If it is this work's PR, attach it: thread_pulls with add [${JSON.stringify(inboxThreadPullText({ pull: ref.key, url: ref.url }))}].`)
    .join("\n");
}

/**
 * Whether the body asks a pick-one or pick-several question with three or
 * more choices (approval "question-scenario-table", 2026-11-23; two before)
 * while no question in it has a `Pros:`, `Cons:` or `Prototype:` line (under
 * a choice, or the block's shared `Prototype:`) or a scenario table. Read
 * from the format only. A free-text question and a `:::action` block never
 * count. Pure; never throws.
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
  if (!asked.some((q) => q.parsed.choices.length >= 3)) return false;
  return !asked.some((q) => q.parsed.prototype || q.parsed.scenarios || q.parsed.choices.some((c) => (c.pros?.length ?? 0) > 0 || (c.cons?.length ?? 0) > 0 || c.prototype));
}

/** The options line (the approved words; replaced by approval "question-scenario-table", 2026-11-23). */
export const QUESTION_OPTIONS_HINT =
  "If the choice is not obvious, help the person compare: `Pros:` and `Cons:` under each choice; a `Prototype:` line for an option you built or run; and when the best choice depends on the situation, a table after `Why:` (a row per situation, a column per choice, cells `<verdict> — <detail>`).";

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
    // The body's PRs first, then the ones a lookup found after this agent's earlier sends here.
    const named = pullsNotAttached(store, sent.threadId, sent.body, sent.projectHost, known, sent.passed);
    const waiting = foundLaterByStore.get(store);
    const laterKey = foundLaterKey(sent.threadId, sent.session);
    const later = waiting?.get(laterKey);
    if (later) {
      const quiet = quietPulls(store, sent.threadId, sent.passed ?? []);
      const namedKeys = new Set(named.map((ref) => ref.key));
      for (const [key, ref] of later) {
        if (quiet.has(key)) later.delete(key);
        else if (!namedKeys.has(key)) named.push(ref);
      }
    }
    const refs = named.filter((ref) => !said(store, pullSaidKey(sent.threadId, ref.key))).slice(0, HINT_PULLS_MAX);
    for (const ref of refs) later?.delete(ref.key);
    if (later) for (const key of later.keys()) if (said(store, pullSaidKey(sent.threadId, key))) later.delete(key);
    if (later?.size === 0) waiting!.delete(laterKey);
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
