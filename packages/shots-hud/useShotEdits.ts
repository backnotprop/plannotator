/**
 * Local, optimistic edits to shots (boxes, strokes, redactions, notes, text
 * removals) with per-shot undo/redo. Edits show at once and are written to
 * the hub after a short pause; while a shot has unsaved edits the hub's copy
 * of it is not allowed to overwrite them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Shot } from '@plannotator/shared/shots/types';
import { api } from './api';

type Marks = Pick<Shot, 'boxes' | 'strokes' | 'redactions'>;
type Patch = Partial<Pick<Shot, 'boxes' | 'strokes' | 'redactions' | 'note'>> & { text?: { include?: boolean; removedLines?: number[] } };

const SAVE_DELAY_MS = 350;

export interface ShotEdits {
  /** The hub's shots with local edits on top. */
  merged: (shot: Shot) => Shot;
  /** Edit a shot. `record` puts the previous marks on the undo stack. */
  edit: (shot: Shot, patch: Patch, record?: boolean) => void;
  undo: (shot: Shot) => void;
  redo: (shot: Shot) => void;
  /** Write every pending edit now (before a send or an ask). */
  flush: () => Promise<void>;
  /** Call with each new hub state. */
  reconcile: (shots: Shot[]) => void;
}

function sameEdits(a: Shot, b: Shot): boolean {
  const pick = (shot: Shot) => JSON.stringify([shot.boxes, shot.strokes, shot.redactions, shot.note, shot.text?.include, shot.text?.removedLines]);
  return pick(a) === pick(b);
}

export function useShotEdits(): ShotEdits {
  const [local, setLocal] = useState<Record<string, Shot>>({});
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
    const request = api.patchShot(id, patch).catch(() => undefined);
    inflight.current.set(id, request);
    await request;
    if (inflight.current.get(id) === request) inflight.current.delete(id);
  }, []);

  /** Drop local copies the hub has caught up with (and nothing is waiting to be written). */
  const reconcile = useCallback((shots: Shot[]) => {
    const settled = shots.filter((shot) => {
      const mine = localRef.current[shot.id];
      return mine && !pending.current.has(shot.id) && !inflight.current.has(shot.id) && sameEdits(mine, shot);
    });
    if (settled.length === 0) return;
    setLocal((current) => {
      const next = { ...current };
      for (const shot of settled) delete next[shot.id];
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

  const merged = useCallback((shot: Shot) => localRef.current[shot.id] ?? local[shot.id] ?? shot, [local]);

  const apply = useCallback(
    (shot: Shot, patch: Patch) => {
      setLocal((current) => {
        const base = current[shot.id] ?? shot;
        const next: Shot = { ...base, ...patch, text: patch.text && base.text ? { ...base.text, ...patch.text } : base.text } as Shot;
        if (patch.boxes || patch.strokes || patch.redactions) {
          delete next.agent;
          next.crops = {};
        }
        return { ...current, [shot.id]: next };
      });
      schedule(shot.id, patch);
    },
    [schedule],
  );

  const edit = useCallback(
    (shot: Shot, patch: Patch, record = true) => {
      if (record && (patch.boxes || patch.strokes || patch.redactions)) {
        const base = localRef.current[shot.id] ?? shot;
        const entry = history.current.get(shot.id) ?? { undo: [], redo: [] };
        entry.undo.push({ boxes: base.boxes, strokes: base.strokes, redactions: base.redactions });
        if (entry.undo.length > 100) entry.undo.shift();
        entry.redo = [];
        history.current.set(shot.id, entry);
      }
      apply(shot, patch);
    },
    [apply],
  );

  const step = useCallback(
    (shot: Shot, from: 'undo' | 'redo') => {
      const entry = history.current.get(shot.id);
      const marks = entry?.[from].pop();
      if (!entry || !marks) return;
      const base = localRef.current[shot.id] ?? shot;
      entry[from === 'undo' ? 'redo' : 'undo'].push({ boxes: base.boxes, strokes: base.strokes, redactions: base.redactions });
      apply(shot, marks);
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

  return { merged, edit, undo: (shot) => step(shot, 'undo'), redo: (shot) => step(shot, 'redo'), flush, reconcile };
}
