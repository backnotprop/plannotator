import type { InboxPullThread } from '@plannotator/core/inbox-types';

export type ThreadWhere = 'line' | 'outdated' | 'elsewhere';

export interface PlacedThread {
  thread: InboxPullThread;
  line: number;
  side: 'old' | 'new';
  where: ThreadWhere;
}

export interface FileThreadPlace {
  thread: InboxPullThread;
  side: 'old' | 'new';
  lines: boolean;
}

export function patchLines(patch: string): { old: Set<number>; new: Set<number>; first: { line: number; side: 'old' | 'new' } | null } {
  const out = { old: new Set<number>(), new: new Set<number>(), first: null as { line: number; side: 'old' | 'new' } | null };
  let oldAt = 0;
  let newAt = 0;
  let inHunk = false;
  let firstOld: number | null = null;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) {
      oldAt = Number(hunk[1]);
      newAt = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (row.startsWith('diff --git')) {
      inHunk = false;
    } else if (row[0] === '+') {
      out.new.add(newAt);
      out.first ??= { line: newAt, side: 'new' };
      newAt++;
    } else if (row[0] === '-') {
      out.old.add(oldAt);
      firstOld ??= oldAt;
      oldAt++;
    } else if (row[0] === ' ') {
      out.new.add(newAt);
      out.old.add(oldAt);
      out.first ??= { line: newAt, side: 'new' };
      newAt++;
      oldAt++;
    }
  }
  if (!out.first && firstOld !== null) out.first = { line: firstOld, side: 'old' };
  return out;
}

export function placeThreads(
  threads: readonly InboxPullThread[],
  files: readonly { path: string; patch: string }[],
  scope: 'layer' | 'stack',
): { placed: PlacedThread[]; onFiles: FileThreadPlace[]; open: Map<string, number> } {
  const byPath = new Map(files.map((file) => [file.path, file.patch]));
  const lines = new Map<string, ReturnType<typeof patchLines>>();
  const placed: PlacedThread[] = [];
  const onFiles: FileThreadPlace[] = [];
  const open = new Map<string, number>();
  for (const thread of threads) {
    const patch = byPath.get(thread.file);
    if (patch === undefined || thread.comments.length === 0) continue;
    let drawn = lines.get(thread.file);
    if (!drawn) lines.set(thread.file, (drawn = patchLines(patch)));
    const count = () => {
      if (!thread.resolved) open.set(thread.file, (open.get(thread.file) ?? 0) + 1);
    };
    if (thread.line === null && !thread.outdated) {
      onFiles.push({ thread, side: drawn.first?.side ?? 'new', lines: drawn.first !== null });
      count();
      continue;
    }
    const sideLines = thread.side === 'old' ? drawn.old : drawn.new;
    const onLine = thread.line !== null && sideLines.has(thread.line) && !(scope === 'stack' && thread.side === 'old');
    if (onLine) {
      placed.push({ thread, line: thread.line!, side: thread.side, where: 'line' });
      count();
      continue;
    }
    if (!drawn.first) continue;
    const where: ThreadWhere = thread.outdated ? 'outdated' : 'elsewhere';
    placed.push({ thread, line: drawn.first.line, side: drawn.first.side, where });
    count();
  }
  const started = ({ thread }: FileThreadPlace) => {
    const at = Date.parse(thread.comments[0]?.at ?? '');
    return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
  };
  onFiles.sort((a, b) => started(a) - started(b));
  return { placed, onFiles, open };
}

export function foldedWhy(thread: InboxPullThread): 'resolved' | 'bot' | null {
  if (thread.resolved) return 'resolved';
  if (thread.comments.every((comment) => comment.bot)) return 'bot';
  return null;
}

export const THREAD_SHOWN_MAX = 3;

export function shownComments<T>(comments: readonly T[], whole: boolean): { shown: T[]; between: number } {
  if (whole || comments.length <= THREAD_SHOWN_MAX) return { shown: [...comments], between: 0 };
  return { shown: [comments[0]!, comments[comments.length - 1]!], between: comments.length - 2 };
}

export function wordsHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export function threadKey(placed: PlacedThread): string {
  return keyOf(placed.where, placed.thread);
}

export function fileThreadKey(thread: InboxPullThread): string {
  return keyOf('file', thread);
}

function keyOf(where: ThreadWhere | 'file', thread: InboxPullThread): string {
  return [
    where,
    thread.resolved ? 'r' : '',
    thread.outdated ? 'o' : '',
    thread.start_line ?? '',
    thread.line ?? '',
    ...thread.comments.map((c) => `${c.id}:${c.author}:${c.at}:${c.hidden ?? '-'}:${wordsHash(c.body)}`),
  ].join('|');
}
