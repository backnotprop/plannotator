/**
 * Mark read, Archive and Star, drawn the moment they are pressed (rowActions.ts says what each draws). Each press is
 * a mutation that stays pending while its write and the list read after it are out: the pending mutations are the
 * drawing (`useRowWrites().patches` and `.pins`), so a write that fails takes its drawing away by itself, and one
 * that lands gives way to the server's row when that read lands. The writes themselves stay where they were (App's
 * `markRead`, `archive`, `setPin`, with their own requests and errors); this holds only what is drawn meanwhile.
 */
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { RowPatch } from '../../rowActions';
import { inboxKeys } from '../keys';

interface RowDraw {
  threadId: string;
  /** The row as the write makes it (Mark read, Archive). */
  patch?: RowPatch;
  /** The star as the write makes it. */
  pin?: boolean;
  /** Settles when the drawing gives way: the server's row is on screen, or the write failed. */
  until: Promise<void>;
}

/** One drawing on its way: `done` once the server's row is drawn, `failed` to take it back (the write was refused). */
export interface RowDrawing {
  done: () => void;
  failed: () => void;
  /** Settles with the drawing (either way); never rejects. */
  settled: Promise<void>;
}

export interface RowWrites {
  draw: (threadId: string, what: { patch: RowPatch } | { pin: boolean }) => RowDrawing;
  /** Each thread's row as drawn by the writes on their way. */
  patches: ReadonlyMap<string, RowPatch>;
  /** Each thread's star as drawn by the writes on their way. */
  pins: ReadonlyMap<string, boolean>;
  /** The Mark read on its way for the thread, if any: Move back waits for it, so the two land in order. */
  pendingRead: (threadId: string) => Promise<void> | undefined;
}

const DONE = Promise.resolve();

export function useRowWrites(): RowWrites {
  const client = useQueryClient();
  const { mutate } = useMutation<void, Error, RowDraw>({ mutationKey: inboxKeys.rowWrites(), mutationFn: (draw) => draw.until });
  const drawn = useMutationState({ filters: { mutationKey: inboxKeys.rowWrites(), status: 'pending' }, select: (m) => m.state.variables as RowDraw });
  const patches = useMemo(() => {
    const out = new Map<string, RowPatch>();
    for (const d of drawn) if (d.patch) out.set(d.threadId, { ...out.get(d.threadId), ...d.patch });
    return out;
  }, [drawn]);
  const pins = useMemo(() => new Map(drawn.flatMap((d) => (d.pin === undefined ? [] : [[d.threadId, d.pin] as const]))), [drawn]);
  return useMemo(
    () => ({
      draw: (threadId, what) => {
        let done = () => {};
        let failed = () => {};
        const until = new Promise<void>((resolve, reject) => {
          done = () => resolve();
          failed = () => reject(new Error('row write refused'));
        });
        mutate({ threadId, ...what, until });
        return { done, failed, settled: until.catch(() => {}) };
      },
      patches,
      pins,
      pendingRead: (threadId) => {
        const out = client
          .getMutationCache()
          .findAll({ mutationKey: inboxKeys.rowWrites(), status: 'pending', predicate: (m) => (m.state.variables as RowDraw | undefined)?.threadId === threadId && (m.state.variables as RowDraw).patch?.read_at !== undefined });
        return out.length === 0 ? undefined : Promise.all(out.map((m) => (m.state.variables as RowDraw).until.catch(() => {}))).then(() => DONE);
      },
    }),
    [client, mutate, patches, pins],
  );
}
