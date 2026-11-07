/**
 * Notes a guided review's author pins to lines of a file it places
 * (`sections[].diffs[].notes`, guide snapshot version 4; approval
 * "inbox-context-notes"): the note's shape, its read and its hunk check.
 * Browser-safe and free of the Inbox, so the guide format (and the Pi
 * extension, which vendors it) can read version 4.
 */

import { isLineRangeInPatch, parseDiffToFiles } from "./diff-files";

/** A side of a diff a note sits on: added and unchanged lines are `new`, removed lines `old`. */
export type InboxNoteSide = "new" | "old";

/** One note the guided review's author pins to lines of a file it places (`sections[].diffs[].notes`). */
export interface GuideDiffNote {
  /** First and last line, numbered as the patch's hunk headers number that side. */
  lineStart: number;
  lineEnd: number;
  /** Absent: `new`. */
  side?: InboxNoteSide;
  /** One or two plain sentences. */
  text: string;
}

/** The longest note a guide or a message may carry, in characters. */
export const INBOX_NOTE_TEXT_MAX = 1000;
/** The most notes one file of a guide may carry. */
export const GUIDE_NOTES_PER_FILE_MAX = 20;

/** Whether lines `start`–`end` of one side sit inside one hunk of a file's patch. */
export function inboxLinesInOneHunk(filePatch: string, side: InboxNoteSide, start: number, end: number): boolean {
  return isLineRangeInPatch(filePatch, start, end, side);
}

/** "line 5", "lines 16–18", "removed lines 4–6": how a note's place reads in a refusal or a link. */
export function inboxNoteLinesWord(side: InboxNoteSide, start: number, end: number): string {
  const range = start === end ? `line ${start}` : `lines ${start}–${end}`;
  return side === "old" ? `removed ${range}` : range;
}

/**
 * Reads one diff reference's `notes` as an agent sent them. Problems are
 * returned in words that name the note (`sections[1].diffs[0].notes[2]`);
 * a note is kept only when it has none.
 */
export function readGuideDiffNotes(input: unknown, path: string): { notes: GuideDiffNote[]; problems: string[] } {
  const problems: string[] = [];
  const notes: GuideDiffNote[] = [];
  if (input === undefined) return { notes, problems };
  if (!Array.isArray(input)) return { notes, problems: [`${path} must be an array of { lineStart, lineEnd, side?, text }.`] };
  if (input.length > GUIDE_NOTES_PER_FILE_MAX) problems.push(`${path} has ${input.length} notes; one file takes at most ${GUIDE_NOTES_PER_FILE_MAX}.`);
  input.forEach((raw, k) => {
    const at = `${path}[${k}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${at} must be { lineStart, lineEnd, side?, text }.`);
      return;
    }
    const n = raw as Record<string, unknown>;
    const unknown = Object.keys(n).filter((key) => !["lineStart", "lineEnd", "side", "text"].includes(key));
    if (unknown.length > 0) problems.push(`${at} has ${unknown.join(", ")}, which is not a field (lineStart, lineEnd, side, text).`);
    const start = n.lineStart;
    const end = n.lineEnd ?? n.lineStart;
    if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1) problems.push(`${at}.lineStart must be a line number (1 or more).`);
    if (typeof end !== "number" || !Number.isSafeInteger(end) || (typeof start === "number" && end < start)) problems.push(`${at}.lineEnd must be a line number, not before lineStart.`);
    if (n.side !== undefined && n.side !== "new" && n.side !== "old") problems.push(`${at}.side must be "new" or "old".`);
    const text = typeof n.text === "string" ? n.text.trim() : "";
    if (!text) problems.push(`${at}.text must be one or two sentences.`);
    else if (text.length > INBOX_NOTE_TEXT_MAX) problems.push(`${at}.text is ${text.length} characters; a note takes at most ${INBOX_NOTE_TEXT_MAX}.`);
    if (problems.some((p) => p.startsWith(at))) return;
    notes.push({ lineStart: start as number, lineEnd: end as number, ...(n.side === "old" ? { side: "old" as const } : {}), text });
  });
  return { notes, problems };
}

/** The parts of a guide `checkGuideNotes` reads. */
export interface GuideNotesInput {
  sections: readonly { diffs: readonly { file: string; notes?: readonly GuideDiffNote[] }[] }[];
}

/**
 * What is wrong with a guide's notes against its patch: each note must sit
 * inside one hunk of its file, on the side it names. Empty when nothing is.
 * Each problem names the note and its lines.
 */
export function checkGuideNotes(guide: GuideNotesInput, rawPatch: string): string[] {
  const files = new Map(parseDiffToFiles(rawPatch).map((file) => [file.path, file.patch] as const));
  const problems: string[] = [];
  guide.sections.forEach((section, i) => {
    section.diffs.forEach((ref, j) => {
      (ref.notes ?? []).forEach((note, k) => {
        const side = note.side ?? "new";
        const patch = files.get(ref.file);
        if (patch === undefined || !inboxLinesInOneHunk(patch, side, note.lineStart, note.lineEnd)) {
          problems.push(
            `sections[${i}].diffs[${j}].notes[${k}] (${ref.file}, ${inboxNoteLinesWord(side, note.lineStart, note.lineEnd)}) is not inside one hunk of that file: use the line numbers of the patch's hunk headers${side === "new" ? ', and side "old" for removed lines' : ""}.`,
          );
        }
      });
    });
  });
  return problems;
}

/** Whether a guide carries any note (it is then snapshot version 4). */
export function guideHasNotes(guide: GuideNotesInput): boolean {
  return guide.sections.some((section) => section.diffs.some((ref) => (ref.notes?.length ?? 0) > 0));
}
