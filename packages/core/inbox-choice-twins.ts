/**
 * Two choices of one Inbox question that read the same. A pick is stored as
 * its choice's label, and every reader after it (the card's radio, the
 * reply's `Answer:` line, "(your recommendation)", an older answer read
 * through `canonicalQuestionAnswer`) names a choice by that label, falling
 * back to it with case, spacing, emphasis and end punctuation folded
 * (`normalizeQuestionText`). Labels equal under that fold are one answer for
 * two choices, so a send that asks such a question is refused before
 * anything is written (`InboxStore.sendMessage`), body and attached files
 * alike. The parser has already given two choices that share only the words
 * before a dash their whole text (`parseQuestionBlock`).
 */

import { normalizeQuestionText } from "./question-block";

interface TwinQuestion {
  prompt: string;
  parsed: { choices: readonly { label: string }[] };
}

/** The first two choice labels of `question` that read the same, or null. */
export function inboxTwinChoiceLabels(question: Pick<TwinQuestion, "parsed">): [string, string] | null {
  const seen = new Map<string, string>();
  for (const { label } of question.parsed.choices) {
    const folded = normalizeQuestionText(label);
    const first = seen.get(folded);
    if (first !== undefined) return [first, label];
    seen.set(folded, label);
  }
  return null;
}

/**
 * The refusal for the first of `questions` with two such choices, or null.
 * `file` names the attached file a question is in (its message leads with
 * `attachments: <name>`), else it is the body's.
 */
export function inboxTwinChoicesRefusal(
  questions: readonly (TwinQuestion & { file?: string })[],
): { field: "body" | "attachments"; message: string } | null {
  for (const question of questions) {
    const twins = inboxTwinChoiceLabels(question);
    if (!twins) continue;
    const prompt = question.prompt.length > 80 ? `${question.prompt.slice(0, 79)}…` : question.prompt;
    const [a, b] = twins;
    const same = a === b ? `the choice "${a}" twice` : `the choices "${a}" and "${b}", which differ only in case, spacing, emphasis or end punctuation`;
    const place = question.file === undefined ? "body" : `attachments: ${question.file}`;
    return {
      field: question.file === undefined ? "body" : "attachments",
      message: `${place}: question "${prompt}" has ${same}, so a pick cannot tell them apart. Give each choice its own words.`,
    };
  }
  return null;
}
