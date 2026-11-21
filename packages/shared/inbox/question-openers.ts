/**
 * Plannotator Inbox: a question block that never opened (the owner,
 * 2026-11-02). An agent wrote `:::question {#bar}`; a directive opens only
 * with its name alone on the line (`DIRECTIVE_OPEN_RE`), so the block became
 * plain text and the person saw a question they could not answer. The send
 * result then adds one line per such opener. Advice only: the send succeeds
 * as it is, the stored message is unchanged, and the person sees nothing new.
 */

import { DIRECTIVE_OPEN_RE } from "@plannotator/core/markdown-structure";
import { forEachTopLevelLine } from "@plannotator/core/question-block";

/** One opener line that did not open its block: its 1-based line in the body and the directive as written (`:::question`). */
export interface QuestionOpenerWithText {
  line: number;
  directive: string;
}

/** How many such lines the result names; the rest are counted (`question_openers_with_text_more`). */
export const QUESTION_OPENERS_WITH_TEXT_MAX = 5;

/**
 * `:::question`, `:::question-multi` or `:::question-text` (any case, spaces
 * allowed after `:::`, as `DIRECTIVE_OPEN_RE` allows), followed by text that
 * is not part of the name. `:::questions` or `:::question-other` is another
 * name, not this mistake.
 */
const QUESTION_OPENER_RE = /^:::\s*(question(?:-multi|-text)?)(?![a-zA-Z0-9-])(.*)$/i;

/**
 * The lines of `body` that start with a question directive's name followed by
 * extra text, so they open no block. Only the lines the parser reads at the
 * top level (core's `forEachTopLevelLine`, the walk that finds the blocks, with
 * no frontmatter as the Inbox reads a body): a line inside a code fence, a
 * directive's body, a raw HTML block or display math is not named, since
 * putting the name alone on it would open nothing there either.
 */
export function questionOpenersWithText(body: string): QuestionOpenerWithText[] {
  if (typeof body !== "string" || !body.includes(":::")) return [];
  const out: QuestionOpenerWithText[] = [];
  forEachTopLevelLine(body, { frontmatter: false }, (text, line) => {
    const trimmed = text.trim();
    if (DIRECTIVE_OPEN_RE.test(trimmed)) return;
    const match = QUESTION_OPENER_RE.exec(trimmed);
    if (match && match[2]!.trim() !== "") out.push({ line, directive: `:::${match[1]}` });
  });
  return out;
}

/**
 * The warning lines: one per opener (the owner's sentence), the first
 * `QUESTION_OPENERS_WITH_TEXT_MAX`, then one line counting the rest when
 * `more` > 0. "" for none. Each line starts with a newline, so it is a line
 * of its own in the result text.
 */
export function questionOpenersWithTextText(openers: readonly QuestionOpenerWithText[], more = 0): string {
  const named = openers.slice(0, QUESTION_OPENERS_WITH_TEXT_MAX);
  const rest = more + (openers.length - named.length);
  const lines = named.map(
    ({ line, directive }) =>
      `\nLine ${line} starts with \`${directive}\` but has text after it, so the person sees it as plain text and can't answer it. Put \`${directive}\` alone on its line and send the question again.`,
  );
  if (lines.length > 0 && rest > 0) lines.push(`\nAnd ${rest} more line${rest === 1 ? "" : "s"} like ${rest === 1 ? "this" : "these"}.`);
  return lines.join("");
}
