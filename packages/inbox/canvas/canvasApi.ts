/**
 * A thread's canvas, the window's side that is always loaded: the stream's
 * frames, the reads and saves, and the drawing jobs the Inbox hands this
 * window for an agent. Nothing of Excalidraw is imported here; the editor is
 * the lazy `#canvas-board` chunk (lazyParts.tsx).
 */
import type { CanvasLogEntry } from '@plannotator/shared/inbox/canvas/changes';
import type { CanvasScene } from '@plannotator/shared/inbox/canvas/scene';
import { apiGet, apiPost, pageServerSession } from '../api';
import { inboxUrl, linkedMachinesWith, machineOf, rememberMachine } from '../inboxUrl';
import { canvasWork } from '../lazyParts';
import { newUuid } from '../uuid';

/** `event: canvas`: a thread's canvas is at a new revision. `by`: the agent's name, null for the person. */
export interface CanvasFrame {
  thread_id: string;
  rev: number;
  by: string | null;
  /** The window whose save this was (it does not read its own save back). */
  window?: string | null;
  /** An agent's change was refused: nothing landed (the revision is as it was). */
  refused?: boolean;
  elements: string[];
  /** A linked computer's thread: that computer (this Inbox's forward said so). */
  machine?: string;
}

/** `event: canvas-job`: the Inbox asks a window to draw a picture or a mermaid diagram for an agent. */
export interface CanvasJob {
  id: string;
  kind: 'picture' | 'mermaid';
  thread_id?: string;
  rev?: number;
  box?: { x: number; y: number; w: number; h: number } | null;
  /** With `box`: the picture is exactly that part (a piece of a long strip), not the things that touch it. */
  crop?: boolean;
  texts?: string[];
  /** A linked computer's agent asked: the answer goes back to that computer. */
  machine?: string;
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
    marksSoon();
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

/**
 * A thread's canvas lives with the thread: on a linked computer's thread every call goes to that computer through
 * this Inbox's forward (inboxUrl). Its door takes the same routes (mark `canvas`); the window offers no pen on a
 * computer without it (useThreadCanvas.tsx).
 */
const path = (threadId: string, tail = '', query = '') => inboxUrl(`/threads/${encodeURIComponent(threadId)}/canvas${tail}`, query, machineOf(threadId));

/**
 * A file's bytes as the body (a picture, pictures' files, a job's answer), with the page session in the query (an
 * upload's stale-tab guard, api.ts `fileQuery`): to a linked computer, also keyed there.
 */
const sendBytes = (url: string, type: string, body: Blob | string, keyed: boolean) => {
  const query = new URLSearchParams();
  const session = pageServerSession();
  if (session) query.set('serverSession', session);
  if (keyed) query.set('idempotency_key', newUuid());
  const tail = query.toString();
  return fetch(tail ? `${url}${url.includes('?') ? '&' : '?'}${tail}` : url, { method: 'POST', headers: { 'Content-Type': type }, body });
};

export const canvasApi = {
  /** `look`: the canvas is on the person's screen, so an agent's change up to here is no longer news (the thread's mark goes quiet). */
  read: (threadId: string, since?: number, signal?: AbortSignal, look = false) => {
    const query = [since === undefined ? '' : `since=${since}`, look ? 'look=1' : ''].filter(Boolean).join('&');
    return apiGet<CanvasRead>(path(threadId, '', query), signal);
  },
  /** Take back one change an agent made (its revision): the answer is the canvas after. */
  // To a linked computer it names no window: one held while that computer is away lands later, and its frame must bring it here.
  undo: (threadId: string, rev: number) => apiPost<{ rev: number; scene: CanvasScene; kept?: string[]; kept_count?: number; already?: boolean }>(path(threadId, '/undo'), { rev, ...(machineOf(threadId) ? {} : { window: CANVAS_WINDOW }) }),
  marks: () => apiGet<{ canvases: CanvasMark[] }>(inboxUrl('/canvases')),
  /** A linked computer's canvases with something on them (`machine`: its id). */
  marksOf: (machine: string) => apiGet<{ canvases: CanvasMark[] }>(inboxUrl('/canvases', undefined, machine)),
  /**
   * `have`: the revision this window last took. The answer carries the merged scene when the Inbox held changes this
   * window did not. `partial`: the scene names only what changed since the last save (a linked computer's thread).
   */
  save: (threadId: string, scene: CanvasScene, have: number, options: { gone?: string[]; keepalive?: boolean; plain?: boolean; partial?: boolean } = {}) =>
    // Compressed: a scene is repetitive JSON, so a save is about a tenth of its size, and the one made as the page
    // closes fits what a browser lets a closing page send. (To a linked computer it goes plain: api.ts.)
    apiPost<{ rev: number; scene?: CanvasScene }>(path(threadId), { scene, have, window: CANVAS_WINDOW, ...(options.gone?.length ? { gone: options.gone } : {}), ...(options.partial ? { partial: true } : {}) }, { keepalive: options.keepalive, gzip: !options.plain }),
  /** Pictures' files ahead of the save that names them (a linked computer's thread: that save may wait, and carries none). */
  async files(threadId: string, files: Record<string, unknown>): Promise<void> {
    const response = await sendBytes(path(threadId, '/files'), 'application/json', JSON.stringify({ files }), !!machineOf(threadId));
    if (!response.ok) throw Object.assign(new Error(`The pictures were not saved (${response.status}).`), { status: response.status });
  },
  /** One picture's file, by its id (the scene a window takes after a change carries the elements, not the bytes). */
  file: (threadId: string, fileId: string) => apiGet<{ file: unknown }>(path(threadId, `/files/${encodeURIComponent(fileId)}`)),
  async picture(threadId: string, rev: number, png: Blob, place: { x: number; y: number; w: number; h: number; scale: number }): Promise<void> {
    const query = new URLSearchParams({ rev: String(rev), x: String(place.x), y: String(place.y), w: String(place.w), h: String(place.h), scale: String(place.scale) });
    await sendBytes(path(threadId, '/picture', query.toString()), 'image/png', png, !!machineOf(threadId));
  },
  /** `machine`: the linked computer whose agent asked (the job's frame says so); its answer goes back there. */
  async answerPicture(jobId: string, png: Blob | null, place?: { x: number; y: number; w: number; h: number; scale: number }, machine?: string | null): Promise<void> {
    const query = place ? new URLSearchParams({ x: String(place.x), y: String(place.y), w: String(place.w), h: String(place.h), scale: String(place.scale) }) : new URLSearchParams({ failed: '1' });
    await sendBytes(inboxUrl(`/canvas/jobs/${jobId}`, query.toString(), machine), 'image/png', png ?? new Blob([]), !!machine);
  },
  answerMermaid: async (jobId: string, drawn: Record<string, unknown>, machine?: string | null): Promise<void> => {
    if (!machine) return void (await apiPost<{ ok: boolean }>(inboxUrl(`/canvas/jobs/${jobId}`), { drawn }));
    await sendBytes(inboxUrl(`/canvas/jobs/${jobId}`, undefined, machine), 'application/json', JSON.stringify({ drawn }), true);
  },
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
  /** The bar's words: they are the reply's words (the bar starts from what the reply box held). */
  words: string;
  files: File[];
  sketch: CanvasReplySketch;
}

/** A thread that has a canvas with something on it. `changed`: an agent changed it since the person last had it on screen. */
export interface CanvasMark {
  thread_id: string;
  rev: number;
  changed: boolean;
}

let marks = new Map<string, CanvasMark>();
let marksAsked = false;
let marksTimer: ReturnType<typeof setTimeout> | null = null;
const markListeners = new Set<() => void>();

function loadMarks(): void {
  marksAsked = true;
  // This Inbox's canvases, and each linked computer's that has the canvas (an away one keeps what it last said).
  const far = linkedMachinesWith('canvas');
  void Promise.allSettled([canvasApi.marks(), ...far.map((machine) => canvasApi.marksOf(machine))]).then((answers) => {
    const next = new Map(marks);
    answers.forEach((answer, i) => {
      const machine = i === 0 ? null : far[i - 1]!;
      // An answer of another shape (an older or a far Inbox's error) leaves what was known.
      const canvases = answer.status === 'fulfilled' && Array.isArray(answer.value?.canvases) ? answer.value.canvases : null;
      if (!canvases) return;
      for (const id of [...next.keys()]) if ((machineOf(id) ?? null) === machine) next.delete(id);
      if (machine) rememberMachine(canvases.map((mark) => mark.thread_id), machine);
      for (const mark of canvases) next.set(mark.thread_id, mark);
    });
    marks = next;
    for (const listener of markListeners) listener();
  });
}

/** After a canvas frame: the marks are read again, once for a burst of frames. Only a window that shows marks asks. */
function marksSoon(): void {
  if (!marksAsked) return;
  if (marksTimer) clearTimeout(marksTimer);
  marksTimer = setTimeout(loadMarks, 400);
}

export const subscribeCanvasMarks = (listener: () => void) => {
  markListeners.add(listener);
  if (!marksAsked) loadMarks();
  return () => {
    markListeners.delete(listener);
  };
};
export const canvasMarkOf = (threadId: string): CanvasMark | undefined => marks.get(threadId);

/** The person has the canvas on screen: its mark goes quiet at once, here; the Inbox was told by the read. */
export function canvasLooked(threadId: string): void {
  const mark = marks.get(threadId);
  if (!mark?.changed) return;
  marks = new Map(marks).set(threadId, { ...mark, changed: false });
  for (const listener of markListeners) listener();
}
