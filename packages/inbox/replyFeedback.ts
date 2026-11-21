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
import { ATTACHMENT_FEEDBACK_HEADING, GUIDE_FEEDBACK_TITLE, MESSAGE_FEEDBACK_HEADING, OWN_MESSAGE_FEEDBACK } from './attachments';

/** The headings the export opens each feedback section with. */
const FEEDBACK_HEADINGS = new Set([MESSAGE_FEEDBACK_HEADING.title, OWN_MESSAGE_FEEDBACK.title, ATTACHMENT_FEEDBACK_HEADING.title, GUIDE_FEEDBACK_TITLE].map((title) => `# ${title}`));
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

/** A line of a pinned element's details, as the export writes them after its comment (`elementContextExportBlock`). */
const ELEMENT_DETAIL = /^- \*\*(?:selector|path|role|name|component|attrs|text|route|box|near)\*\* /;
/** The sections whose comments can be on an element of a page: an attached page's, and a message's live html block's. */
const ELEMENT_SECTIONS = [`# ${ATTACHMENT_FEEDBACK_HEADING.title}`, `# ${MESSAGE_FEEDBACK_HEADING.title}`];
/** The fence that opens a pinned element's HTML outline there. */
const ELEMENT_OUTLINE = /^````html\s*$/;

/**
 * The person's own reply as the window draws it, without the page details a
 * pin on an HTML page carries for the agent (the owner's audit, 2026-11-19:
 * the sent reply showed the element's outline, drawn as a little page, then
 * its selector, path, box in pixels and the like). Under "# Feedback on the
 * attached files", and under "# Feedback on your messages" (a pin on an
 * element of a message's live html block, whose outline fence would draw as a
 * little live page), each pinned element's outline fence and the detail lines
 * after it are left out of the drawing, so the comment reads as its heading
 * (`Feedback on: "412 ms"`) and the person's words. The stored text, which is
 * what the agent reads, keeps them all. Display only; any other fence and any
 * other list stays as written.
 */
export function withoutElementDetails(markdown: string): string {
  if (!ELEMENT_SECTIONS.some((heading) => markdown.includes(heading)) || !markdown.includes('- **')) return markdown;
  const lines = markdown.split('\n');
  const kept: string[] = [];
  let inSection = false;
  let changed = false;
  /** How many detail lines start at `from`. */
  const detailsAt = (from: number) => {
    let end = from;
    while (end < lines.length && ELEMENT_DETAIL.test(lines[end]!)) end++;
    return end - from;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (ELEMENT_SECTIONS.includes(line)) inSection = true;
    else if (inSection && /^# /.test(line)) inSection = false;
    if (inSection && ELEMENT_OUTLINE.test(line)) {
      // The outline's fence and the details right after it: one pinned element.
      let close = index + 1;
      while (close < lines.length && lines[close]!.trimEnd() !== '````') close++;
      if (close < lines.length && detailsAt(close + 1) > 0) {
        index = close + detailsAt(close + 1);
        changed = true;
        continue;
      }
    }
    const opener = FENCE.exec(line)?.[1];
    if (opener) {
      // Any other fence is the person's or the file's: kept whole.
      kept.push(line);
      let close = index + 1;
      while (close < lines.length) {
        const end = FENCE.exec(lines[close]!)?.[1];
        kept.push(lines[close]!);
        if (end && end[0] === opener[0] && end.length >= opener.length) break;
        close++;
      }
      index = close;
      continue;
    }
    // Details with no outline (a short export): two or more in a row, after a blank line.
    if (inSection && ELEMENT_DETAIL.test(line) && (lines[index - 1] ?? '').trim() === '' && detailsAt(index) >= 2) {
      index += detailsAt(index) - 1;
      changed = true;
      continue;
    }
    kept.push(line);
  }
  return changed ? kept.join('\n') : markdown;
}
