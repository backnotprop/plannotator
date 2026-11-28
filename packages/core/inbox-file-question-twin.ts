/**
 * A question block in an attached Markdown file that repeats one of the
 * message body's questions (issue #2828 follow-up): an agent that attaches
 * the spec its message quotes asks each of those questions once, not twice.
 * The store records no question for such a block (`fileQuestionsOf` in
 * packages/shared/inbox/store.ts), and the file's card answers through the
 * body's record (packages/inbox/fileQuestions.tsx), so the counts, the
 * reply and the still-open line see one question.
 *
 * The same question: the same key (kind and prompt, `-N` for a repeat in its
 * own document, as `findQuestionBlocks` gives it) and the same choice labels
 * in the same order, since one record takes both cards' picks. A block with
 * the body's prompt and other choices stays a question of its own.
 */

interface TwinShape {
  key: string;
  choices: readonly { label: string }[];
}

/** The body question `file` repeats, or null. */
export function inboxFileQuestionTwin<T extends TwinShape>(file: TwinShape, body: readonly T[]): T | null {
  return (
    body.find(
      (q) => q.key === file.key && q.choices.length === file.choices.length && q.choices.every((c, i) => c.label === file.choices[i]!.label),
    ) ?? null
  );
}
