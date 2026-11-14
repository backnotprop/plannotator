import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { RowPatch } from '../../rowActions';
import { inboxKeys } from '../keys';

interface RowDraw {
  threadId: string;
  patch?: RowPatch;
  pin?: boolean;
  until: Promise<void>;
}

export interface RowDrawing {
  done: () => void;
  failed: () => void;
  settled: Promise<void>;
}

export interface RowWrites {
  draw: (threadId: string, what: { patch: RowPatch } | { pin: boolean }) => RowDrawing;
  patches: ReadonlyMap<string, RowPatch>;
  pins: ReadonlyMap<string, boolean>;
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
