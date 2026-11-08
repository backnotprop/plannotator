/**
 * Plannotator Inbox: a question that likely does not ask what the agent
 * meant. An agent whose history was compacted guessed the block's shape and
 * put an `id: sd-approach` line first; the first line is the question, so the
 * person saw "id: sd-approach" as the question and nothing said so. The send
 * result (send_message, submit_guide, `plannotator inbox call`) adds a line
 * per such question. Advice only: the send succeeds as it is.
 */

import type { InboxQuestionToCheck } from "@plannotator/core/inbox-questions";

/**
 * The send tools' advice for each question that likely does not ask what the
 * agent meant (`inboxQuestionsToCheck`): a question line that reads as a
 * `key: value` field (an agent put `id: …` first, so the person saw that as
 * the question), and a pick-one or pick-several block with no choices. Each
 * says how to send it again in place of this one (`reply_to` the message
 * just sent, `supersedes` its `<message id>/<key>`). Never a refusal. ""
 * when there is none.
 */
export function questionsToCheckText(messageId: string, list: readonly InboxQuestionToCheck[]): string {
  return list
    .map(({ key, position, reads_as, no_choices }) => {
      const again = `send it again with reply_to "${messageId}" and supersedes "${messageId}/${key}"`;
      const readsAs = reads_as
        ? ` Question ${position} reads as "${reads_as}": is that the question? The first line of a question block is the question itself. If not, ${again}, with the question on the first line.`
        : "";
      const noChoices = no_choices
        ? ` Question ${position} is a \`${no_choices}\` with no choices, so the person answers it in words. To offer choices, ${again}, each choice as \`- [ ] label\`; for an answer in words, write \`:::question-text\`.`
        : "";
      return readsAs + noChoices;
    })
    .join("");
}
