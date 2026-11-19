/**
 * The tags a thread or a project shows while its write is on its way (useThreadTagsHost.ts, useProjectTags.ts). The
 * window draws a tick at once (a patch over what the list said) and takes the patch back once the list is read again.
 *
 * Each write takes a turn per thread or project, and only the latest one takes the patch back: with two quick ticks,
 * the first write's list read never drops the second tick while that write is still in flight. A write held for a
 * linked machine that is away draws nothing until it lands, as before (the clock toast says it waits).
 *
 * Pure: no React, no routes.
 */

export interface TagWrites {
  /** A write starts on `id`: its turn. */
  start(id: string): number;
  /** The write of `turn` is the latest on `id`: it may take the patch back. */
  latest(id: string, turn: number): boolean;
}

export function tagWrites(): TagWrites {
  let turns = 0;
  const last = new Map<string, number>();
  return {
    start(id) {
      turns += 1;
      last.set(id, turns);
      return turns;
    },
    latest: (id, turn) => last.get(id) === turn,
  };
}
