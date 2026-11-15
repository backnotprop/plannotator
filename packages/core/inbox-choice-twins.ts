/**
 * Two choices of one Inbox question that no step after a pick can tell
 * apart. A pick is stored as its choice's exact label, and every reader of
 * it compares exactly first (the card's radio, `checkInboxAnswer`,
 * `canonicalQuestionAnswer`, `isRecommendedQuestionAnswer`, the file card's
 * twin check), so "Yes" and "Yes!", or "A" and "a", stay two choices. What
 * still merges them is whitespace: the parser trims a label, and the reply's
 * `Answer:` line (`formatQuestionAnswerLines`) and the rendered card collapse
 * each run of spaces. Labels equal after that are one answer for two
 * choices, so a send that asks such a question is refused before anything
 * is written (`InboxStore.sendMessage`), body and attached files alike.
 */

interface TwinQuestion {
  prompt: string;
  parsed: { choices: readonly { label: string }[] };
}

const spaced = (label: string): string => label.replace(/\s+/g, " ").trim();

/** The first two choice labels of `question` that read the same once spaces are folded, or null. */
export function inboxTwinChoiceLabels(question: Pick<TwinQuestion, "parsed">): [string, string] | null {
  const seen = new Map<string, string>();
  for (const { label } of question.parsed.choices) {
    const folded = spaced(label);
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
    const place = question.file === undefined ? "body" : `attachments: ${question.file}`;
    return {
      field: question.file === undefined ? "body" : "attachments",
      message: `${place}: question "${prompt}" has the choice "${spaced(twins[0])}" twice, so a pick cannot tell them apart. Give each choice its own words.`,
    };
  }
  return null;
}
