/**
 * One thread's canvas as the window holds it: read on open and on every `event: canvas` that names it, saved by itself
 * as the person draws. Each save names the `rev` it started from.
 *
 * The canvas can change somewhere else while the person draws (the agent's new version, its layout, another
 * window). Nothing the person did is lost (rebase.ts):
 * - a save refused as stale reads the canvas again and saves the person's edits again on the newer scene;
 * - every save carries the newest scene this window knows, with the person's edits on top;
 * - the open canvas takes a scene from elsewhere only once the person is idle: no stroke, drag or text edit going
 *   on (activity.ts) and nothing drawn for the save delay. Until then it waits.
 *
 * `sceneKey` changes only when the open canvas is given a new scene, so it updates in place and never redraws over
 * the person's own strokes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasElement } from '@plannotator/core/canvas-scene';
import { partOf } from '@plannotator/core/canvas-scene';
import { InboxApiError } from '../apiError';
import { trackCanvasActivity, type CanvasActivity } from './activity';
import { canvasApi, type CanvasFileRef, type CanvasWire } from './client';
import { subscribeCanvasFrames } from './frames';
import { changedPartIds, keepCanvasPicture } from './layout';
import { rebaseScene, sameScene } from './rebase';

const SAVE_AFTER_MS = 500;
const PICTURE_AFTER_MS = 2500;
/** A save that failed (not stale): tried again after this. */
const RETRY_AFTER_MS = 3000;
/** Stale saves in a row before the window gives up for now (the next change tries again). */
const MAX_STALE_IN_A_ROW = 4;

export interface ThreadCanvasChange {
  elements: CanvasElement[];
  files: Record<string, CanvasFileRef>;
  uploads: Record<string, { mimeType: string; dataURL: string }>;
}

export interface ThreadCanvas {
  wire: CanvasWire | null;
  /** Changes when the open canvas is given a new scene (from somewhere else). */
  sceneKey: string;
  /** The agent's latest version arrived while the canvas was open: "<n> parts" for the quiet line. */
  agentChange: { version: number; changed: number; ids: string[]; at: number } | null;
  save: (change: ThreadCanvasChange) => void;
  failed: boolean;
}

const filesFor = (elements: readonly CanvasElement[], ...sources: Record<string, CanvasFileRef>[]): Record<string, CanvasFileRef> => {
  const all = Object.assign({}, ...sources) as Record<string, CanvasFileRef>;
  const out: Record<string, CanvasFileRef> = {};
  for (const e of elements) if (e.type === 'image' && e.fileId && all[e.fileId]) out[e.fileId] = all[e.fileId]!;
  return out;
};

const joinChanges = (older: ThreadCanvasChange | null, newer: ThreadCanvasChange | null): ThreadCanvasChange | null =>
  !older ? newer : !newer ? older : { elements: newer.elements, files: { ...older.files, ...newer.files }, uploads: { ...older.uploads, ...newer.uploads } };

export function useThreadCanvas(threadId: string | null, on: boolean): ThreadCanvas {
  const [wire, setWire] = useState<CanvasWire | null>(null);
  const [sceneKey, setSceneKey] = useState('0');
  const [agentChange, setAgentChange] = useState<ThreadCanvas['agentChange']>(null);
  const [failed, setFailed] = useState(false);
  /** The newest scene this window knows the server holds: every save names its rev. */
  const wireRef = useRef<CanvasWire | null>(null);
  /** The scene the open canvas was last given, or last saved from: what the person's edits are measured against. */
  const shown = useRef<CanvasElement[]>([]);
  /** What the open canvas holds now (its latest change), or what it was given. */
  const board = useRef<CanvasElement[]>([]);
  /** The open canvas lacks a scene the server holds: given to it once the person is idle. */
  const behind = useRef(false);
  const own = useRef(new Set<number>());
  const pending = useRef<ThreadCanvasChange | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pictureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The thread whose save is on its way, if any. */
  const saving = useRef<string | null>(null);
  /** A frame arrived while a save was on its way: read again once it lands. */
  const missed = useRef(false);
  const lastLocal = useRef(0);
  const staleInARow = useRef(0);
  const keys = useRef(0);
  const activity = useRef<CanvasActivity | null>(null);
  /** The thread this hook holds now: an answer for another one is dropped. */
  const current = useRef<string | null>(null);

  /** The agent's latest version this window has drawn laid out, and its scene: what the next one is compared with. */
  const laidOut = useRef<{ version: number; elements: CanvasElement[] } | null>(null);

  const busy = useCallback(
    () => !!pending.current || saving.current !== null || !!timer.current || Date.now() - lastLocal.current < SAVE_AFTER_MS || (activity.current?.busy() ?? false),
    [],
  );

  /** Give the open canvas the newest scene, the person's edits kept on top. */
  const give = useCallback(() => {
    const now = wireRef.current;
    if (!now) return;
    const elements = rebaseScene(shown.current, board.current, now.scene?.elements ?? []);
    shown.current = elements;
    board.current = elements;
    behind.current = false;
    setWire({ ...now, scene: { elements, files: now.scene?.files ?? {} } });
    setSceneKey(`${now.rev}.${++keys.current}`);
  }, []);

  const whenIdle = useCallback(() => {
    if (idleTimer.current) return;
    const check = () => {
      idleTimer.current = null;
      if (!behind.current) return;
      if (busy()) idleTimer.current = setTimeout(check, SAVE_AFTER_MS);
      else give();
    };
    idleTimer.current = setTimeout(check, SAVE_AFTER_MS);
  }, [busy, give]);

  /** A scene read from the server. */
  const take = useCallback(
    (next: CanvasWire) => {
      const was = wireRef.current;
      wireRef.current = next;
      if (!was) {
        shown.current = next.scene?.elements ?? [];
        board.current = shown.current;
        setWire(next);
        setSceneKey(`${next.rev}.${++keys.current}`);
      } else if (next.rev === was.rev || own.current.has(next.rev)) {
        // This window's own save: the open canvas already holds it.
        setWire({ ...next, scene: { elements: rebaseScene(shown.current, board.current, next.scene?.elements ?? []), files: next.scene?.files ?? {} } });
      } else {
        behind.current = true;
        // The newest scene for anything that reads `wire` (cards, a canvas opened later), the person's edits on top.
        setWire({ ...next, scene: { elements: rebaseScene(shown.current, board.current, next.scene?.elements ?? []), files: next.scene?.files ?? {} } });
        if (busy()) whenIdle();
        else give();
      }
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
    },
    [busy, give, whenIdle],
  );

  const load = useCallback(async () => {
    if (!threadId || !on) return;
    // A save on its way names the rev it started from: it lands first, then the canvas is read.
    if (pending.current || saving.current === threadId) {
      missed.current = true;
      return;
    }
    try {
      const next = await canvasApi.read(threadId);
      if (current.current !== threadId) return;
      if (pending.current || saving.current === threadId) {
        missed.current = true;
        return;
      }
      setFailed(false);
      take(next);
    } catch {
      if (current.current === threadId) setFailed(true);
    }
  }, [threadId, on, take]);

  /** Save what is waiting, for the thread this hook holds at the moment it is called (leaving a thread saves first). */
  const flush = useCallback(async () => {
    timer.current = null;
    const threadId = current.current;
    const change = pending.current;
    const base = wireRef.current;
    if (!change || !base || !threadId || saving.current !== null) return;
    pending.current = null;
    saving.current = threadId;
    // The newest scene this window knows, with the person's edits on top.
    const elements = rebaseScene(shown.current, change.elements, base.scene?.elements ?? []);
    const files = filesFor(elements, base.scene?.files ?? {}, change.files);
    let again = 0;
    try {
      const uploads = Object.fromEntries(Object.entries(change.uploads).map(([id, u]) => [id, { dataURL: u.dataURL }]));
      const saved = await canvasApi.save(threadId, { base: base.rev, elements, files, uploads });
      if (current.current !== threadId) return;
      staleInARow.current = 0;
      own.current.add(saved.rev);
      shown.current = change.elements;
      const next: CanvasWire = { ...base, rev: saved.rev, version: saved.version, marks: saved.marks, scene: { elements, files }, deleted: [...base.deleted, ...saved.deleted] };
      wireRef.current = next;
      setWire({ ...next, scene: { elements: rebaseScene(shown.current, board.current, elements), files } });
      setFailed(false);
      // The open canvas lacks what the save took from the server's scene: given to it once the person is idle.
      if (!sameScene(elements, change.elements)) {
        behind.current = true;
        whenIdle();
      }
      // The picture the agent reads with `canvas read --png`, once the person pauses.
      if (pictureTimer.current) clearTimeout(pictureTimer.current);
      pictureTimer.current = setTimeout(() => void keepCanvasPicture(threadId, saved.rev, elements, files).catch(() => {}), PICTURE_AFTER_MS);
    } catch (cause) {
      if (current.current !== threadId) return;
      // The change is kept, joined with any newer one, and saved again.
      pending.current = joinChanges(change, pending.current);
      const stale = cause instanceof InboxApiError && cause.status === 409;
      if (stale && ++staleInARow.current <= MAX_STALE_IN_A_ROW) {
        // Stale: the canvas changed somewhere else meanwhile. Read it, then save the person's edits on top of it.
        const fresh = await canvasApi.read(threadId).catch(() => null);
        if (current.current !== threadId) return;
        if (fresh) take(fresh);
        again = fresh ? 0 : RETRY_AFTER_MS;
      } else {
        staleInARow.current = 0;
        setFailed(true);
        again = RETRY_AFTER_MS;
      }
    } finally {
      if (saving.current === threadId) saving.current = null;
    }
    if (current.current !== threadId) return;
    if (pending.current) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), again || SAVE_AFTER_MS);
    } else if (missed.current) {
      missed.current = false;
      void load();
    }
  }, [load, take, whenIdle]);

  useEffect(() => {
    current.current = on ? threadId : null;
    wireRef.current = null;
    laidOut.current = null;
    shown.current = [];
    board.current = [];
    behind.current = false;
    missed.current = false;
    staleInARow.current = 0;
    own.current.clear();
    pending.current = null;
    setWire(null);
    setAgentChange(null);
    if (!threadId || !on) return;
    const tracked = trackCanvasActivity();
    activity.current = tracked;
    void load();
    const unsubscribe = subscribeCanvasFrames((ids) => {
      if (ids.length === 0 || ids.includes(threadId)) void load();
    });
    return () => {
      // Leaving the thread (or the canvas going off) saves what is waiting at once.
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
      unsubscribe();
      tracked.stop();
      if (activity.current === tracked) activity.current = null;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = null;
    };
  }, [threadId, on, load, flush]);

  const save = useCallback(
    (change: ThreadCanvasChange) => {
      lastLocal.current = Date.now();
      board.current = change.elements;
      pending.current = joinChanges(pending.current, change);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
    },
    [flush],
  );

  return { wire, sceneKey, agentChange, save, failed };
}
