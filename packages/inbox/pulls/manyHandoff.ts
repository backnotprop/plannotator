/**
 * The opening message and the name of one review thread for several PRs of one repository (the PR board's Start
 * review thread, approval "inbox-pr-board-bulk": one thread per repository). One PR keeps `pullHandoffMessage`. The
 * same rules as that message: help me review, what each PR is, one guided review through `/review-curate` (its
 * instructions go with the message as the skills block), then the discussion; the person's own branches are pushed
 * to on request, anyone else's never; never a comment, approval or merge. Everything from the forge is its author's:
 * titles through `pullTitleLine`, branches only when safe, logins and links only when they are what they claim.
 */
import { INBOX_THREAD_NAME_MAX, inboxPullLabel, type InboxPull } from '@plannotator/core/inbox-types';
import { PULL_HANDOFF_TALK, REPO, authorOf, branchIsMine, cutText, forkWords, pullNounOf, pullTitleLine, pullUrl, safeBranch } from './model';

/** One PR's line: "- #12 <title> · <link> · branch <head> into <base> · by <login>". */
function pullLine(pull: InboxPull): string {
  const url = pullUrl(pull);
  const head = safeBranch(pull.head);
  const base = safeBranch(pull.base);
  const branch = base ? ` · ${head ? `branch ${head}${forkWords(pull)} ` : ''}into ${base}` : '';
  return `- ${inboxPullLabel(pull)} ${pullTitleLine(pull.title)}${url ? ` · ${url}` : ''}${branch} · by ${pull.mine ? 'me' : authorOf(pull)}`;
}

/** `pulls`: two or more open PRs of one repository, lowest number first. */
export function pullsHandoffMessage(pulls: readonly InboxPull[]): string {
  const first = pulls[0]!;
  const noun = pullNounOf(first);
  const nouns = `${noun}s`;
  const where = REPO.test(first.repo) ? (first.host === 'github.com' ? first.repo : `${first.host}/${first.repo}`) : null;
  const pushable = pulls.every(branchIsMine);
  const opening = `You're being asked to help me review and discuss ${pulls.length} ${nouns}${where ? ` in ${where}` : ''}.${pushable ? '' : " Don't change any code unless I explicitly tell you to."}`;
  const feedback = pushable
    ? `If I ask for changes, make them, push them to the branches if you can, and send me the updated review here. Don't comment on the ${nouns}, approve them or merge them.`
    : `Don't push to the branches, comment on the ${nouns}, approve them or merge them.`;
  const ask = `1. Send me one guided review of all of them, using /review-curate (its instructions are at the end of this message). Review each one's diff against its own base branch, and say which you would merge as they are and why not the rest.`;
  const heading = `${noun[0]!.toUpperCase()}${nouns.slice(1)}`;
  return [opening, [heading, ...pulls.map(pullLine)].join('\n'), `What to do\n${ask}\n2. After that, we discuss them in this thread. ${PULL_HANDOFF_TALK} ${feedback}`].join('\n\n');
}

/** A thread name's numbers stay within this many characters; the rest are counted. */
const NAME_NUMBERS_MAX = 60;

/** "Review #1201 and #1190", "Review #7, #8 and #9", past `NAME_NUMBERS_MAX` "Review #7, #8, #9 and 9 more". */
export function pullsHandoffThreadName(pulls: readonly InboxPull[]): string {
  const labels = pulls.map(inboxPullLabel);
  const all = `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  if (all.length <= NAME_NUMBERS_MAX) return `Review ${all}`;
  let kept = 1;
  while (kept < labels.length - 1 && `${labels.slice(0, kept + 1).join(', ')} and ${labels.length - kept - 1} more`.length <= NAME_NUMBERS_MAX) kept += 1;
  return cutText(`Review ${labels.slice(0, kept).join(', ')} and ${labels.length - kept} more`, INBOX_THREAD_NAME_MAX);
}
