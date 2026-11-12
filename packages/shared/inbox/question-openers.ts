import { DIRECTIVE_OPEN_RE } from "@plannotator/core/markdown-structure";
import { forEachTopLevelLine } from "@plannotator/core/question-block";

export interface QuestionOpenerWithText {
  line: number;
  directive: string;
}

export const QUESTION_OPENERS_WITH_TEXT_MAX = 5;

const QUESTION_OPENER_RE = /^:::\s*(question(?:-multi|-text)?)(?![a-zA-Z0-9-])(.*)$/i;

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
