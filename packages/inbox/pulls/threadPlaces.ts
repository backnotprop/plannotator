/**
 * Where other people's threads go on the PR page's diff (approval inbox-pr-page, q-530b62e0 and q-7d0a1587): each on
 * the line it is about when this diff shows that line; one whose line this diff does not show (a push moved past it,
 * it is on the whole file, or the whole stack's diff starts lower) at the top of its file, saying why. A thread on a
 * file this diff does not change is in the Details panel only. Nothing here is cut at a count: every thread is placed,
 * and every open one is counted on its file's row.
 */
import type { InboxPullThread } from '@plannotator/core/inbox-types';

/** Why a thread sits where it does: on its line, or at the top of its file because its line is not drawn. */
export type ThreadWhere = 'line' | 'outdated' | 'file' | 'elsewhere';

export interface PlacedThread {
  thread: InboxPullThread;
  /** The line it is drawn under, on `side`. */
  line: number;
  side: 'old' | 'new';
  where: ThreadWhere;
}

/** The lines one file's patch draws on each side, and the first it draws (where a thread with no line here goes). */
export function patchLines(patch: string): { old: Set<number>; new: Set<number>; first: { line: number; side: 'old' | 'new' } | null } {
  const out = { old: new Set<number>(), new: new Set<number>(), first: null as { line: number; side: 'old' | 'new' } | null };
  let oldAt = 0;
  let newAt = 0;
  let inHunk = false;
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
      oldAt++;
    } else if (row[0] === ' ') {
      out.new.add(newAt);
      out.old.add(oldAt);
      out.first ??= { line: newAt, side: 'new' };
      newAt++;
      oldAt++;
    }
  }
  // A deleted file draws only removed lines.
  if (!out.first && out.old.size > 0) out.first = { line: Math.min(...out.old), side: 'old' };
  return out;
}

/**
 * Every thread placed on this diff, in the forge's order, and each file's open (unresolved) threads. `scope` is the
 * diff on screen: a whole stack's diff runs from the stack's base, so a thread on a removed line (this PR's base) has
 * no line there.
 */
export function placeThreads(
  threads: readonly InboxPullThread[],
  files: readonly { path: string; patch: string }[],
  scope: 'layer' | 'stack',
): { placed: PlacedThread[]; open: Map<string, number> } {
  // A path changed twice is drawn once, as its last part (reviewFiles).
  const byPath = new Map(files.map((file) => [file.path, file.patch]));
  const lines = new Map<string, ReturnType<typeof patchLines>>();
  const placed: PlacedThread[] = [];
  const open = new Map<string, number>();
  for (const thread of threads) {
    const patch = byPath.get(thread.file);
    if (patch === undefined || thread.comments.length === 0) continue;
    let drawn = lines.get(thread.file);
    if (!drawn) lines.set(thread.file, (drawn = patchLines(patch)));
    if (!thread.resolved) open.set(thread.file, (open.get(thread.file) ?? 0) + 1);
    const sideLines = thread.side === 'old' ? drawn.old : drawn.new;
    const onLine = thread.line !== null && sideLines.has(thread.line) && !(scope === 'stack' && thread.side === 'old');
    if (onLine) {
      placed.push({ thread, line: thread.line!, side: thread.side, where: 'line' });
      continue;
    }
    if (!drawn.first) continue;
    const where: ThreadWhere = thread.outdated ? 'outdated' : thread.line === null ? 'file' : 'elsewhere';
    placed.push({ thread, line: drawn.first.line, side: drawn.first.side, where });
  }
  return { placed, open };
}

/**
 * Why a thread starts as one line, or null when it starts open. Resolved, or only bots speaking: one line that says
 * so. A push never folds a thread (an outdated one is open), and no count of threads folds them.
 */
export function foldedWhy(thread: InboxPullThread): 'resolved' | 'bot' | null {
  if (thread.resolved) return 'resolved';
  if (thread.comments.every((comment) => comment.bot)) return 'bot';
  return null;
}

/** A thread longer than this shows its first and last comments, and how many between. */
export const THREAD_SHOWN_MAX = 3;

/** The comments an open thread shows, and how many it leaves between its first and its last. */
export function shownComments<T>(comments: readonly T[], whole: boolean): { shown: T[]; between: number } {
  if (whole || comments.length <= THREAD_SHOWN_MAX) return { shown: [...comments], between: 0 };
  return { shown: [comments[0]!, comments[comments.length - 1]!], between: comments.length - 2 };
}

/** A short text's hash, for a thread's drawing key: its words change, it is drawn again. */
export function wordsHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** What a placed thread draws, as a key: the same key, the line is left as it is. */
export function threadKey(placed: PlacedThread): string {
  const { thread } = placed;
  return [
    placed.where,
    thread.resolved ? 'r' : '',
    thread.outdated ? 'o' : '',
    thread.start_line ?? '',
    thread.line ?? '',
    ...thread.comments.map((c) => `${c.id}:${c.author}:${c.at}:${c.hidden ?? '-'}:${wordsHash(c.body)}`),
  ].join('|');
}
