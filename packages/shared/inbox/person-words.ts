import { INBOX_ACTIONS_HEADING } from "@plannotator/core/inbox-actions";
import { splitInboxReplyBody } from "@plannotator/core/inbox-questions";
import { INBOX_ATTACHMENT_FEEDBACK_TITLE, INBOX_GUIDE_FEEDBACK_TITLE, INBOX_MESSAGE_FEEDBACK_TITLE, INBOX_OWN_MESSAGE_FEEDBACK_TITLE } from "@plannotator/core/inbox-review";
import { codeFenceCloseIndex } from "@plannotator/core/markdown-structure";
import { withoutInboxSkillsBlock } from "@plannotator/core/skill-reference-block";

/** The headings a Send appends after the person's words (the action items, the annotations' feedback). */
const SEND_APPENDED_HEADINGS: ReadonlySet<string> = new Set([
  `## ${INBOX_ACTIONS_HEADING}`,
  `# ${INBOX_MESSAGE_FEEDBACK_TITLE}`,
  `# ${INBOX_OWN_MESSAGE_FEEDBACK_TITLE}`,
  `# ${INBOX_ATTACHMENT_FEEDBACK_TITLE}`,
  `# ${INBOX_GUIDE_FEEDBACK_TITLE}`,
]);

/**
 * The person's own words in a reply as stored (approval "board-hashtags"), for a card made later for its
 * thread (`threadTaggedInitiative`): without the reply's first line, the still-open line and the answers
 * section (`splitInboxReplyBody`) and the skills block, cut where a Send appends its own sections (the
 * action items, the annotations' feedback, which quote plans and files): only at those headings, each after
 * a blank line, never inside a code fence. The person's own headings and fenced `# comments` stay words.
 * At send time the reply's words are read directly (`sendReply`), and a New message's body is its words.
 */
export function personWords(body: string): string {
  const lines = splitInboxReplyBody(withoutInboxSkillsBlock(body)).words.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) {
      i = codeFenceCloseIndex(lines, i);
      continue;
    }
    if (SEND_APPENDED_HEADINGS.has(lines[i]!.trimEnd()) && (i === 0 || lines[i - 1]!.trim() === "")) return lines.slice(0, i).join("\n");
  }
  return lines.join("\n");
}

