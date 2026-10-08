/**
 * Local, optimistic edits to snapshots (boxes, strokes, redactions, notes, text
 * removals) with per-snapshot undo/redo. Edits show at once and are written to
 * the hub after a short pause; while a snapshot has unsaved edits the hub's copy
 * of it is not allowed to overwrite them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@plannotator/shared/snapshots/types';
import { api } from './api';

type Marks = Pick<Snapshot, 'boxes' | 'strokes' | 'redactions'>;
type Patch = Partial<Pick<Snapshot, 'boxes' | 'strokes' | 'redactions' | 'note'>> & { text?: { include?: boolean; removedLines?: number[] } };

const SAVE_DELAY_MS = 350;

export interface SnapshotEdits {
  /** The hub's snapshots with local edits on top. */
  merged: (snapshot: Snapshot) => Snapshot;
  /** Edit a snapshot. `record` puts the previous marks on the undo stack. */
  edit: (snapshot: Snapshot, patch: Patch, record?: boolean) => void;
  undo: (snapshot: Snapshot) => void;
  redo: (snapshot: Snapshot) => void;
  /** Write every pending edit now (before a send or an ask). */
  flush: () => Promise<void>;
  /** Call with each new hub state. */
  reconcile: (snapshots: Snapshot[]) => void;
}

function sameEdits(a: Snapshot, b: Snapshot): boolean {
  const pick = (snapshot: Snapshot) => JSON.stringify([snapshot.boxes, snapshot.strokes, snapshot.redactions, snapshot.note, snapshot.text?.include, snapshot.text?.removedLines]);
  return pick(a) === pick(b);
}

export function useSnapshotEdits(): SnapshotEdits {
  const [local, setLocal] = useState<Record<string, Snapshot>>({});
  const localRef = useRef(local);
  localRef.current = local;
  const pending = useRef(new Map<string, Patch>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const history = useRef(new Map<string, { undo: Marks[]; redo: Marks[] }>());
  const inflight = useRef(new Map<string, Promise<unknown>>());

  const save = useCallback(async (id: string) => {
    timers.current.delete(id);
    const patch = pending.current.get(id);
    if (!patch) return;
    pending.current.delete(id);
    const request = api.patchSnapshot(id, patch).catch(() => undefined);
    inflight.current.set(id, request);
    await request;
    if (inflight.current.get(id) === request) inflight.current.delete(id);
  }, []);

  /** Drop local copies the hub has caught up with (and nothing is waiting to be written). */
  const reconcile = useCallback((snapshots: Snapshot[]) => {
    const settled = snapshots.filter((snapshot) => {
      const mine = localRef.current[snapshot.id];
      return mine && !pending.current.has(snapshot.id) && !inflight.current.has(snapshot.id) && sameEdits(mine, snapshot);
    });
    if (settled.length === 0) return;
    setLocal((current) => {
      const next = { ...current };
      for (const snapshot of settled) delete next[snapshot.id];
      return next;
    });
  }, []);

  const schedule = useCallback(
    (id: string, patch: Patch) => {
      pending.current.set(id, { ...pending.current.get(id), ...patch });
      const timer = timers.current.get(id);
      if (timer) clearTimeout(timer);
      timers.current.set(
        id,
        setTimeout(() => void save(id), SAVE_DELAY_MS),
      );
    },
    [save],
  );

  const merged = useCallback((snapshot: Snapshot) => localRef.current[snapshot.id] ?? local[snapshot.id] ?? snapshot, [local]);

  const apply = useCallback(
    (snapshot: Snapshot, patch: Patch) => {
      setLocal((current) => {
        const base = current[snapshot.id] ?? snapshot;
        const next: Snapshot = { ...base, ...patch, text: patch.text && base.text ? { ...base.text, ...patch.text } : base.text } as Snapshot;
        if (patch.boxes || patch.strokes || patch.redactions) {
          delete next.agent;
          next.crops = {};
        }
        return { ...current, [snapshot.id]: next };
      });
      schedule(snapshot.id, patch);
    },
    [schedule],
  );

  const edit = useCallback(
    (snapshot: Snapshot, patch: Patch, record = true) => {
      if (record && (patch.boxes || patch.strokes || patch.redactions)) {
        const base = localRef.current[snapshot.id] ?? snapshot;
        const entry = history.current.get(snapshot.id) ?? { undo: [], redo: [] };
        entry.undo.push({ boxes: base.boxes, strokes: base.strokes, redactions: base.redactions });
        if (entry.undo.length > 100) entry.undo.shift();
        entry.redo = [];
        history.current.set(snapshot.id, entry);
      }
      apply(snapshot, patch);
    },
    [apply],
  );

  const step = useCallback(
    (snapshot: Snapshot, from: 'undo' | 'redo') => {
      const entry = history.current.get(snapshot.id);
      const marks = entry?.[from].pop();
      if (!entry || !marks) return;
      const base = localRef.current[snapshot.id] ?? snapshot;
      entry[from === 'undo' ? 'redo' : 'undo'].push({ boxes: base.boxes, strokes: base.strokes, redactions: base.redactions });
      apply(snapshot, marks);
    },
    [apply],
  );

  const flush = useCallback(async () => {
    for (const [id, timer] of timers.current) {
      clearTimeout(timer);
      timers.current.delete(id);
      await save(id);
    }
    await Promise.all(inflight.current.values());
  }, [save]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  return { merged, edit, undo: (snapshot) => step(snapshot, 'undo'), redo: (snapshot) => step(snapshot, 'redo'), flush, reconcile };
}
