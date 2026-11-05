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
 * - Show me (approval "shape-in-code-review", ac2): the request the window
 *   sends, `plannotator review draw`'s help, result and refusals, and the
 *   guide brief's and the skills' lines for the overview's drawing.
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
export const INBOX_REVIEW_RECHECK_DRAWING_LINE = "If the earlier review's overview had a drawing and you changed lines it opens, send it again, redrawn, as this review's `overview.diagram`, with the same data-mark ids. `plannotator review drawings <the earlier review's message id>` prints it.";

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

// ───────────────────────────── Show me (approval "shape-in-code-review", ac2) ─────────────────────────────
//
// Every word as the owner approved it (q-b81e04bd), from
// `.product/approved/shape-in-code-review/mock/ac2/AGENT-TEXT.md`.
// None of it reaches an agent while Code review is off: the window offers no
// Show me, the drawings routes are the unknown route, and `plannotator review
// draw|drawings` is the review parse's, as before Show me.

/** What a Show me points at: a review, its file and lines (null: the Overview, the whole review), the round asked in, the person's words. */
export interface InboxShowMeTarget {
  /** The review's message id. */
  review: string;
  file: string | null;
  lines: [number, number] | null;
  round: number;
  words?: string;
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
 * The Show me request (AGENT-TEXT §1), the words the window sends as an Ask
 * turn. The bridge puts its own session header first. `againOfRound`: "Show me
 * again" for a drawing asked in an earlier round. A Show me on the Overview
 * (no file) has its own first line, in the same voice (not in AGENT-TEXT yet).
 */
export function inboxShowMeRequest(input: { target: InboxShowMeTarget; title: string; turnId: string; againOfRound?: number }): string {
  const { target, turnId } = input;
  const title = quoted(inboxReviewTitleLine(input.title));
  const words = target.words?.trim() ? `: "${quoted(target.words)}"` : '';
  const where =
    target.file !== null && target.lines
      ? `on ${target.lines[0] === target.lines[1] ? 'line' : 'lines'} ${inboxReviewLines(target.lines)} of ${target.file} in`
      : 'on the Overview of';
  return [
    ...(input.againOfRound !== undefined
      ? [`You drew this for round ${input.againOfRound}. The code changed since: draw it for the code as it is now, with the same data-mark ids for the parts that stay.`]
      : []),
    `The reviewer pressed Show me ${where} your review "${title}" (${target.review})${words}.`,
    'They want a picture, not only words. Draw how this code works: where it starts, what it does, what it ends in. Write the drawing as JSON in a scratch file outside the project, such as /tmp/show-me.json, and send it first:',
    `plannotator review draw --file /tmp/show-me.json --review ${target.review} --turn ${turnId}`,
    'Then answer here in one or two sentences: what the picture shows, and anything in it the reviewer should act on. `plannotator review draw --help` has the format and the rules.',
  ].join('\n');
}

/** A drawing as the agent writes it (`plannotator review draw --file`), the same object as the guide's overview `diagram`. */
export interface InboxDrawnInput {
  kind: 'html';
  title?: string;
  source: string;
  css?: string;
  width?: number;
  height?: number;
  tall?: { source: string; css?: string };
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

/** One Show me drawing, kept by the Inbox beside the review (`inbox/review-drawings/<msg id>.json`). */
export interface InboxReviewDrawing {
  /** `drw_…` */
  id: string;
  /** The Ask turn it answers. */
  turn: string;
  file: string | null;
  lines: [number, number] | null;
  round: number;
  words?: string;
  title?: string;
  view: ShapeDrawnView;
  at: string;
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

/** `plannotator review draw --help` (AGENT-TEXT §2), while Code review is on. */
export const INBOX_REVIEW_DRAW_HELP = [
  'Usage:',
  '  plannotator review draw --file <drawing.json> --review <msg_id> --turn <turn_id>',
  '  plannotator review drawings <msg_id>',
  '',
  'A drawing shows the reviewer how a change works, inside the review you sent.',
  'A part that names code opens that code when the reviewer clicks it.',
  '',
  "draw      Sends the drawing in <drawing.json> as your answer to the reviewer's",
  '          Show me (--turn).',
  "drawings  Prints the review's drawings (the Overview's and each Show me): round,",
  '          and the lines each part opens.',
  '',
  'The drawing:',
  '  { "kind": "html",',
  '    "title": "After the third failure",',
  '    "source": "<div data-step=\\"1\\" data-mark=\\"fails\\" data-code=\\"src/jobs/retry-worker.ts#L11\\">…</div>",',
  '    "css": ".box { … }",',
  '    "width": 800, "height": 360,',
  '    "tall": { "source": "…" } }',
  '',
  'Rules:',
  '- One flow: where it starts, what it does, what it ends in. 4 to 8 parts.',
  "  Give every arrow a verb. Use the code's own names and numbers.",
  '- data-code="path#L42" or "path#L42-L48" on each part that has code: a path from',
  "  the repository root, lines in the new file of the review's diff.",
  '- data-mark="id" on each part. Keep the id when you draw it again: only changed',
  '  parts redraw.',
  '- data-step="N": parts arrive in number order, the order you would explain them.',
  '- One accent, on the point. Colours only through var(--ink), var(--ink2),',
  '  var(--grey), var(--rule), var(--paper), var(--surface), var(--sunk) and',
  '  var(--mark) (var(--mark-soft) for a fill). In SVG: class="line", "grey", "acc",',
  '  "acc-fill", "dash", "t-acc", "t-grey".',
  '- Nothing from outside: no scripts, event handlers, <style> (use css), external',
  '  images, fonts or url(), iframes, forms or popovers.',
  '- width and height make a fixed canvas the review scales to fit. Add "tall":',
  '  every part again, stacked about 400 px wide, for a phone.',
].join('\n');

/** `plannotator review draw`'s result (AGENT-TEXT §3). */
export const INBOX_REVIEW_DRAW_SENT = 'Sent. It opens over the review, beside your answer.';

/** The only output of `plannotator review draw` / `drawings` (help included) while Code review is off (AGENT-TEXT §3). */
export const INBOX_REVIEW_CODE_REVIEW_OFF = 'code_review_off: Code review is off. The person turns it on in the Plannotator Inbox: Settings → Capabilities → Code review.';

/** The refusals' words (AGENT-TEXT §3), without the `<code>: ` the CLI puts first. */
export const inboxReviewDrawRefusal = {
  not_found: (review: string) => `No review ${review} here.`,
  not_a_review: (review: string) => `${review} is not a review you sent.`,
  turn_unknown: (turn: string) => `${turn} is not a Show me in this review's thread.`,
  turn_stopped: (turn: string) => `The reviewer stopped ${turn}; it takes no drawing.`,
  drawing_exists: (turn: string) => `${turn} already has its drawing; a Show me takes one.`,
  invalid: (problems: readonly string[]) => ['the drawing has problems:', ...problems.map((p) => `  - ${p}`)].join('\n'),
} as const;

/** One line of `plannotator review drawings` (AGENT-TEXT §3). */
export function inboxReviewDrawingsLine(
  entry: { kind: 'overview'; round: number; codes: readonly string[] } | { kind: 'show_me'; round: number; file: string | null; lines: [number, number] | null; codes: readonly string[] },
): string {
  const codes = entry.codes.join(', ');
  if (entry.kind === 'overview') return `overview · round ${entry.round} · with the guide · ${codes}`;
  const where = entry.file !== null && entry.lines ? `${entry.file.split('/').pop()} lines ${inboxReviewLines(entry.lines)}` : 'the Overview';
  return `show me · round ${entry.round} · ${where} · ${codes}`;
}

/** get_guide_brief's field doc for the overview's drawing (AGENT-TEXT §4), served only while Code review is on. */
export const INBOX_REVIEW_OVERVIEW_DIAGRAM_DOC = [
  '- **overview.diagram** (optional): one drawing of how the whole change works, when',
  '  it is a flow across 3 or more steps that is easier to see than to read.',
  '  { "kind": "html", "source", "css"?, "width"?, "height"?, "tall"? }; the rules',
  '  are in `plannotator review draw --help`. Or { "kind": "mermaid", "source" }.',
].join('\n');
