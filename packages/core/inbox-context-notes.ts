/**
 * Context notes in the Inbox's code review (issue #2588, approval
 * "inbox-context-notes"): an agent's words pinned to lines of a review's diff.
 * A note is never the person's comment: it is not an annotation, so it never
 * reaches the comments panel, the count, the draft, the verdict or a post.
 *
 * Three writers put notes there, each through a channel it already has:
 * - the guided review's author: optional `notes` on a diff reference of its
 *   guide (`GuideDiffNote`, snapshot version 4; `checkGuideNotes`);
 * - risk ranking: the places a high-risk judgment names (`InboxPullRiskPlace`);
 * - the review's thread agent: a `:::note path#L…` block in a message it
 *   sends (`inboxNoteBlocks`).
 * The window also shows a Show me board's parts that point at code. This file
 * holds the `:::note` parse; the guide author's notes and their checks live
 * in `guide-notes.ts` (re-exported here).
 */

import { INBOX_NOTE_TEXT_MAX, type InboxNoteSide } from "./guide-notes";
import { parseShapeCodeTarget } from "./shape";

export * from "./guide-notes";

/** One `:::note` block of a message, as the thread agent wrote it. */
export interface InboxNoteBlock {
  file: string;
  side: InboxNoteSide;
  lineStart: number;
  lineEnd: number;
  text: string;
  /** The block's first and last line in the body (0-based, the `:::note` line and the `:::` line). */
  from: number;
  to: number;
}

/** A `:::note` opening line: the anchor is Show me's `data-code` (`path#L42`, `path#L42-L48`), ` old` after it for removed lines. */
const NOTE_OPEN = /^:::note[ \t]+(\S.*?)[ \t]*$/;

/** Reads a `:::note` anchor: `src/a.ts#L42-L48 old`. Null when it is none. */
export function parseInboxNoteAnchor(anchor: string): { file: string; side: InboxNoteSide; lineStart: number; lineEnd: number } | null {
  const m = /^(.*?)(?:[ \t]+(old|new))?$/.exec(anchor.trim());
  if (!m || !/#L\d/.test(m[1]!)) return null;
  const target = parseShapeCodeTarget(m[1]);
  if (!target) return null;
  return { file: target.path, side: m[2] === "old" ? "old" : "new", lineStart: target.line, lineEnd: target.lineEnd ?? target.line };
}

/**
 * The `:::note path#L…` blocks of a message body, in order. A block runs to
 * the next line that is `:::` alone; one never closed, one inside a code
 * fence, one whose anchor is not a file and lines, or one with no words is
 * not a note (it stays the text it was). Nothing is stored: the window reads
 * the notes off the message each time.
 */
export function inboxNoteBlocks(body: string | null | undefined): InboxNoteBlock[] {
  if (typeof body !== "string" || !body.includes(":::note")) return [];
  const lines = body.split("\n");
  const out: InboxNoteBlock[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMark) {
      if (fence === null) fence = fenceMark[1]![0]!.repeat(fenceMark[1]!.length);
      else if (fenceMark[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const open = NOTE_OPEN.exec(line.trim());
    if (!open) continue;
    const anchor = parseInboxNoteAnchor(open[1]!);
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trim() === ":::") {
        close = j;
        break;
      }
    }
    if (close < 0) break;
    const text = lines.slice(i + 1, close).join("\n").trim();
    if (anchor && text) out.push({ ...anchor, text: text.length > INBOX_NOTE_TEXT_MAX ? `${text.slice(0, INBOX_NOTE_TEXT_MAX - 1).trimEnd()}…` : text, from: i, to: close });
    i = close;
  }
  return out;
}
