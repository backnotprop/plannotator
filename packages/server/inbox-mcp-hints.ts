/**
 * send_message's quiet hints (approval "inbox-quiet-hints", 2026-11-10): one
 * extra line on the answer to a send when the Inbox sees a plain fact about
 * the message. The message is never blocked or changed.
 *
 *  1. `attach_pull`: the body names a pull or merge request (its URL, or a
 *     GitLab `group/project!45`) that is not on the thread after this send.
 *  2. `question_options`: the body asks a question with two or more choices,
 *     and no question in it has a `Pros:`, `Cons:` or `Prototype:` line.
 *
 * Each hint is said once per session, then never again to that session
 * (`agent_session`, which every connection fills with the host's own session
 * id; see inbox-session-reads.ts). At most one of the two per send: the PR
 * one first, the question one on a later send that still qualifies. A send
 * with no session gets neither, and so does a replay (the first answer
 * stands). The memory is per store, in this process: an Inbox restart forgets
 * it, so a session may hear a hint once more after one.
 *
 * The older "choices have no pictures" advice is not one of these: it keeps
 * its own rule and words (inbox-picture-choices.ts) and is said on every send
 * it holds for.
 */

import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { INBOX_THREAD_PULLS_REMOVED_MS, inboxPullUrlsIn, inboxThreadPullText, parseInboxThreadPullRef, type InboxThreadPullRef } from "@plannotator/core/inbox-types";
import { blankCode } from "@plannotator/shared/inbox/message-images";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export type InboxHintKind = "attach_pull" | "question_options";

/** At most this many (session, hint) marks kept per store; the oldest go first. */
const MAX_SAID = 20_000;
/** The most PRs the attach line names. */
const HINT_PULLS_MAX = 3;

const saidByStore = new WeakMap<InboxStore, Set<string>>();
const keyOf = (session: string, kind: InboxHintKind) => `${session}\u0000${kind}`;

/** Whether this session was already given the hint. No session: never. */
export function hintSaid(store: InboxStore, session: string | null | undefined, kind: InboxHintKind): boolean {
  const who = session?.trim();
  return !!who && (saidByStore.get(store)?.has(keyOf(who, kind)) ?? false);
}

/** The session was given the hint now. No session: nothing to remember. */
export function noteHintSaid(store: InboxStore, session: string | null | undefined, kind: InboxHintKind): void {
  const who = session?.trim();
  if (!who) return;
  let said = saidByStore.get(store);
  if (!said) {
    said = new Set();
    saidByStore.set(store, said);
  }
  said.add(keyOf(who, kind));
  if (said.size > MAX_SAID) {
    const oldest = said.values().next().value;
    if (oldest !== undefined) said.delete(oldest);
  }
}

/** A GitLab merge request written short (`group/sub/project!45`); `owner/repo#12` also names issues, so it is not read here. */
const SHORT_MERGE_REQUEST = /(?<![\w/.!-])[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+![1-9]\d{0,9}(?!\w)/g;

/** A Bitbucket Cloud pull request's URL: `inboxPullUrlsIn` reads only the forges the Reviews page reads. */
const BITBUCKET_PULL_URL = /https:\/\/bitbucket\.org\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull-requests\/[1-9]\d{0,9}(?![\w-])/g;

/**
 * The pull and merge requests the agent's own words name, each once, in text
 * order: a PR's or MR's https URL, or a GitLab `group/project!45`. Not read:
 * code (fenced or inline), quoted lines (`>`: someone else's words), an issue
 * link, `owner/repo#12` and a bare `#12` (each may be an issue, and `pulls`
 * refuses a bare one). Pure; never throws.
 */
export function pullsNamedInBody(body: string): InboxThreadPullRef[] {
  if (typeof body !== "string" || (!body.includes("https://") && !body.includes("!"))) return [];
  const text = blankCode(body)
    .split("\n")
    .map((line) => (/^\s{0,3}>/.test(line) ? "" : line))
    .join("\n");
  const found: { index: number; ref: InboxThreadPullRef }[] = [];
  const take = (index: number, value: string) => {
    const ref = parseInboxThreadPullRef(value);
    if (!("error" in ref) && !found.some((other) => other.ref.key === ref.key)) found.push({ index, ref });
  };
  for (const url of inboxPullUrlsIn(text)) take(text.indexOf(url), url);
  for (const match of text.matchAll(SHORT_MERGE_REQUEST)) take(match.index ?? 0, match[0]);
  for (const match of text.matchAll(BITBUCKET_PULL_URL)) take(match.index ?? 0, match[0]);
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.ref);
}

/**
 * The PRs the body names that are not attached to the thread: not one of its
 * PRs now (the list the row and header show: added earlier, by the person, or
 * with this send's `pulls`), and not one somebody took off it in the last 7
 * days (read_thread's "Removed by" lines: never asked back).
 */
export function pullsNotAttached(store: InboxStore, threadId: string, body: string, now: number): InboxThreadPullRef[] {
  const named = pullsNamedInBody(body);
  if (named.length === 0) return [];
  const known = new Set([
    ...store.threadPulls(threadId).map((pull) => pull.pull),
    ...store.threadPullsRemoved(threadId, new Date(now - INBOX_THREAD_PULLS_REMOVED_MS).toISOString()).map((pull) => pull.pull),
  ]);
  return named.filter((ref) => !known.has(ref.key));
}

/** The attach line (the approved words). */
export function attachPullText(refs: readonly InboxThreadPullRef[]): string {
  const names = refs.slice(0, HINT_PULLS_MAX).map((ref) => JSON.stringify(inboxThreadPullText({ pull: ref.key, url: ref.url })));
  const one = refs.length === 1;
  return `You can attach ${one ? "that PR" : "those PRs"} to this thread, so the person sees ${one ? "its" : "their"} state on the thread's row: thread_pulls with add [${names.join(", ")}], or \`pulls\` on a later message here.`;
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
 * The one quiet hint this send's answer carries, or null; the session is
 * marked as told. Advice for a message already stored: a failure here is no
 * hint, never an error.
 */
export function quietHint(
  store: InboxStore,
  sent: { session: string | null | undefined; threadId: string; body: string; replayed: boolean; now: number },
): { kind: "attach_pull" | "question_options"; line: string } | null {
  if (sent.replayed || !sent.session?.trim()) return null;
  try {
    if (!hintSaid(store, sent.session, "attach_pull")) {
      const refs = pullsNotAttached(store, sent.threadId, sent.body, sent.now);
      if (refs.length > 0) {
        noteHintSaid(store, sent.session, "attach_pull");
        return { kind: "attach_pull", line: attachPullText(refs) };
      }
    }
    if (!hintSaid(store, sent.session, "question_options") && questionWithBareOptions(sent.body)) {
      noteHintSaid(store, sent.session, "question_options");
      return { kind: "question_options", line: QUESTION_OPTIONS_HINT };
    }
  } catch {
    return null;
  }
  return null;
}
