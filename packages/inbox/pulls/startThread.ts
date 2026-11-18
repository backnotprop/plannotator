/**
 * A PR's Start a thread (the owner, 2026-11-17, mock "V1, slim line"): the PR's page becomes an empty thread for it, in
 * place, and the person's first message starts it. Nothing exists until Send: no thread, no link.
 *
 * The Send: the PR is checked with To's project first (`pulls/owner`, `validate_only`, as New review and the board's
 * Start review thread check it), then the thread starts with the person's words FIRST and the PR's details after (the
 * hand-off's own text with nothing asked for first, `pullHandoffMessage(…, { kind: 'thread' })`), named as a hand-off
 * names its thread (`pullHandoffThreadName`), then the PR is kept as that thread's with the `thread` ask (no guided
 * review is said to be on its way; the thread is the PR's page from then on). One idempotency key per press series, so
 * a second press, or a press again after a late answer, replays the same Send and never starts a second thread.
 */
import type { InboxLaunchAgent, InboxPull, InboxPullLink, InboxPullStack } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { INBOX_MESSAGE_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { handoffKeys, pullHandoffMessage, pullHandoffThreadName } from './model';

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

/** What a Send needs: the PR, the words, who gets them and in which project, and the press series' key. */
export interface PullThreadSend {
  stack: InboxPullStack;
  words: string;
  to: PullThreadTo;
  project: string;
  key: string;
}

/**
 * Start the thread and keep the PR as its own. `untied`: the thread started but the PR could not be kept as its own
 * (why); pressing Send again with the same key replays the start (the same thread) and ties it again.
 */
export async function startPullThread(send: PullThreadSend): Promise<{ threadId: string; launch: string | null; untied: string | null }> {
  const keys = handoffKeys(send.stack);
  await inboxApi.pullOwnerCheck(keys, send.project);
  const words = pullThreadMessage(send.stack, send.words);
  const skills = await inboxSkillsBlock([send.words], INBOX_MESSAGE_SKILL_AUDIENCE);
  const started = await inboxApi.startThread({
    to: send.to,
    body: withSkillsBlock(words, skills),
    idempotency_key: send.key,
    thread_name: pullHandoffThreadName(send.stack, null),
    thread_name_auto: true,
    thread_name_numbered: true,
  });
  const launch = 'launch' in send.to && started.launch?.state !== 'failed' ? (started.launch?.id ?? null) : null;
  try {
    await inboxApi.pullOwner(keys, started.thread_id, 'thread');
    return { threadId: started.thread_id, launch, untied: null };
  } catch (cause) {
    return { threadId: started.thread_id, launch, untied: cause instanceof Error && cause.message ? cause.message : 'It didn’t go.' };
  }
}
