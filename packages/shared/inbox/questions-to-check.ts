/** Advice for a question that likely does not ask what the agent meant (a pick block with no choices). Never a refusal. */

import type { InboxQuestionToCheck } from "@plannotator/core/inbox-questions";

export function questionsToCheckText(messageId: string, list: readonly InboxQuestionToCheck[]): string {
  return list
    .map(
      ({ key, position, no_choices }) =>
        ` Question ${position} is a \`${no_choices}\` with no choices, so the person answers it in words. To offer choices, send it again with reply_to "${messageId}" and supersedes "${messageId}/${key}", each choice as \`- [ ] label\`; for an answer in words, write \`:::question-text\`.`,
    )
    .join("");
}
