/**
 * Context notes in the Inbox's code review (issue #2588, approval
 * "inbox-context-notes", take Line): one model for every writer's notes.
 *
 * A note is an agent's words on lines of the diff, never the person's comment:
 * it is not a `CodeAnnotation`, so nothing has to filter it out of the comments
 * panel, the count, the draft, the verdict or a post. The diff draws notes
 * through review-editor's `contextNotes` seam (their own line annotations).
 *
 * Where notes come from (each read where it already is, nothing new stored):
 * - `guide`: the guided review's author, `notes` on its guide's diff references (snapshot v4);
 * - `risk`: a high-risk judgment's places (`InboxPullRiskJudgment.where`), on the PR's diff;
 * - `thread`: a `:::note path#L…` block in a message the thread's agent sent (core `inboxNoteBlocks`).
 *   An Ask's answer is never pinned by itself: it stays in the thread (the owner, 2026-11-07);
 * - `picture`: a Show me board's part that points at code (`data-code`), on its lines.
 *
 * A note written on an earlier review of the thread lands where its lines are
 * now (Show me's rule, `earlierLinesNow`): the same text, moved or not, keeps
 * the note fresh; text that changed, but whose place is still known, makes it
 * stale ("The code here changed after this answer"); a place not known draws
 * nothing in the diff.
 */
import { diffHunkLines, isLineRangeInPatch } from '@plannotator/core/diff-files';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
import { inboxNoteBlocks, type InboxNoteSide } from '@plannotator/core/inbox-context-notes';
import type { InboxPullRiskJudgment } from '@plannotator/core/inbox-types';
import { anchorLines, shiftLines, reviewDrawnOn } from '../review-drawing/showMeModel';

export type ContextNoteWriter = 'guide' | 'risk' | 'thread' | 'picture';

export interface ContextNote {
  id: string;
  writer: ContextNoteWriter;
  file: string;
  side: InboxNoteSide;
  lineStart: number;
  lineEnd: number;
  /** The agent's words: plain text, never markup. */
  text: string;
  /** guide, thread, picture: the agent's name. */
  agent?: string;
  /** risk: the level (always high) and the person's own rule the lines touch, when the agent named one. */
  level?: 'high';
  rule?: string;
  /** thread: what the person said that the message answers (its first words), when it answers one; when it came. */
  asked?: string;
  at?: string;
  /** thread: the message that carries the block. */
  message?: string;
  /** picture: the board, its title and the part's name. */
  picture?: { board: string; title: string; part: string };
  /** The code changed after the note was written: the round it was written on and the lines it named then. */
  stale?: { round: number; lines: [number, number] };
}

/** A file of a review, as the diff draws it. */
export interface NoteFile {
  path: string;
  patch: string;
}

/** The writer in words: what tells a review note, a risk, an answer and a picture apart (never color alone). */
export function writerWord(note: Pick<ContextNote, 'writer'>): string {
  return note.writer === 'guide' ? 'Review note' : note.writer === 'risk' ? 'Risk' : note.writer === 'thread' ? 'Answer' : 'Picture';
}

/** "16–18", or "5". */
export function rangeWord(lines: readonly [number, number]): string {
  return lines[0] === lines[1] ? `${lines[0]}` : `${lines[0]}–${lines[1]}`;
}

/** A path's last part. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** A file's lines on one side as the patch shows them (`new`: context and additions; `old`: context and removals). */
export function sideLines(patch: string, side: InboxNoteSide): Map<number, string> {
  const out = new Map<number, string>();
  for (const hunk of diffHunkLines(patch) ?? []) {
    for (const line of hunk.lines) {
      if (side === 'new' && line.kind !== 'del') out.set(line.newLine, line.text);
      if (side === 'old' && line.kind !== 'add') out.set(line.oldLine, line.text);
    }
  }
  return out;
}

/** Whether a note's lines are in this file's diff, on its side, inside one hunk. */
function inDiff(files: readonly NoteFile[], file: string, side: InboxNoteSide, start: number, end: number): boolean {
  const patch = files.find((f) => f.path === file)?.patch;
  return patch !== undefined && isLineRangeInPatch(patch, start, end, side);
}

/** The guided review's author's notes, from its snapshot (version 4). A note outside the diff is left out. */
export function guideNotes(snapshot: Pick<GuideSnapshot, 'guide'>, files: readonly NoteFile[], agent: string): ContextNote[] {
  const out: ContextNote[] = [];
  snapshot.guide.sections.forEach((section, i) =>
    section.diffs.forEach((ref, j) =>
      (ref.notes ?? []).forEach((note, k) => {
        const side = note.side ?? 'new';
        if (!inDiff(files, ref.file, side, note.lineStart, note.lineEnd)) return;
        out.push({ id: `g-${i}-${j}-${k}`, writer: 'guide', file: ref.file, side, lineStart: note.lineStart, lineEnd: note.lineEnd, text: note.text, agent });
      }),
    ),
  );
  return out;
}

/** A high-risk judgment's places on the PR's diff (the diff that was judged). Medium and low mark nothing. */
export function riskNotes(judgment: InboxPullRiskJudgment | null | undefined, files: readonly NoteFile[]): ContextNote[] {
  if (!judgment || judgment.level !== 'high') return [];
  return (judgment.where ?? [])
    .filter((place) => inDiff(files, place.file, place.side, place.lines[0], place.lines[1]))
    .map((place, i) => ({
      id: `r-${i}`,
      writer: 'risk' as const,
      file: place.file,
      side: place.side,
      lineStart: place.lines[0],
      lineEnd: place.lines[1],
      text: place.why,
      level: 'high' as const,
      ...(place.rule ? { rule: place.rule } : {}),
    }));
}

/** The parts of a thread's message `threadNotes` reads. */
export interface NoteMessage {
  id: string;
  created_at?: string;
  body?: string;
  reply_to?: string | null;
  author: { kind: string };
  guide?: { review?: unknown } | null;
}

/** The first words of what the person said, one line, for "you asked “…”". */
function firstWords(body: string | undefined, max = 60): string | undefined {
  const line = (body ?? '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith(':::') && !l.startsWith('```'));
  if (!line) return undefined;
  const chars = Array.from(line.replace(/\s+/g, ' '));
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

/**
 * The thread agent's notes that land on review `reviewId`: every `:::note` block in the agent's messages, drawn on
 * the newest review at or before its message (Show me's `reviewDrawnOn`). On this review: where its lines are in
 * the diff. On an earlier review: where those lines are now, fresh when the text is the same and stale when it
 * changed (`earlier` holds that review's files, undefined while it is read). A later review's notes, and lines not
 * found, stay in the thread only.
 */
export function threadNotes(input: {
  messages: readonly NoteMessage[];
  reviewId: string;
  files: readonly NoteFile[];
  agent: (message: NoteMessage) => string;
  round: (reviewId: string) => number;
  earlier: (reviewId: string) => readonly NoteFile[] | undefined;
}): ContextNote[] {
  const { messages, reviewId, files } = input;
  const at = messages.findIndex((m) => m.id === reviewId);
  if (at < 0) return [];
  const out: ContextNote[] = [];
  for (const message of messages) {
    if (message.author.kind !== 'agent') continue;
    const blocks = inboxNoteBlocks(message.body);
    if (blocks.length === 0) continue;
    const drawnOn = reviewDrawnOn(message.id, messages, undefined, message.created_at);
    if (!drawnOn) continue;
    const drawnAt = messages.findIndex((m) => m.id === drawnOn);
    if (drawnAt < 0 || drawnAt > at) continue;
    const asked = message.reply_to ? messages.find((m) => m.id === message.reply_to && m.author.kind === 'person') : undefined;
    blocks.forEach((block, k) => {
      const base: ContextNote = {
        id: `t-${message.id}-${k}`,
        writer: 'thread',
        file: block.file,
        side: block.side,
        lineStart: block.lineStart,
        lineEnd: block.lineEnd,
        text: block.text,
        agent: input.agent(message),
        message: message.id,
        ...(message.created_at ? { at: message.created_at } : {}),
        ...(asked ? { asked: firstWords(asked.body) } : {}),
      };
      if (drawnOn === reviewId) {
        if (inDiff(files, block.file, block.side, block.lineStart, block.lineEnd)) out.push(base);
        return;
      }
      const earlierFiles = input.earlier(drawnOn);
      if (!earlierFiles) return;
      const before = earlierFiles.find((f) => f.path === block.file);
      const now = files.find((f) => f.path === block.file);
      if (!before || !now) return;
      const was = sideLines(before.patch, block.side);
      const is = sideLines(now.patch, block.side);
      const lines: [number, number] = [block.lineStart, block.lineEnd];
      const same = anchorLines(lines, was, is);
      if (same) {
        out.push({ ...base, lineStart: same[0], lineEnd: same[1] });
        return;
      }
      const shifted = shiftLines(lines, was, is);
      if (shifted) out.push({ ...base, lineStart: shifted[0], lineEnd: shifted[1], stale: { round: input.round(drawnOn), lines } });
    });
  }
  return out;
}

/** One part of a board that points at code, as the window reads it off the drawing. */
export interface PicturePart {
  board: string;
  title: string;
  part: string;
  /** The part's words beyond its name. */
  words: string;
  /** Where the part's lines land in this review (`partLanding`), already worked out. */
  lines: [number, number];
  path: string;
  agent: string;
  /** Drawn on an earlier review whose code here changed since. */
  stale?: { round: number; lines: [number, number] };
}

/** Show me boards' parts on their lines (new side), one note per part; the same lines twice draw once. */
export function pictureNotes(parts: readonly PicturePart[], files: readonly NoteFile[]): ContextNote[] {
  const seen = new Set<string>();
  const out: ContextNote[] = [];
  parts.forEach((part, i) => {
    const key = `${part.board}\u0000${part.path}\u0000${part.lines.join('-')}\u0000${part.part}`;
    if (seen.has(key) || !inDiff(files, part.path, 'new', part.lines[0], part.lines[1])) return;
    seen.add(key);
    out.push({
      id: `p-${part.board}-${i}`,
      writer: 'picture',
      file: part.path,
      side: 'new',
      lineStart: part.lines[0],
      lineEnd: part.lines[1],
      text: part.words || part.part,
      agent: part.agent,
      picture: { board: part.board, title: part.title, part: part.part },
      ...(part.stale ? { stale: part.stale } : {}),
    });
  });
  return out;
}

/** Notes in the order the diff reads them: by file as the diff lists them, then side and line. */
export function orderNotes(notes: readonly ContextNote[], files: readonly NoteFile[]): ContextNote[] {
  const fileAt = new Map(files.map((f, i) => [f.path, i] as const));
  return [...notes].sort(
    (a, b) => (fileAt.get(a.file) ?? 0) - (fileAt.get(b.file) ?? 0) || a.lineEnd - b.lineEnd || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1),
  );
}

/** When a thread note came, as a short time: "9:41 AM" today, "Yesterday", else the date. */
export function noteTime(iso: string | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(when)) / 86_400_000);
  if (days === 0) return when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  return when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The stale line, as Show me's corner card words it. */
export function staleWords(note: ContextNote): string | null {
  if (!note.stale) return null;
  const what = note.writer === 'thread' ? 'answer' : note.writer === 'picture' ? 'picture' : 'note';
  return `The code here changed after this ${what} (${note.writer === 'picture' ? 'drawn' : 'written'} on round ${note.stale.round}, lines ${rangeWord(note.stale.lines)}).`;
}

/** What the Ask box starts with for "Ask again": the file and the lines where they are now. */
export function askAgainWords(note: ContextNote): string {
  return `${baseName(note.file)} ${note.lineStart === note.lineEnd ? 'line' : 'lines'} ${rangeWord([note.lineStart, note.lineEnd])}: `;
}

/** How many places a judgment marks in its diff: a high one's `where`, else none. */
export function riskPlaceCount(judgment: InboxPullRiskJudgment | null | undefined): number {
  return judgment?.level === 'high' ? (judgment.where?.length ?? 0) : 0;
}

/** "2 places", "1 place". */
export function placesWord(count: number): string {
  return `${count} ${count === 1 ? 'place' : 'places'}`;
}

/**
 * The PR page's "See the N places" asks the PR's diff to open at its first place. The diff is another view that
 * mounts after the click, so the ask waits here, named by the PR, until that diff takes it.
 */
let placesAsked: string | null = null;
export function askRiskPlaces(pullKey: string): void {
  placesAsked = pullKey;
}
export function takeRiskPlaces(pullKey: string): boolean {
  if (placesAsked !== pullKey) return false;
  placesAsked = null;
  return true;
}
