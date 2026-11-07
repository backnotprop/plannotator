/**
 * The feedback a Send wrote after the person's own words, as the window draws
 * it (the owner's ask, 2026-10-31: "Is there a reason the inline comments
 * appear like so big? Like a header? … A little smaller would be nice.").
 *
 * A Send carries the person's comments as Plannotator's feedback text
 * (`attachmentFeedback`): "# Feedback on your messages", "# Feedback on the
 * attached files" and "# Feedback on the guided review", each with `##` file
 * or message headings and `###` comments. That text is what the agent gets
 * and it is kept as it is. When the window draws the person's own reply, the
 * feedback is drawn as a block of its own (`[data-reply-feedback]` in
 * `MessageBody`), whose headings inbox.css sets at text size, so it reads as
 * part of the reply and not as page headings. Display only: an agent's
 * message, and every other surface, draws its headings as before.
 */
import { ATTACHMENT_FEEDBACK_HEADING, GUIDE_FEEDBACK_TITLE, MESSAGE_FEEDBACK_HEADING } from './attachments';

/** The headings the export opens each feedback section with. */
const FEEDBACK_HEADINGS = new Set([MESSAGE_FEEDBACK_HEADING.title, ATTACHMENT_FEEDBACK_HEADING.title, GUIDE_FEEDBACK_TITLE].map((title) => `# ${title}`));
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * The person's words and the feedback after them: split at the first
 * feedback section heading (on a line of its own, after a blank line, outside
 * code fences), or null when the text has none.
 */
export function splitReplyFeedback(text: string): { words: string; feedback: string } | null {
  if (!text.includes('# Feedback on ')) return null;
  const lines = text.split('\n');
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const opener = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener) {
      fence = opener;
      continue;
    }
    if (!FEEDBACK_HEADINGS.has(line.trimEnd())) continue;
    if (index > 0 && lines[index - 1]!.trim() !== '') continue;
    return { words: lines.slice(0, index).join('\n').trim(), feedback: lines.slice(index).join('\n').trim() };
  }
  return null;
}
