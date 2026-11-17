/**
 * One thread's canvas as the window holds it: read on open and on every `event: canvas` that names it, saved by itself
 * as the person draws (each save names the `rev` it started from; a stale one reads the canvas again). `sceneKey`
 * changes only when the scene changed somewhere else (the agent's new version, another window), so the open canvas
 * updates in place and never redraws over the person's own strokes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasElement } from '@plannotator/core/canvas-scene';
import { InboxApiError } from '../apiError';
import { canvasApi, type CanvasFileRef, type CanvasWire } from './client';
import { subscribeCanvasFrames } from './frames';
import { changedPartIds, keepCanvasPicture } from './layout';
import { partOf } from '@plannotator/core/canvas-scene';

const SAVE_AFTER_MS = 500;
const PICTURE_AFTER_MS = 2500;

export interface ThreadCanvasChange {
  elements: CanvasElement[];
  files: Record<string, CanvasFileRef>;
  uploads: Record<string, { mimeType: string; dataURL: string }>;
}

export interface ThreadCanvas {
  wire: CanvasWire | null;
  /** Changes when the scene changed somewhere else. */
  sceneKey: string;
  /** The agent's latest version arrived while the canvas was open: "<n> parts" for the quiet line. */
  agentChange: { version: number; changed: number; ids: string[]; at: number } | null;
  save: (change: ThreadCanvasChange) => void;
  failed: boolean;
}

export function useThreadCanvas(threadId: string | null, on: boolean): ThreadCanvas {
  const [wire, setWire] = useState<CanvasWire | null>(null);
  const [sceneKey, setSceneKey] = useState('0');
  const [agentChange, setAgentChange] = useState<ThreadCanvas['agentChange']>(null);
  const [failed, setFailed] = useState(false);
  const wireRef = useRef<CanvasWire | null>(null);
  const own = useRef(new Set<number>());
  const pending = useRef<ThreadCanvasChange | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pictureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);

  /** The agent's latest version this window has drawn laid out, and its scene: what the next one is compared with. */
  const laidOut = useRef<{ version: number; elements: CanvasElement[] } | null>(null);
  const take = useCallback((next: CanvasWire) => {
    const was = wireRef.current;
    wireRef.current = next;
    setWire(next);
    if (!was || (next.rev !== was.rev && !own.current.has(next.rev))) setSceneKey(String(next.rev));
    // The agent's new version, once laid out: one quiet line naming how many parts it changed (not on the first read).
    if (next.layout?.state === 'done' && next.layout.version === next.agent_version) {
      const before = laidOut.current;
      laidOut.current = { version: next.agent_version, elements: next.scene?.elements ?? [] };
      if (before && next.agent_version > before.version) {
        const parts = new Set(changedPartIds(before.elements, next.scene?.elements ?? []));
        const ids = (next.scene?.elements ?? []).filter((e) => !e.isDeleted && parts.has(partOf(e) ?? '')).map((e) => e.id);
        setAgentChange({ version: next.agent_version, changed: parts.size, ids, at: Date.now() });
      }
    }
  }, []);

  const load = useCallback(async () => {
    if (!threadId || !on) return;
    try {
      const next = await canvasApi.read(threadId);
      // A save on its way names the rev it started from: it lands first, then this read is taken.
      if (saving.current || pending.current) return;
      setFailed(false);
      take(next);
    } catch {
      setFailed(true);
    }
  }, [threadId, on, take]);

  useEffect(() => {
    wireRef.current = null;
    laidOut.current = null;
    own.current.clear();
    setWire(null);
    setAgentChange(null);
    if (!threadId || !on) return;
    void load();
    return subscribeCanvasFrames((ids) => {
      if (ids.length === 0 || ids.includes(threadId)) void load();
    });
  }, [threadId, on, load]);

  const flush = useCallback(async () => {
    timer.current = null;
    const change = pending.current;
    const current = wireRef.current;
    if (!change || !current || !threadId || saving.current) return;
    pending.current = null;
    saving.current = true;
    try {
      const uploads = Object.fromEntries(Object.entries(change.uploads).map(([id, u]) => [id, { dataURL: u.dataURL }]));
      const saved = await canvasApi.save(threadId, { base: current.rev, elements: change.elements, files: change.files, uploads });
      own.current.add(saved.rev);
      const next: CanvasWire = { ...current, rev: saved.rev, version: saved.version, marks: saved.marks, scene: { elements: change.elements, files: change.files }, deleted: [...current.deleted, ...saved.deleted] };
      wireRef.current = next;
      setWire(next);
      // The picture the agent reads with `canvas read --png`, once the person pauses.
      if (pictureTimer.current) clearTimeout(pictureTimer.current);
      pictureTimer.current = setTimeout(() => void keepCanvasPicture(threadId, saved.rev, change.elements, change.files).catch(() => {}), PICTURE_AFTER_MS);
    } catch (cause) {
      // Stale (the agent's new version landed meanwhile): read it again; the canvas updates in place.
      if (cause instanceof InboxApiError && cause.status === 409) {
        saving.current = false;
        await load();
        return;
      }
      setFailed(true);
    } finally {
      saving.current = false;
    }
    if (pending.current) timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
  }, [threadId, load]);

  const save = useCallback(
    (change: ThreadCanvasChange) => {
      const earlier = pending.current;
      pending.current = { ...change, uploads: { ...(earlier?.uploads ?? {}), ...change.uploads } };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
    },
    [flush],
  );

  // Leaving the thread saves what is waiting at once.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    },
    [flush],
  );

  return { wire, sceneKey, agentChange, save, failed };
}
