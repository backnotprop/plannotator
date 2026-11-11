import { diffHunkLines, isLineRangeInPatch } from '@plannotator/core/diff-files';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
import { inboxNoteBlocks, type InboxNoteSide } from '@plannotator/core/inbox-context-notes';
import type { InboxPullRiskJudgment } from '@plannotator/core/inbox-types';
import { agentName } from '../format';
import { anchorLines, shiftLines, reviewDrawnOn } from '../review-drawing/showMeModel';

export type ContextNoteWriter = 'guide' | 'risk' | 'thread' | 'picture';

export interface ContextNote {
  id: string;
  writer: ContextNoteWriter;
  file: string;
  side: InboxNoteSide;
  lineStart: number;
  lineEnd: number;
  text: string;
  agent?: string;
  level?: 'high';
  rule?: string;
  asked?: string;
  at?: string;
  message?: string;
  picture?: { board: string; title: string; part: string };
  stale?: { round: number; lines: [number, number] };
}

export interface NoteFile {
  path: string;
  patch: string;
}

export function writerWord(note: Pick<ContextNote, 'writer' | 'agent'>): string {
  if (note.writer === 'thread') return note.agent || agentName(null);
  return note.writer === 'guide' ? 'Review note' : note.writer === 'risk' ? 'Risk' : 'Picture';
}

export function rangeWord(lines: readonly [number, number]): string {
  return lines[0] === lines[1] ? `${lines[0]}` : `${lines[0]}–${lines[1]}`;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

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

function inDiff(files: readonly NoteFile[], file: string, side: InboxNoteSide, start: number, end: number): boolean {
  const patch = files.find((f) => f.path === file)?.patch;
  return patch !== undefined && isLineRangeInPatch(patch, start, end, side);
}

export function noteHolds(note: Pick<ContextNote, 'file' | 'side' | 'lineStart' | 'lineEnd'>, at: { path: string; line: number; side: InboxNoteSide }): boolean {
  return note.file === at.path && note.side === at.side && at.line >= note.lineStart && at.line <= note.lineEnd;
}

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

export interface NoteMessage {
  id: string;
  created_at?: string;
  body?: string;
  reply_to?: string | null;
  author: { kind: string };
  guide?: { review?: unknown } | null;
}

function firstWords(body: string | undefined, max = 60): string | undefined {
  const line = (body ?? '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith(':::') && !l.startsWith('```'));
  if (!line) return undefined;
  const chars = Array.from(line.replace(/\s+/g, ' '));
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

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

export function noteReviews(messages: readonly NoteMessage[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!messages.some((m) => m.guide?.review)) return out;
  for (const m of messages) {
    if (m.author.kind === 'agent' && m.body?.includes(':::note')) out.set(m.id, reviewDrawnOn(m.id, messages, undefined, m.created_at));
  }
  return out;
}

export interface PicturePart {
  board: string;
  title: string;
  part: string;
  words: string;
  lines: [number, number];
  path: string;
  agent: string;
  stale?: { round: number; lines: [number, number] };
}

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

export function orderNotes(notes: readonly ContextNote[], files: readonly NoteFile[]): ContextNote[] {
  const fileAt = new Map(files.map((f, i) => [f.path, i] as const));
  return [...notes].sort(
    (a, b) => (fileAt.get(a.file) ?? 0) - (fileAt.get(b.file) ?? 0) || a.lineEnd - b.lineEnd || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1),
  );
}

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

export function staleWords(note: ContextNote): string | null {
  if (!note.stale) return null;
  const what = note.writer === 'thread' ? 'answer' : note.writer === 'picture' ? 'picture' : 'note';
  return `The code here changed after this ${what} (${note.writer === 'picture' ? 'drawn' : 'written'} on round ${note.stale.round}, lines ${rangeWord(note.stale.lines)}).`;
}

export function askAgainWords(note: ContextNote): string {
  return `${baseName(note.file)} ${note.lineStart === note.lineEnd ? 'line' : 'lines'} ${rangeWord([note.lineStart, note.lineEnd])}: `;
}

export function riskPlaceCount(judgment: InboxPullRiskJudgment | null | undefined): number {
  return judgment?.level === 'high' ? (judgment.where?.length ?? 0) : 0;
}

export function placesWord(count: number): string {
  return `${count} ${count === 1 ? 'place' : 'places'}`;
}

export const RISK_PLACES_ASK_MS = 10_000;

let placesAsked: { key: string; at: number } | null = null;
export function askRiskPlaces(pullKey: string, now = Date.now()): void {
  placesAsked = { key: pullKey, at: now };
}
export function takeRiskPlaces(pullKey: string, now = Date.now()): boolean {
  const asked = placesAsked;
  placesAsked = null;
  return !!asked && asked.key === pullKey && now - asked.at >= 0 && now - asked.at <= RISK_PLACES_ASK_MS;
}
