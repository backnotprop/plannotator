/**
 * Plannotator Inbox: a question block that never opened (the owner,
 * 2026-11-02). An agent wrote `:::question {#bar}`; a directive opens only
 * with its name alone on the line (`DIRECTIVE_OPEN_RE`), so the block became
 * plain text and the person saw a question they could not answer. The send
 * result then adds one line per such opener. Advice only: the send succeeds
 * as it is, the stored message is unchanged, and the person sees nothing new.
 */

import { DIRECTIVE_OPEN_RE, codeFenceCloseIndex } from "@plannotator/core/markdown-structure";

/** One opener line that did not open its block: its 1-based line in the body and the directive as written (`:::question`). */
export interface QuestionOpenerWithText {
  line: number;
  directive: string;
}

/**
 * `:::question`, `:::question-multi` or `:::question-text` (any case, spaces
 * allowed after `:::`, as `DIRECTIVE_OPEN_RE` allows), followed by text that
 * is not part of the name. `:::questions` or `:::question-other` is another
 * name, not this mistake.
 */
const QUESTION_OPENER_RE = /^:::\s*(question(?:-multi|-text)?)(?![a-zA-Z0-9-])(.*)$/i;

/**
 * The lines of `body` that start with a question directive's name followed by
 * extra text, so they open no block. Lines inside a backtick code fence (the
 * fences the block splitter knows) are an example, not a mistake.
 */
export function questionOpenersWithText(body: string): QuestionOpenerWithText[] {
  if (typeof body !== "string" || !body.includes(":::")) return [];
  const lines = body.split("\n");
  const out: QuestionOpenerWithText[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("```")) {
      i = codeFenceCloseIndex(lines, i);
      continue;
    }
    if (DIRECTIVE_OPEN_RE.test(trimmed)) continue;
    const match = QUESTION_OPENER_RE.exec(trimmed);
    if (match && match[2]!.trim() !== "") out.push({ line: i + 1, directive: `:::${match[1]}` });
  }
  return out;
}

/** The warning lines for such openers, one per line, or "" for none. Each starts with a newline: appended to the result text. */
export function questionOpenersWithTextText(openers: readonly QuestionOpenerWithText[]): string {
  return openers
    .map(
      ({ line, directive }) =>
        `\nLine ${line} starts with \`${directive}\` but has text after it, so the person sees it as plain text and can't answer it. Put \`${directive}\` alone on its line and send the question again.`,
    )
    .join("");
}
