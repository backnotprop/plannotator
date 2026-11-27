/**
 * A PR thread's first message as the thread draws it (Start a thread, `startThread.ts`): the person's words, and the
 * PR's details that went after them folded into one line ("Sent with: this PR's details", `PullDetailsLine`). The
 * rule is core's, shared with the server, which finds the PR a started thread is about by the same details.
 */
export { PULL_DETAILS_START, splitPullThreadDetails } from '@plannotator/core/inbox-types';
