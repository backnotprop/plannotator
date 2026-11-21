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
import { codeFenceCloseIndex } from '@plannotator/core/markdown-structure';
import { ATTACHMENT_FEEDBACK_HEADING, GUIDE_FEEDBACK_TITLE, LIVE_SITE_FEEDBACK_HEADING, MESSAGE_FEEDBACK_HEADING, OWN_MESSAGE_FEEDBACK } from './attachments';

/** The headings the export opens each feedback section with (the ones the reply's feedback block is split at). */
const FEEDBACK_HEADINGS = new Set([MESSAGE_FEEDBACK_HEADING.title, OWN_MESSAGE_FEEDBACK.title, ATTACHMENT_FEEDBACK_HEADING.title, GUIDE_FEEDBACK_TITLE].map((title) => `# ${title}`));
/** Every heading a Send's feedback can start with: those, and comments on a running app's pages. */
const ANY_FEEDBACK_HEADING = new Set([...FEEDBACK_HEADINGS, `# ${LIVE_SITE_FEEDBACK_HEADING.title}`]);
/**
 * A line the window's parser opens a code fence on (`parser.ts`): three or more backticks, any indentation.
 * Only backticks: `~~~` is ordinary text there.
 */
const FENCE = /^\s*(`{3,})/;

/**
 * A line that closes a fence `opener` opened, as the window's parser closes it (`codeFenceCloseIndex`): any
 * indentation, then at least as many backticks, an info string after them or not.
 */
function closesFence(line: string, opener: string): boolean {
  const run = /^\s*(`+)/.exec(line)?.[1];
  return !!run && run.length >= opener.length;
}

/** A heading from `headings` on a line of its own, after a blank line (or first). */
function isSectionHeading(lines: readonly string[], index: number, headings: ReadonlySet<string>): boolean {
  return headings.has(lines[index]!.trimEnd()) && (index === 0 || lines[index - 1]!.trim() === '');
}

/**
 * Where the first feedback section starts: a heading from `headings` on a line of its own, after a blank line
 * (or first), outside code fences as the window's parser reads them (backticks only, closed by any line that
 * starts with as many); -1 when there is none.
 */
function feedbackStart(lines: string[], headings: ReadonlySet<string>): number {
  for (let index = 0; index < lines.length; index++) {
    if (FENCE.test(lines[index]!)) {
      index = codeFenceCloseIndex(lines, index);
      continue;
    }
    if (isSectionHeading(lines, index, headings)) return index;
  }
  return -1;
}

/**
 * The person's words and the feedback after them: split at the first
 * feedback section heading (on a line of its own, after a blank line, outside
 * code fences as the window draws them), or null when the text has none.
 */
export function splitReplyFeedback(text: string): { words: string; feedback: string } | null {
  if (!text.includes('# Feedback on ')) return null;
  const lines = text.split('\n');
  const index = feedbackStart(lines, FEEDBACK_HEADINGS);
  if (index < 0) return null;
  return { words: lines.slice(0, index).join('\n').trim(), feedback: lines.slice(index).join('\n').trim() };
}

/** A line of a pinned element's details, as the export writes them after its comment (`elementContextExportBlock`). */
const ELEMENT_DETAIL = /^- \*\*(?:selector|path|role|name|component|attrs|text|route|box|near)\*\* /;
/** The fence that opens a pinned element's HTML outline (`elementContextExportBlock`), and the one that closes it. */
const ELEMENT_OUTLINE = /^````html\s*$/;
const ELEMENT_OUTLINE_CLOSE = /^\s{0,3}`{4,}\s*$/;
/**
 * A line the window's parser would take as a fence it draws instead of showing code: a live page (`html`), a
 * drawing (`svg`) or a diagram (`mermaid`, `dot`, `graphviz`, `gv`): any indentation, three or more backticks,
 * that language first (`isHtmlEmbedLanguage`, `isSvgFenceLanguage`, `isMermaidLanguage`, `isGraphvizLanguage`).
 */
const DRAWN_FENCE = /^(\s*`{3,}\s*)(html|svg|mermaid|dot|graphviz|gv)(?=\s|$)/i;
/** What a drawn fence's language becomes in the feedback: markup as `xml`, a diagram's source as `text`. */
const AS_CODE = (_line: string, fence: string, language: string) => `${fence}${/^(?:html|svg)$/i.test(language) ? 'xml' : 'text'}`;

/**
 * The person's own reply as the window draws it (display only; the stored
 * text, which is what the agent reads, keeps every line). From the first
 * feedback heading to the end of the reply (everything a Send wrote after the
 * person's words: comments on agents' messages, on the person's own, on
 * attached files, on a guided review, on a running app's pages):
 * - each pinned element's ````html outline and the detail lines after it
 *   (`- **selector**`, `path`, `box` and the like), or two or more detail
 *   lines after a blank line, are left out (the owner's audit, 2026-11-19: the
 *   sent reply showed the outline drawn as a little page, then its selector,
 *   path and box), so a comment reads as its heading and the person's words.
 *   The outline goes whether or not detail lines follow it: a page can post
 *   an outline alone;
 * - no other fence there is ever drawn as a live page, a drawing or a
 *   diagram: an ```html or ```svg fence (a page's own words in a quote's
 *   heading can open one) is drawn as code (`xml`), a ```mermaid or ```dot
 *   one as its source (`text`).
 * The first feedback heading is found without reading the fences above it, so
 * nothing the person typed (a lone ``` or ~~~) can hide it; a fence of theirs
 * that the window would draw (```html, ```svg, a diagram) and that would still
 * be open at that heading is drawn as code too, so it never takes in the
 * feedback. The person's own words before the first feedback heading are
 * otherwise drawn as written, their closed ```html fences live as in any
 * message. (A feedback heading the person pasted on a line of its own inside
 * their own code block starts the feedback there: their later drawn fences
 * draw as code. Display only.)
 */
export function withoutElementDetails(markdown: string): string {
  if (!markdown.includes('# Feedback on ')) return markdown;
  const lines = markdown.split('\n');
  const start = lines.findIndex((_, index) => isSectionHeading(lines, index, ANY_FEEDBACK_HEADING));
  if (start < 0) return markdown;
  let changed = false;
  // The person's words: as written, except a drawn fence the window would keep open into the feedback.
  const kept = lines.slice(0, start).map((line, index) => {
    if (!DRAWN_FENCE.test(line) || codeFenceCloseIndex(lines, index) < start) return line;
    changed = true;
    return line.replace(DRAWN_FENCE, AS_CODE);
  });
  /** How many detail lines start at `from`. */
  const detailsAt = (from: number) => {
    let end = from;
    while (end < lines.length && ELEMENT_DETAIL.test(lines[end]!)) end++;
    return end - from;
  };
  /** The line as drawn: a fence that would draw a page draws code. */
  const defused = (line: string) => {
    const drawn = line.replace(DRAWN_FENCE, AS_CODE);
    if (drawn !== line) changed = true;
    return drawn;
  };
  let fence: string | null = null;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    if (ELEMENT_OUTLINE.test(line)) {
      // The outline and the details right after it (none or more): one pinned element. An outline that is
      // never closed would hold the rest: it is left out to the end.
      let close = index + 1;
      while (close < lines.length && !ELEMENT_OUTLINE_CLOSE.test(lines[close]!)) close++;
      index = close < lines.length ? close + detailsAt(close + 1) : lines.length;
      changed = true;
      continue;
    }
    if (fence !== null) {
      // Inside a fence (the person's, a file's): kept, but never a live page.
      if (closesFence(line, fence)) fence = null;
      kept.push(defused(line));
      continue;
    }
    const opener = FENCE.exec(line)?.[1];
    if (opener) {
      fence = opener;
      kept.push(defused(line));
      continue;
    }
    // Details with no outline (a short export): two or more in a row, after a blank line.
    if (ELEMENT_DETAIL.test(line) && (lines[index - 1] ?? '').trim() === '' && detailsAt(index) >= 2) {
      index += detailsAt(index) - 1;
      changed = true;
      continue;
    }
    kept.push(defused(line));
  }
  return changed ? kept.join('\n') : markdown;
}
