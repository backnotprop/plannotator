export interface AlertTitleLine {
  emoji?: string;
  title?: string;
  icon?: string;
  rest: string;
}

const EMOJI =
  '(?:\\p{RI}\\p{RI}|\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F|\\u20E3)*' +
  '(?:\\u200D\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)*)*)';

const ICON_NAME = '[A-Za-z0-9][A-Za-z0-9_-]*';

const TITLE_LINE = new RegExp(
  `^(?:(${EMOJI})(?= |$) ?)?(?:\\*\\*([^*\\n]+?)\\*\\*)?(?: ?<!--\\s*icon:\\s*(${ICON_NAME})\\s*-->)?$`,
  'u',
);

export function parseAlertTitleLine(body: string): AlertTitleLine | null {
  const firstBreak = body.indexOf('\n');
  const first = firstBreak === -1 ? body : body.slice(0, firstBreak);
  const after = firstBreak === -1 ? '' : body.slice(firstBreak + 1);

  const match = first.trimEnd().match(TITLE_LINE);
  if (!match) return null;
  const [, emoji, title, icon] = match;
  if (!emoji && !title && !icon) return null;

  if (after !== '') {
    const secondBreak = after.indexOf('\n');
    const second = secondBreak === -1 ? after : after.slice(0, secondBreak);
    if (second.trim() !== '') return null;
    const rest = secondBreak === -1 ? '' : after.slice(secondBreak + 1);
    return { emoji, title: title?.trim(), icon, rest };
  }
  return { emoji, title: title?.trim(), icon, rest: '' };
}
