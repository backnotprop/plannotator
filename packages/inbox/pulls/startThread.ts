/**
 * A PR launchpad's "Start a thread" (the owner, 2026-11-17: "I should be able to start a thread … Either existing agent
 * or launch a new agent"): the Inbox's New message box, already about this PR, with To's list open. The same hand-off
 * as New review and the board's Start review thread (`pullHandoffMessage`, `pullHandoffThreadName`, the PR's own
 * projects, `pulls/owner`), but nothing is asked for first: no guided review, so the thread's link carries no ask
 * (`pullAsksNothing`). To is filled as New review fills it (`reviewDefaultTo`); the person still presses Send.
 */
import type { InboxPull, InboxPullLink } from '@plannotator/core/inbox-types';
import type { ComposeRequest } from '../compose/ComposeDialog';
import type { ReviewBoxPull } from '../compose/reviewBox';
import { handoffKeys, pullHandoffMessage, pullHandoffThreadName } from './model';

/**
 * Whether the Review thread door offers Start a thread: an open or draft PR with no thread about it at all (a review
 * thread, an ended one, or one that only named it: each keeps its own Open button) in at least one project, where an
 * agent can take it.
 */
export function canStartPullThread(pr: Pick<InboxPull, 'state'>, link: InboxPullLink | null, projects: readonly string[]): boolean {
  return (pr.state === 'open' || pr.state === 'draft') && !link && projects.length > 0;
}

/** The New message box for the PR: the hand-off to edit or add to, its review thread's name, To's list open. */
export function pullThreadRequest(pick: ReviewBoxPull): ComposeRequest {
  return {
    body: `${pullHandoffMessage(pick.stack, { kind: 'thread' })}\n\n`,
    threadName: pullHandoffThreadName(pick.stack, null),
    pulls: { keys: handoffKeys(pick.stack), projects: [...pick.projects], ask_line: '' },
    pickTo: true,
  };
}
