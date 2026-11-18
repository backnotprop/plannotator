/**
 * A PR thread's first message as the thread draws it (Start a thread, `startThread.ts`): the person's words, and the
 * PR's details that went after them folded into one line ("Sent with: this PR's details", `PullDetailsLine`).
 */

/** How the PR's details begin (the hand-off's opening, `pullHandoffMessage`): what tells them apart from the words. */
export const PULL_DETAILS_START = "You're being asked to help me review and understand a ";
/** Only a thread's details have this step (`pullHandoffMessage`'s `thread` kind). */
const DETAILS_STEP = '\nWhat to do\nWe discuss it in this thread.';

/**
 * A person's message split into their words and the PR's details that went with them, or null for any other message.
 * The details are the LAST block that starts with the hand-off's opening after a blank line and holds the thread's
 * step, so words that quote it stay words, and a hand-off with nothing before it (New review's) is not split.
 */
export function splitPullThreadDetails(body: string): { words: string; details: string } | null {
  const at = body.lastIndexOf(`\n\n${PULL_DETAILS_START}`);
  if (at <= 0) return null;
  const words = body.slice(0, at).trimEnd();
  const details = body.slice(at + 2).trimEnd();
  if (!words.trim() || !details.includes(DETAILS_STEP)) return null;
  return { words, details };
}
