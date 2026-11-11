/** A Send appends Plannotator's feedback text, kept as is for the agent. The window draws it as its own block (`[data-reply-feedback]`) with text-size headings. Display only. */
import { ATTACHMENT_FEEDBACK_HEADING, GUIDE_FEEDBACK_TITLE, MESSAGE_FEEDBACK_HEADING } from './attachments';

const FEEDBACK_HEADINGS = new Set([MESSAGE_FEEDBACK_HEADING.title, ATTACHMENT_FEEDBACK_HEADING.title, GUIDE_FEEDBACK_TITLE].map((title) => `# ${title}`));
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

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
