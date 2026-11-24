/**
 * Ship's words an AGENT reads (approval "inbox-ship-mode"). Every line an agent acts on is here, and only here.
 *
 * - The instruction: APPROVED by the owner, 2026-11-24, byte for byte. Change nothing in it without the owner.
 * - The `thread_pulls` `ship` field's `--help` line: AGENT WORDS AWAITING OWNER APPROVAL. The field itself carries no
 *   words in the tool schema every agent carries (the owner: ship starts only from the window); the instruction and
 *   `--help` teach it.
 * - The wake lines, the still line, the stop and closed lines: status lines, settled by the coordinator 2026-11-24.
 * - The notes' wake line (`SHIP_NOTE_WAKE_INSTRUCTION`): PROPOSED, AWAITING OWNER APPROVAL.
 */

/** The person's message when they press Ship; the pull request's facts follow it (`shipMessage`, inbox-ship.ts). Approved 2026-11-24. */
export const SHIP_INSTRUCTION =
  "Ship this pull request: get it all the way through. Review it and fix what you find. Then keep it moving: fix failing checks, answer reviewers and make the changes they ask for, bring the base branch in when it conflicts, and push. When checks pass and nothing is waiting on review, merge it yourself with your own git and gh. Your job is not done until it is merged. Don't go idle while you wait: set up your own watch on the checks and reviews with whatever you have (a background monitor, a scheduled wake-up), so you come back by yourself. I'll also wake you here when checks, reviews or the branch change. The repository's own rules decide what can merge; never force-push and never bypass them. Log each step with thread_pulls (ship), and if you are stuck, say so there in a few words.";

/** `plannotator inbox --help`'s line for it, under `thread_pulls`. */
export const SHIP_HELP_LINE = "- `ship`: `{ kind: step | stuck | merged, text, sha? }`, a step of shipping this thread's pull request, shown in its ship log.";

/** The watch's lines, one per change; a note joins a tick's lines and ends with `shipStillLine`. */
export const shipWakeLines = {
  checksFailed: (sha: string, names: string) => `Checks failed on ${sha}: ${names}. Fix them and push.`,
  changesRequested: (who: string) => `${who} requested changes. Make them, push, and answer them.`,
  comments: (who: string) => `New comments from ${who}. Read and answer them; change what they ask.`,
  conflict: (base: string) => `This branch conflicts with ${base}. Bring ${base} in, fix the conflicts, and push.`,
  behind: (base: string) => `${base} moved and the repository wants this branch up to date. Bring ${base} in and push.`,
  newCommit: (sha: string) => `Someone pushed ${sha} to the branch. Pull it before you push again.`,
  ready: () => "Checks pass and nothing is waiting on review. Merge it now.",
};

/**
 * The first line of every Ship note's wake (the command's `notice`), in place of the moved note's "Nothing here needs an
 * answer". PROPOSED, AWAITING OWNER APPROVAL.
 */
export const SHIP_NOTE_WAKE_INSTRUCTION = "This is a note from Plannotator Inbox about the pull request you are shipping, not a reply from the person. Act on it; it needs no answer here.";

export const shipStillLine = (pr: string) => `You are still shipping ${pr}.`;
export const shipStopLine = (pr: string) => `Stop shipping ${pr}. Don't push or merge it; leave it as it is.`;
export const shipClosedLine = (pr: string) => `${pr} was closed. Stop shipping it.`;
