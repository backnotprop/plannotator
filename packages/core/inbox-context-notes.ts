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
  from: number;
  to: number;
}

const NOTE_OPEN = /^:::note[ \t]+(\S.*?)[ \t]*$/;

/** Reads a `:::note` anchor: `src/a.ts#L42-L48 old`. Null when it is none. */
export function parseInboxNoteAnchor(anchor: string): { file: string; side: InboxNoteSide; lineStart: number; lineEnd: number } | null {
  const m = /^(.*?)(?:[ \t]+(old|new))?$/.exec(anchor.trim());
  if (!m || !/#L\d/.test(m[1]!)) return null;
  const target = parseShapeCodeTarget(m[1]);
  if (!target) return null;
  return { file: target.path, side: m[2] === "old" ? "old" : "new", lineStart: target.line, lineEnd: target.lineEnd ?? target.line };
}

/** The `:::note path#L…` blocks of a message body, in order. */
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
