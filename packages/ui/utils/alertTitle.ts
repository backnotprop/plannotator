/**
 * The title-line grammar for GitHub alerts (`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`).
 *
 * The first body line of an alert is a TITLE LINE when the whole line matches:
 *
 *     [<emoji> ][**<title>**][ <!-- icon: <name> -->]
 *
 * that is, in order: optionally one emoji (followed by one space when anything
 * follows it); optionally a bold-only run `**title**` with no other characters
 * around it; optionally one space and an HTML comment `<!-- icon: name -->`
 * where name is `[A-Za-z0-9][A-Za-z0-9_-]*`; at least one of the three
 * present; trailing whitespace ignored. It only counts when the NEXT body line
 * is empty (the `>` line GitHub needs to start a new paragraph) or the block
 * ends there. Anything else is ordinary body and the alert renders as before.
 *
 * Decided from bytes alone, so a host editor can apply the same rule to the
 * raw lines it decorates. Kept pure and dependency-free for that reason.
 */

export interface AlertTitleLine {
  /** The leading emoji, when present (one grapheme, ZWJ/modifier sequences included). */
  emoji?: string;
  /** The bold-only title text, when present (the `**` marks stripped). */
  title?: string;
  /** The `<!-- icon: name -->` name, when present. Never rendered as text. */
  icon?: string;
  /** The body after the title line and its separating empty line. */
  rest: string;
}

// One emoji: a regional-indicator pair (flag) or a pictographic base with
// optional skin-tone / variation / keycap marks, joined by ZWJ to more of the
// same. Deliberately not the whole Unicode emoji property (which would admit
// bare digits and `#`).
const EMOJI =
  '(?:\\p{RI}\\p{RI}|\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F|\\u20E3)*' +
  '(?:\\u200D\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)*)*)';

const ICON_NAME = '[A-Za-z0-9][A-Za-z0-9_-]*';

const TITLE_LINE = new RegExp(
  `^(?:(${EMOJI})(?= |$) ?)?(?:\\*\\*([^*\\n]+?)\\*\\*)?(?: ?<!--\\s*icon:\\s*(${ICON_NAME})\\s*-->)?$`,
  'u',
);

/**
 * Split an alert body into its title line and the rest, or return null when
 * the first line is not a title line by the grammar above.
 */
export function parseAlertTitleLine(body: string): AlertTitleLine | null {
  const firstBreak = body.indexOf('\n');
  const first = firstBreak === -1 ? body : body.slice(0, firstBreak);
  const after = firstBreak === -1 ? '' : body.slice(firstBreak + 1);

  const match = first.trimEnd().match(TITLE_LINE);
  if (!match) return null;
  const [, emoji, title, icon] = match;
  if (!emoji && !title && !icon) return null;

  // The next line must be empty, or the block must end.
  if (after !== '') {
    const secondBreak = after.indexOf('\n');
    const second = secondBreak === -1 ? after : after.slice(0, secondBreak);
    if (second.trim() !== '') return null;
    const rest = secondBreak === -1 ? '' : after.slice(secondBreak + 1);
    return { emoji, title: title?.trim(), icon, rest };
  }
  return { emoji, title: title?.trim(), icon, rest: '' };
}
