/**
 * A PR's Start a thread (the owner, 2026-11-17, mock "V1, slim line"): the PR's page becomes an empty thread for it, in
 * place, and the person's first message starts it. Nothing exists until Send: no thread, no link.
 *
 * The Send: the PR is checked with To's project first (`pulls/owner`, `validate_only`, as New review and the board's
 * Start review thread check it), then the thread starts with the person's words FIRST and the PR's details after (the
 * hand-off's own text with nothing asked for first, `pullHandoffMessage(…, { kind: 'thread' })`), named as a hand-off
 * names its thread (`pullHandoffThreadName`), then the PR is kept as that thread's with the `thread` ask (no guided
 * review is said to be on its way; the thread is the PR's page from then on). Once a thread started, no press starts
 * another (`threadStarts.ts`): Send only ties it.
 */
import type { InboxLaunchAgent, InboxPull, InboxPullLink, InboxPullStack } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { INBOX_MESSAGE_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { handoffKeys, pullHandoffMessage, pullHandoffThreadName } from './model';
import { keepPullThreadAttempt, keepUntiedPullThread, pullThreadAttempt, untiedPullThread } from './threadStarts';
import { newUuid } from '../uuid';

/**
 * Whether the Review thread door offers Start a thread: an open or draft PR with no thread about it at all (a review
 * thread, an ended one, or one that only named it: each keeps its own Open button) in at least one project, where an
 * agent can take it.
 */
export function canStartPullThread(pr: Pick<InboxPull, 'state'>, link: InboxPullLink | null, projects: readonly string[]): boolean {
  return (pr.state === 'open' || pr.state === 'draft') && !link && projects.length > 0;
}

export { isPullThread } from './model';

/** The first message's words: the person's own first, then the PR's details. */
export function pullThreadMessage(stack: InboxPullStack, words: string): string {
  return `${words.trim()}\n\n${pullHandoffMessage(stack, { kind: 'thread' })}`;
}

export { splitPullThreadDetails } from './threadDetails';

export type PullThreadTo = { host: string; session: string } | { launch: { agent: InboxLaunchAgent; project_id: string; model?: string; effort?: string } };

/** What a Send needs: the PR, the words, who gets them and in which project. */
export interface PullThreadSend {
  stack: InboxPullStack;
  /** The PR's key (the page's), what the press series is kept under (`threadStarts.ts`). */
  pr: string;
  words: string;
  to: PullThreadTo;
  project: string;
}

/**
 * What a Send did. `started`: the thread started and is the PR's. `untied`: it started (or was there) but could not be
 * tied to the PR yet (`why`); the next Send only ties it. `taken`: the PR was already given to a thread (another
 * window's Start a thread, a hand-off) and nothing was started; the window opens that one.
 */
export type PullThreadResult = { kind: 'started' | 'taken'; threadId: string } | { kind: 'untied'; threadId: string; why: string };

const whyOf = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : 'It didn’t go.');

/** Tie the PR to the thread (the `thread` ask). */
async function tie(send: PullThreadSend, threadId: string): Promise<PullThreadResult> {
  try {
    await inboxApi.pullOwner(handoffKeys(send.stack), threadId, 'thread');
    keepUntiedPullThread(send.pr, null);
    return { kind: 'started', threadId };
  } catch (cause) {
    return { kind: 'untied', threadId, why: whyOf(cause) };
  }
}

/**
 * Send: tie a thread that already started for this PR, and start nothing; else check the PR with To's project (and
 * whether it was given to a thread meanwhile), start the thread with the words first and the details after, then tie
 * it. A press that did not come back is replayed exactly while the words and To are the same (`threadStarts.ts`).
 */
export async function sendPullThread(send: PullThreadSend): Promise<PullThreadResult> {
  const started = untiedPullThread(send.pr);
  if (started) return tie(send, started);
  const keys = handoffKeys(send.stack);
  const check = await inboxApi.pullOwnerCheck(keys, send.project);
  if (check.owner) return { kind: 'taken', threadId: check.owner };
  const series = `${JSON.stringify(send.to)}\u0000${send.words.trim()}`;
  let attempt = pullThreadAttempt(send.pr);
  if (attempt?.series !== series) {
    const message = pullThreadMessage(send.stack, send.words);
    // The skills block only when the words name a skill (the details never do).
    const skills = await inboxSkillsBlock([send.words], INBOX_MESSAGE_SKILL_AUDIENCE);
    attempt = { series, key: newUuid(), body: withSkillsBlock(message, skills), name: pullHandoffThreadName(send.stack, null) };
    keepPullThreadAttempt(send.pr, attempt);
  }
  const thread = await inboxApi.startThread({
    to: send.to,
    body: attempt.body,
    idempotency_key: attempt.key,
    thread_name: attempt.name,
    thread_name_auto: true,
    thread_name_numbered: true,
  });
  keepPullThreadAttempt(send.pr, null);
  keepUntiedPullThread(send.pr, thread.thread_id);
  return tie(send, thread.thread_id);
}
