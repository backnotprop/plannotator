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
 * - Show me (approval "code-review-launch-build", item 1: Show me makes a
 *   Shape): the request the window sends, the refusal an old `plannotator
 *   review draw` gets, and the guide brief's and the skills' lines for the
 *   overview's drawing.
 *
 * With the switch off, or never set, none of these reach an agent.
 * Browser-safe, no dependencies outside core: the server and the window both read it.
 */

import { checkShapeDrawnView, parseShapeCodeTarget, shapeHtmlDataCodes, SHAPE_LIMITS, type ShapeDrawnView } from './shape';

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

/** /review-curate's line for the overview's drawing (Show me, AGENT-TEXT §5, approved), at the end of its instructions. */
export const INBOX_REVIEW_CURATE_DRAWING_LINE = 'If the change is a flow across 3 or more steps that is easier to see than to read, give the overview one drawing (`overview.diagram`). The guide brief has the format.';

/** /review-recheck's line for the overview's drawing (AGENT-TEXT §5, approved), after "Give one chapter to each comment you acted on…". */
export const INBOX_REVIEW_RECHECK_DRAWING_LINE = "If the earlier review's overview had a drawing and you changed lines it opens, send it again, redrawn, as this review's `overview.diagram`, with the same data-mark ids.";

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
      '',
      INBOX_REVIEW_CURATE_DRAWING_LINE,
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
      INBOX_REVIEW_RECHECK_DRAWING_LINE,
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

// ───────────────────────────── Show me (approval "code-review-launch-build", item 1) ─────────────────────────────
//
// Show me asks the session that wrote the review for a Shape: the same board,
// store and commands as Shape on its own. The details are `plannotator shape
// --help`'s. None of it reaches an agent while Code review is off: the window
// offers no Show me, and `plannotator shape` is off unless a switch is on.

/** What a Show me points at: a review, its file and lines (null: the Overview, the whole review), the round asked in, the person's words. */
export interface InboxShowMeTarget {
  /** The review's message id; null: a Show me from a board with no review behind it (a Shape on its own). */
  review: string | null;
  file: string | null;
  lines: [number, number] | null;
  round: number;
  words?: string;
  /** Show me on a part of a board: `file` and `lines` are null, and the part says where. */
  part?: InboxShowMePart;
}

/** What a Show me from a board is on: a part, words picked, a file's lines, or the whole board. */
export interface InboxShowMePart {
  /** The board it was pressed on. */
  board: string;
  /** What the person calls it: a part's heading, the words picked, or a file and its lines. */
  name: string;
  /** Its `data-code` value, when it has one. */
  code?: string;
  /** A box over several parts: their names, and `name` is "A part of the board". */
  parts?: string[];
  /**
   * A box's picture, the box drawn on it: a PNG `data:` URL as the window sends it; once the Inbox keeps it in the
   * board's folder, that file's full path, which the request names.
   */
  picture?: string;
}

/** "16–18" (an en dash), or "16" for one line. */
export function inboxReviewLines(lines: readonly [number, number]): string {
  return lines[0] === lines[1] ? String(lines[0]) : `${lines[0]}–${lines[1]}`;
}

/** A review's round in its thread: 1, plus every review message before it. */
export function inboxReviewRound(messages: readonly { id: string; guide?: { review?: true } | null }[], reviewId: string): number {
  let round = 1;
  for (const message of messages) {
    if (message.id === reviewId) return round;
    if (message.guide?.review) round += 1;
  }
  return round;
}

/** Words written by the person or an agent, inside quotes the agent reads: one line, and a quote cannot end them. */
function quoted(text: string): string {
  return text.replace(/[\\"]/g, '\\$&').replace(/\s+/g, ' ').trim();
}

/**
 * The Show me request, the words the window sends as an Ask turn. The bridge
 * puts its own session header first. `threadId` and the review tie the board to
 * this thread, so it opens over the review. `again`: Show me again, a new
 * version of that board.
 */
export function inboxShowMeRequest(input: { target: InboxShowMeTarget; title: string; threadId: string; again?: string }): string {
  const { target, threadId } = input;
  const title = quoted(inboxReviewTitleLine(input.title));
  const words = target.words?.trim() ? `: "${quoted(target.words)}"` : '';
  const tie = `--thread ${threadId}${target.review ? ` --through ${target.review}` : ''}`;
  const part = target.part;
  // A box over several parts names them; a part on its own, its code.
  const after = part?.parts?.length ? ` (parts: ${part.parts.map(quoted).join(', ')})` : part?.code ? ` (${quoted(part.code)})` : '';
  // The picture's line only once the Inbox kept it: the window's request, before, has none.
  const picture = part?.picture && !part.picture.startsWith('data:') ? [`A picture of what they boxed, the box drawn on it: ${part.picture}.`] : [];
  const where = part
    ? `on "${quoted(part.name)}"${after} in your Shape ${part.board}, from`
    : target.file !== null && target.lines
      ? `on ${target.lines[0] === target.lines[1] ? 'line' : 'lines'} ${inboxReviewLines(target.lines)} of ${target.file} in`
      : 'on the Overview of';
  return [
    target.review
      ? `The reviewer pressed Show me ${where} your review "${title}" (${target.review})${words}.`
      : `The person pressed Show me on "${quoted(part?.name ?? '')}"${after} in your Shape ${part?.board ?? ''}${words}.`,
    ...picture,
    input.again
      ? `Bring your Shape ${input.again} up to date with the code as it is now, as a new version. \`plannotator shape --help\` has how.`
      : part
        ? `Make a new Shape of that part, so they can see it the way you see it, and leave ${part.board} as it is. It can show code the board doesn't. \`plannotator shape --help\` has how.`
        : 'Make a Shape of it, so they can see it the way you see it. `plannotator shape --help` has how.',
    `Store it with \`${tie}\`: it opens ${target.review ? 'over the review ' : ''}by itself, so don't open a page.`,
    // A board with no review behind it has no diff for a click to land in: the agent draws it as any board.
    ...(target.review ? ['On each part that is code, put `data-code="path#L42"` (or `#L42-L48`) with the review\'s paths and the new file\'s line numbers: a click lands on those lines of the diff.'] : []),
    'Then answer here in one or two sentences.',
  ].join('\n');
}

/** The view Shape's renderer draws: `source` becomes `html`. */
export function inboxDrawnViewOf(d: { source: string; css?: string; width?: number; height?: number; tall?: { source: string; css?: string } }): ShapeDrawnView {
  return {
    html: d.source,
    ...(d.css !== undefined ? { css: d.css } : {}),
    ...(d.width !== undefined && d.height !== undefined ? { width: d.width, height: d.height } : {}),
    ...(d.tall ? { tall: { html: d.tall.source, ...(d.tall.css !== undefined ? { css: d.tall.css } : {}) } } : {}),
  };
}

/**
 * Every `data-code` value in a drawing's HTML (the wide and the tall one), in
 * order, once each: read by Shape's own tag and attribute tokenizer, so a
 * value unquoted, or after `/` or another attribute's closing quote, is read.
 */
export function inboxDrawingCodes(view: { html: string; tall?: { html: string } }): string[] {
  const out: string[] = [];
  for (const html of [view.html, view.tall?.html ?? '']) {
    for (const raw of shapeHtmlDataCodes(html)) {
      const value = raw.trim();
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

const DRAWN_KEYS = ['kind', 'title', 'source', 'css', 'width', 'height', 'tall'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A drawing as the agent sent it, checked by Shape's own rules (the board's
 * Picture) plus one of the review's: a part's code must be a file of the
 * review's diff. Field names are the agent's (`source`, `tall.source`).
 * `title`: allowed (a drawing has one) unless `withTitle` is false (the guide's overview diagram).
 */
export function checkInboxDrawing(
  input: unknown,
  files: readonly string[],
  options: { withTitle?: boolean } = {},
): { ok: true; title?: string; view: ShapeDrawnView } | { ok: false; problems: string[] } {
  if (!isPlainObject(input)) return { ok: false, problems: ['drawing: must be a JSON object: { "kind": "html", "source", … }'] };
  const d = input;
  const withTitle = options.withTitle !== false;
  const keys = withTitle ? DRAWN_KEYS : DRAWN_KEYS.filter((key) => key !== 'title');
  const problems: string[] = [];
  for (const key of Object.keys(d)) if (!keys.includes(key)) problems.push(`${key}: is not a field of a drawing (${keys.join(', ')})`);
  if (d.kind !== 'html') problems.push('kind: must be "html"');
  let title: string | undefined;
  if (withTitle && d.title !== undefined) {
    if (typeof d.title !== 'string' || !d.title.trim()) problems.push('title: must be words');
    else if (d.title.length > SHAPE_LIMITS.title) problems.push(`title: is ${d.title.length} characters; at most ${SHAPE_LIMITS.title}`);
    else title = d.title.replace(/\s+/g, ' ').trim();
  }
  const tall = d.tall;
  const asView: Record<string, unknown> = { html: d.source };
  if (d.css !== undefined) asView.css = d.css;
  if (d.width !== undefined) asView.width = d.width;
  if (d.height !== undefined) asView.height = d.height;
  if (tall !== undefined) asView.tall = isPlainObject(tall) ? { html: tall.source, ...(tall.css !== undefined ? { css: tall.css } : {}) } : tall;
  const checked = checkShapeDrawnView(asView, '@');
  if ('errors' in checked) {
    for (const error of checked.errors) {
      problems.push(
        error
          .replace(/^@\.tall\.html/, 'tall.source')
          .replace(/^@\.html/, 'source')
          .replace(/^@: width and height/, 'width: width and height')
          .replace(/^@\./, '')
          .replace(/^@:/, 'drawing:')
          .replace(/must be an object with html/, 'must be an object with source'),
      );
    }
  }
  const view = 'value' in checked ? checked.value : null;
  // Every part's code, even when Shape found other problems: the agent hears them all at once.
  const sources = {
    html: typeof d.source === 'string' ? d.source : '',
    ...(isPlainObject(tall) && typeof tall.source === 'string' ? { tall: { html: tall.source } } : {}),
  };
  for (const value of inboxDrawingCodes(sources)) {
    const at = parseShapeCodeTarget(value);
    // Shape's own check names a code it cannot read (shapeHtmlProblems); one it can must be a file of the review.
    if (at && !files.includes(at.path)) problems.push(`data-code="${value.slice(0, 80)}": ${at.path} is not a file in this review`);
  }
  if (problems.length || !view) return { ok: false, problems: problems.length ? problems : ['source: is required'] };
  return { ok: true, ...(title ? { title } : {}), view };
}

/** What an old `plannotator review draw` or `review drawings` gets while Code review is on: Show me makes a Shape now. */
export const INBOX_REVIEW_DRAW_GONE = 'review_draw_gone: `plannotator review draw` is gone: Show me makes a Shape now. Run `plannotator shape --help`.';

/** get_guide_brief's field doc for the overview's drawing (AGENT-TEXT §4), served only while Code review is on. */
export const INBOX_REVIEW_OVERVIEW_DIAGRAM_DOC = [
  '- **overview.diagram** (optional): one drawing of how the whole change works, when',
  '  it is a flow across 3 or more steps that is easier to see than to read.',
  '  { "kind": "html", "source", "css"?, "width"?, "height"?, "tall"? }: `source` is a',
  '  drawing by the rules in `plannotator shape --help`. Or { "kind": "mermaid", "source" }.',
  '  For Mermaid, draw it left to right (`flowchart LR`).',
].join('\n');

/**
 * Context notes (issue #2588, approval "inbox-context-notes"): get_guide_brief's rule for a guide's notes, served only
 * while Code review is on, after the overview's drawing. Wording awaits the owner's OK (AGENT-TEXT, writer 1).
 */
export const INBOX_REVIEW_NOTES_RULE =
  'Optional `diffs[].notes`: your notes on lines of the diff, `[{ lineStart, lineEnd, side?, text }]`. Line numbers come from the patch\'s hunk headers (`side: "old"` for removed lines), and a note must sit inside one hunk. Write a note only where a hunk needs its why, in one or two sentences: why the change is there and where that reason comes from (the PR description, a commit, a decision record, or your own reading). Notes are yours, not the person\'s comments: they are never counted, sent back to you or posted to a pull request.';

/** submit_guide's `guide` field: as always with Code review off; with it on, a diff reference names its `notes`. */
export const INBOX_GUIDE_FIELD_DESCRIPTION =
  'The guide: { title, intent, sections: [{ title, overview, diffs: [{ file, summary }] }], unplacedFiles?, review?: { gitRef, base }, source?, generator? } (get_guide_brief\'s output_schema), as an object or its JSON.';
export const INBOX_GUIDE_FIELD_DESCRIPTION_WITH_NOTES = INBOX_GUIDE_FIELD_DESCRIPTION.replace('diffs: [{ file, summary }]', 'diffs: [{ file, summary, notes? }]');

/**
 * The thread agent's way to pin words to lines (writer 3): one sentence on send_message's `body`, served only while
 * Code review is on. An Ask's answer is never pinned by itself (the owner, 2026-11-07: it stays in the thread).
 */
export const INBOX_NOTE_BLOCK_LINE =
  'In a thread with a review, a `:::note path#L42-L48` … `:::` block pins its words to those lines of the newest review (` old` after the lines for removed lines): your note, not the person\'s comment. Pin a note only when your words are about those lines; answer the rest in the message.';
