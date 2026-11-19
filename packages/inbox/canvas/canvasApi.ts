/**
 * A thread's canvas, the window's side that is always loaded: the stream's
 * frames, the reads and saves, and the drawing jobs the Inbox hands this
 * window for an agent. Nothing of Excalidraw is imported here; the editor is
 * the lazy `#canvas-board` chunk (lazyParts.tsx).
 */
import type { CanvasLogEntry } from '@plannotator/shared/inbox/canvas/changes';
import type { CanvasScene } from '@plannotator/shared/inbox/canvas/scene';
import { apiGet, apiPost } from '../api';
import { canvasWork } from '../lazyParts';

/** `event: canvas`: a thread's canvas is at a new revision. `by`: the agent's name, null for the person. */
export interface CanvasFrame {
  thread_id: string;
  rev: number;
  by: string | null;
  /** The window whose save this was (it does not read its own save back). */
  window?: string | null;
  elements: string[];
}

/** `event: canvas-job`: the Inbox asks a window to draw a picture or a mermaid diagram for an agent. */
export interface CanvasJob {
  id: string;
  kind: 'picture' | 'mermaid';
  thread_id?: string;
  rev?: number;
  box?: { x: number; y: number; w: number; h: number } | null;
  texts?: string[];
}

export interface CanvasRead {
  rev: number;
  scene: CanvasScene;
  changes: CanvasLogEntry[];
}

/** This page load, so a window can tell its own save's frame from another window's. */
export const CANVAS_WINDOW = `cw_${Math.random().toString(36).slice(2, 12)}`;

const frameListeners = new Set<(frame: CanvasFrame) => void>();
export const subscribeCanvasFrames = (listener: (frame: CanvasFrame) => void) => {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
};

/** The stream's `event: canvas` (eventFrames.ts). */
export function onCanvasFrame(data: string): void {
  try {
    const frame = JSON.parse(data) as CanvasFrame;
    if (typeof frame.thread_id !== 'string' || !Number.isInteger(frame.rev)) return;
    for (const listener of frameListeners) listener({ ...frame, elements: Array.isArray(frame.elements) ? frame.elements : [] });
  } catch {
    // A frame of another shape (a newer Inbox) is skipped.
  }
}

/** The stream's `event: canvas-job`: the editor's chunk arrives (once) and does it. A hidden tab leaves it to a visible one. */
export function onCanvasJob(data: string): void {
  let job: CanvasJob;
  try {
    job = JSON.parse(data) as CanvasJob;
  } catch {
    return;
  }
  if (typeof job.id !== 'string' || (job.kind !== 'picture' && job.kind !== 'mermaid')) return;
  // Every window hears the job and the first answer wins: a tab in the background answers a little later, so one in front goes first.
  const wait = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 600 : 0;
  setTimeout(() => {
    void canvasWork()
      .then((mod) => mod.runCanvasJob(job))
      .catch(() => {});
  }, wait);
}

const path = (threadId: string) => `/api/inbox/threads/${encodeURIComponent(threadId)}/canvas`;

export const canvasApi = {
  read: (threadId: string, since?: number, signal?: AbortSignal) => apiGet<CanvasRead>(`${path(threadId)}${since === undefined ? '' : `?since=${since}`}`, signal),
  /** `have`: the revision this window last took. The answer carries the merged scene when the Inbox held changes this window did not. */
  save: (threadId: string, scene: CanvasScene, have: number, options: { gone?: string[]; keepalive?: boolean } = {}) =>
    apiPost<{ rev: number; scene?: CanvasScene }>(path(threadId), { scene, have, window: CANVAS_WINDOW, ...(options.gone?.length ? { gone: options.gone } : {}) }, { keepalive: options.keepalive }),
  async picture(threadId: string, rev: number, png: Blob, place: { x: number; y: number; w: number; h: number; scale: number }): Promise<void> {
    const query = new URLSearchParams({ rev: String(rev), x: String(place.x), y: String(place.y), w: String(place.w), h: String(place.h), scale: String(place.scale) });
    await fetch(`${path(threadId)}/picture?${query}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  },
  async answerPicture(jobId: string, png: Blob | null, place?: { x: number; y: number; w: number; h: number; scale: number }): Promise<void> {
    const query = place ? new URLSearchParams({ x: String(place.x), y: String(place.y), w: String(place.w), h: String(place.h), scale: String(place.scale) }) : new URLSearchParams({ failed: '1' });
    await fetch(`/api/inbox/canvas/jobs/${jobId}?${query}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png ?? new Blob([]) });
  },
  answerMermaid: (jobId: string, drawn: Record<string, unknown>) => apiPost<{ ok: boolean }>(`/api/inbox/canvas/jobs/${jobId}`, { drawn }),
};

/** What a reply sent from the canvas carries beside its words and files (the reply route's `sketch`). */
export interface CanvasReplySketch {
  kind: 'sketch' | 'selection';
  /** The Excalidraw element ids the person picked (a selection). */
  elements: string[];
  /** The picture each freehand sketch was sent as: thing id → file name. */
  pictures: Record<string, string>;
}

export interface CanvasReply {
  words: string;
  files: File[];
  sketch: CanvasReplySketch;
}
