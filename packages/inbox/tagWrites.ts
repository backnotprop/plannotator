/**
 * The tags a thread or a project shows while its write is on its way (useThreadTagsHost.ts, useProjectTags.ts). The
 * window draws a tick at once (a patch over what the list said) and takes the patch back once the list is read again.
 *
 * - Each write takes a turn per thread or project, and only the latest one takes the patch back: with two quick
 *   ticks, the first write's list read never drops the second tick while that write is still in flight.
 * - A write held for a linked machine that is away (`InboxHeldError`, the clock toast "Waiting for …") keeps its patch,
 *   pending, as the outbox keeps the write: the tick stays until the list reads the same tags (the write landed).
 *
 * Pure: no React, no routes.
 */

/** Two tag lists that hold the same tags, in any order. */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag) => b.includes(tag));
}

export interface TagWrites {
  /** A write starts on `id`: its turn. A newer write replaces a held one. */
  start(id: string): number;
  /** The write of `turn` is the latest on `id`: it may take the patch back. */
  latest(id: string, turn: number): boolean;
  /** The write of `turn` is held, with `tags` drawn: its patch stays until the list says them. */
  hold(id: string, turn: number, tags: readonly string[]): void;
  /** The held ids whose tags the list now says (`listed`): their patches can go. */
  landed(listed: (id: string) => readonly string[] | undefined): string[];
}

export function tagWrites(): TagWrites {
  let turns = 0;
  const last = new Map<string, number>();
  const held = new Map<string, readonly string[]>();
  return {
    start(id) {
      turns += 1;
      last.set(id, turns);
      held.delete(id);
      return turns;
    },
    latest: (id, turn) => last.get(id) === turn,
    hold(id, turn, tags) {
      if (last.get(id) === turn) held.set(id, tags);
    },
    landed(listed) {
      const out: string[] = [];
      for (const [id, tags] of held) {
        const now = listed(id);
        if (now !== undefined && sameTags(now, tags)) {
          held.delete(id);
          out.push(id);
        }
      }
      return out;
    },
  };
}
