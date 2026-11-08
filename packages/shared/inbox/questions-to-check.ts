/**
 * Plannotator Inbox: a question that likely does not ask what the agent
 * meant: a pick-one or pick-several block with no choices, which the person
 * answers in words. The send result (send_message, submit_guide,
 * `plannotator inbox call`) adds a line per such question. Advice only: the
 * send succeeds as it is.
 */

import type { InboxQuestionToCheck } from "@plannotator/core/inbox-questions";

/**
 * The send tools' advice for each such question (`inboxQuestionsToCheck`),
 * saying how to send it again in place of this one (`reply_to` the message
 * just sent, `supersedes` its `<message id>/<key>`). Never a refusal. ""
 * when there is none.
 */
export function questionsToCheckText(messageId: string, list: readonly InboxQuestionToCheck[]): string {
  return list
    .map(
      ({ key, position, no_choices }) =>
        ` Question ${position} is a \`${no_choices}\` with no choices, so the person answers it in words. To offer choices, send it again with reply_to "${messageId}" and supersedes "${messageId}/${key}", each choice as \`- [ ] label\`; for an answer in words, write \`:::question-text\`.`,
    )
    .join("");
}
