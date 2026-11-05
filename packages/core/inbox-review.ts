/**
 * Code review in the Plannotator Inbox (approval "inbox-code-review-direction",
 * 2026-11-03; phase 1). Every word an agent can receive because of it lives
 * here, so one file holds the whole agent-facing surface:
 *
 * - the review skills the reply box's "/" list offers while the person has
 *   Settings → Capabilities → Code review on (`INBOX_REVIEW_SKILLS`), whose
 *   instructions go only with the reply that names one;
 * - submit_guide's `review` field (`INBOX_REVIEW_FIELD_DESCRIPTION`), served
 *   only while the switch is on;
 * - the words of the person's verdict reply (`inboxReviewVerdictWords`).
 *
 * With the switch off, or never set, none of these reach an agent.
 * Browser-safe, no dependencies: the server and the window both read it.
 */

/** One built-in review skill: its name in the "/" list, the list's description, and the instructions it sends. */
export interface InboxReviewSkill {
  /** The name typed after `/`. Every name starts with `review-`. */
  name: string;
  /** The "/" list's one line. */
  description: string;
  /** The instructions, pasted into the reply that names the skill (never sent otherwise). */
  body: string;
  /**
   * Offered only in a thread where a review already happened: the person sent
   * a verdict, or comments on a review (`inboxThreadHadReview`). Elsewhere the
   * "/" list hides it and a typed name is plain text.
   */
  afterReview?: true;
}

/** Shared tail of every skill: what to do when there is nothing to review, and the fallback for a session that started before the switch. */
const NO_CODE = 'If you changed no code for this thread, say so in one sentence instead.';
const OLD_SESSION = 'If submit_guide takes no `review` field in this session, send it without one.';

/**
 * Every review skill Plannotator knows, by name. Which of them the "/" list
 * offers is `INBOX_REVIEW_SKILL_NAMES`: adding or removing one is one entry
 * there.
 */
export const INBOX_REVIEW_SKILL_TEXTS: Readonly<Record<string, InboxReviewSkill>> = {
  'review-curate': {
    name: 'review-curate',
    description: 'A review of only the parts of the change that need you',
    body: [
      'Send the person a review of your code change for this thread, as a guided review they approve or send feedback on. By default it covers only the changes that need a person\'s judgment. If the person\'s words with this skill ask for something else (a full review, a focus, a part to leave out), do what they ask where it differs.',
      '',
      'By default, sort every changed file into two groups. Needs the person: logic, security, data, money, public interfaces, and anything you are unsure of. Safe to skim: renames, formatting, generated and lock files, and tests that only mirror the new code. Write chapters for the first group only, at most 6, the one you are least sure of first, and put the second group in `unplacedFiles`. In the overview, list the second group in one line per kind, with why it is safe. Start the message body with how many of the changed files need them. For a full review, every changed file goes in a chapter and `unplacedFiles` stays empty.',
      '',
      `Call get_guide_brief, then submit_guide with \`review: true\` and \`reply_to\` set to this reply. Do not change code while you write it. ${OLD_SESSION} ${NO_CODE}`,
    ].join('\n'),
  },
  'review-recheck': {
    name: 'review-recheck',
    description: 'Only what changed since your last review',
    afterReview: true,
    body: [
      'The person reviewed your earlier review in this thread and sent a verdict or comments. Send a review of only what you changed since then: the diff from the code that review showed to the code now, not the diff against the base branch. If you cannot separate the two, send the whole diff and say in the body which chapters changed.',
      '',
      'Give one chapter to each comment you acted on, titled with the comment\'s file and line. In the message body, list each comment you did not act on, with why.',
      '',
      `Call get_guide_brief, then submit_guide with \`review: true\` and \`reply_to\` set to this reply. Do not change code while you write it. ${OLD_SESSION} If you changed nothing since that review, say so in one sentence instead.`,
    ].join('\n'),
  },
  // Built, and not offered: the owner decides whether it ships (add its name to INBOX_REVIEW_SKILL_NAMES).
  'review-guide': {
    name: 'review-guide',
    description: 'A review of the whole change, the riskiest part first',
    body: [
      'Send the person a review of your code change for this thread, as a guided review they approve or send feedback on. Use the diff of this work: your uncommitted changes, or your branch against the branch it started from. Put the riskiest change in the first chapter. If the person\'s words with this skill name a focus, start there.',
      '',
      `Call get_guide_brief, then submit_guide with \`review: true\` and \`reply_to\` set to this reply. Do not change code while you write it. ${OLD_SESSION} ${NO_CODE}`,
    ].join('\n'),
  },
};

/** The review skills the "/" list offers, in the list's order. One entry adds or removes a skill. */
export const INBOX_REVIEW_SKILL_NAMES: readonly string[] = ['review-curate', 'review-recheck'];

/** The offered skills, in order. */
export const INBOX_REVIEW_SKILLS: readonly InboxReviewSkill[] = INBOX_REVIEW_SKILL_NAMES.map((name) => INBOX_REVIEW_SKILL_TEXTS[name]!);

/** The skill catalog's root for a built-in skill (the "/" list's right column: "Plannotator"). */
export const INBOX_BUILTIN_SKILL_ROOT = 'plannotator';

/** A built-in review skill by name, or undefined (offered skills only). */
export function inboxReviewSkill(name: string): InboxReviewSkill | undefined {
  return INBOX_REVIEW_SKILLS.find((skill) => skill.name === name);
}

/** The heading the person's comments on a guided review's diff ride under in their reply (the window's `guideFeedback`). */
export const INBOX_GUIDE_FEEDBACK_TITLE = 'Feedback on the guided review';
/** The heading the window's Send opens the feedback on the thread's messages with (`# …`; packages/inbox attachments.ts). */
export const INBOX_MESSAGE_FEEDBACK_TITLE = 'Feedback on your messages';
/** The heading the window's Send opens the feedback on attached files with (`# …`). */
export const INBOX_ATTACHMENT_FEEDBACK_TITLE = 'Feedback on the attached files';

/** The parts of a thread's message `inboxThreadHadReview` reads. */
export interface InboxReviewThreadMessage {
  id: string;
  author: { kind: string };
  reply_to?: string | null;
  body?: string;
  guide?: { review?: true } | null;
  review_verdict?: unknown;
  review_comments_of?: readonly string[];
}

/**
 * Whether a review already happened in a thread: the person sent a verdict
 * on a review, or a reply that carried their comments on a review's diff
 * (`review_comments_of`, marked by the store whichever message the reply
 * answers). `/review-recheck` is offered only then.
 */
export function inboxThreadHadReview(messages: readonly InboxReviewThreadMessage[]): boolean {
  const reviews = new Set(messages.filter((message) => message.guide?.review).map((message) => message.id));
  if (reviews.size === 0) return false;
  return messages.some(
    (message) =>
      message.author.kind === 'person' &&
      (!!message.review_verdict || (message.review_comments_of ?? []).some((id) => reviews.has(id))),
  );
}

/**
 * submit_guide's `review` field, served only while the person has Code review
 * on. A field description does not count toward Claude Code's 2,048 characters.
 */
export const INBOX_REVIEW_FIELD_DESCRIPTION =
  'true asks the person for a verdict on this change: they read your guide beside the full diff, comment on lines, then Approve or Send feedback. The verdict and their comments come back as their reply in this thread.';

/** How long an agent's review title may run in the person's verdict words, and a chapter title on the card. */
export const INBOX_REVIEW_TITLE_MAX = 120;

/**
 * An agent's title as one line of at most `max` characters (runs of
 * whitespace, newlines included, become one space; a longer one is cut with
 * "…"). The agent writes the title; the verdict words are the person's, so
 * the title can never add lines of its own to them.
 */
export function inboxReviewTitleLine(title: string, max = INBOX_REVIEW_TITLE_MAX): string {
  const line = title.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : line;
}

/** The person's verdict on a review. */
export type InboxReviewVerdict = 'approved' | 'changes_requested';

/** What a person's verdict reply records (on the reply: `review_verdict`). */
export interface InboxReviewVerdictRecord {
  /** The review's message id. */
  of: string;
  verdict: InboxReviewVerdict;
  /** How many of the person's comments on the review rode the reply. */
  comments: number;
}

/**
 * The first words of the person's verdict reply, before their note and their
 * comments (which follow under "Feedback on the guided review", the review
 * app's export). The agent reads this; the window shows it as the reply.
 */
export function inboxReviewVerdictWords(verdict: InboxReviewVerdict, title: string, comments: number): string {
  const name = `"${inboxReviewTitleLine(title)}"`;
  if (verdict === 'approved') {
    return comments > 0
      ? `I approved your review ${name}, with ${comments === 1 ? 'a comment' : `${comments} comments`} below. Nothing in it blocks the change.`
      : `I approved your review ${name}.`;
  }
  return comments > 0
    ? `I reviewed ${name} and I am asking for changes: ${comments === 1 ? 'my comment is' : `my ${comments} comments are`} below.`
    : `I reviewed ${name} and I am asking for changes.`;
}
