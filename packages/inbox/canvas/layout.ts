/**
 * The thread canvas's layout (docs/agent-guides/inbox-canvas.md "Where the layout runs"): an agent's board is HTML,
 * and only a browser engine lays HTML out, so the Inbox window does it. Every window open on this computer, while the
 * canvas is on, lays out each agent version waiting for one (`GET /api/canvas/pending`), in the background, whether or
 * not its canvas is open: the lift (packages/inbox/canvas/board/lift.ts) measures the board in an off-screen box,
 * the server keeps the elements and the warnings the agent's CLI is waiting for, and the window then draws the
 * version's picture (the message's preview card, `canvas read --png`). Two windows racing: the first answer wins,
 * the other's is refused as stale and dropped.
 *
 * Each layout names the canvas's `rev` it read: if the person moved or deleted a part since, it is refused and laid
 * out again on the next frame. A board the lift cannot lay out is reported once (`layout-failed`); the server fails
 * the version after a few reports. A version this window failed is tried again here at most once a minute, never on
 * every frame.
 */
import { partOf, type CanvasElement } from '@plannotator/core/canvas-scene';
import { InboxApiError } from '../apiError';
import { canvasApi, type CanvasFileRef } from './client';

/** How many of the agent's parts the new layout changed: added, removed, moved, resized or reworded. */
export function changedPartCount(before: readonly CanvasElement[], after: readonly CanvasElement[]): number {
  return changedPartIds(before, after).length;
}

/** The agent's parts the new layout changed (added, removed, moved, resized or reworded), by id. */
export function changedPartIds(before: readonly CanvasElement[], after: readonly CanvasElement[]): string[] {
  const sig = (elements: readonly CanvasElement[]) => {
    const out = new Map<string, string>();
    for (const e of elements) {
      const part = partOf(e);
      if (!part || e.isDeleted) continue;
      const { text = '', strokeColor = '', backgroundColor = '' } = e as { text?: string; strokeColor?: string; backgroundColor?: string };
      out.set(part, `${out.get(part) ?? ''}|${e.id}:${Math.round(e.x)}:${Math.round(e.y)}:${Math.round(e.width)}:${Math.round(e.height)}:${text}:${strokeColor}:${backgroundColor}`);
    }
    return out;
  };
  const a = sig(before);
  const b = sig(after);
  const out: string[] = [];
  for (const [part, s] of b) if (a.get(part) !== s) out.push(part);
  for (const part of a.keys()) if (!b.has(part)) out.push(part);
  return out;
}

/**
 * How many of the agent's parts its new version changed, for the version's card and the quiet line. The first version
 * changes nothing: there was nothing before it (a scene of the person's own marks has no parts either).
 */
export function layoutChangeCount(version: number, before: readonly CanvasElement[], after: readonly CanvasElement[]): number {
  if (version <= 1 || !before.some((e) => partOf(e) !== null)) return 0;
  return changedPartCount(before, after);
}

/** Pictures for a scene, loaded as data URLs (the picture's export needs them in memory). */
export async function sceneFiles(threadId: string, files: Record<string, CanvasFileRef>) {
  const { fileData } = await import('./board/picture');
  const out: Record<string, { dataURL: string; mimeType: string }> = {};
  await Promise.all(
    Object.entries(files).map(async ([id, f]) => {
      const data = await fileData(canvasApi.fileUrl(threadId, f.name), f.mimeType);
      if (data) out[id] = data;
    }),
  );
  return out;
}

/** Draw and keep a canvas's picture (the current one, and the version's when named). False: there was none to keep. */
export async function keepCanvasPicture(threadId: string, rev: number, elements: readonly CanvasElement[], files: Record<string, CanvasFileRef>, version?: number): Promise<boolean> {
  const { canvasPicture, blobDataUrl } = await import('./board/picture');
  const blob = await canvasPicture(elements, await sceneFiles(threadId, files));
  if (!blob) return false;
  await canvasApi.picture(threadId, { rev, ...(version ? { version } : {}), dataURL: await blobDataUrl(blob) });
  return true;
}

/** A version this window could not lay out (or picture) is tried again here at most this often. */
export const LAYOUT_RETRY_MS = 60_000;

const working = new Set<string>();
/** When this window last failed each version (`thread:version`, `:picture` for its picture alone). */
const lastFailure = new Map<string, number>();
/** The versions this window has told the server it could not lay out: told once. */
const reported = new Set<string>();

const failedRecently = (key: string, now: number) => {
  const at = lastFailure.get(key);
  return at !== undefined && now - at < LAYOUT_RETRY_MS;
};

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, ' ').trim().slice(0, 300) || 'the board could not be laid out';

async function layOut(threadId: string, version: number, pictureOnly: boolean, now: number): Promise<void> {
  const key = `${threadId}:${version}${pictureOnly ? ':picture' : ''}`;
  if (working.has(key) || failedRecently(key, now)) return;
  working.add(key);
  try {
    const wire = await canvasApi.read(threadId);
    if (pictureOnly) {
      // Its picture only: the agent's version as it was laid out (the version's own scene).
      const v = await canvasApi.version(threadId, version);
      const kept = v.scene ? await keepCanvasPicture(threadId, wire.rev, v.scene.elements, v.scene.files, version) : false;
      if (!kept) lastFailure.set(key, now);
      return;
    }
    if (!wire.board || wire.layout?.state !== 'pending' || wire.layout.version !== version) return;
    // The lift's code: a chunk that did not load is this window's trouble, not the board's (tried again later).
    const { liftBoard } = await import('./board/lift');
    let lifted: Awaited<ReturnType<typeof liftBoard>>;
    try {
      lifted = await liftBoard({ board: wire.board, pins: wire.pins, pictureUrl: (name) => canvasApi.fileUrl(threadId, name) });
    } catch (cause) {
      // A board this window cannot lay out (malformed, over the lift's budget): the agent's CLI hears why, once.
      lastFailure.set(key, now);
      if (!reported.has(key)) {
        reported.add(key);
        await canvasApi.layoutFailed(threadId, { version, error: reason(cause) }).catch(() => {});
      }
      return;
    }
    const before = wire.scene?.elements ?? [];
    const changed = layoutChangeCount(version, before, lifted.elements);
    let done: { rev: number };
    try {
      done = await canvasApi.layout(threadId, { rev: wire.rev, version, elements: lifted.elements, files: lifted.files, warnings: lifted.warnings, parts: lifted.parts, changed });
    } catch (cause) {
      // Stale (the person moved or deleted a part meanwhile, or another window was first): dropped, and the next
      // frame lays it out again from the canvas as it is then. Anything else waits for the retry time.
      if (!(cause instanceof InboxApiError && cause.status === 409)) lastFailure.set(key, now);
      return;
    }
    lastFailure.delete(key);
    const mine = before.filter((e) => partOf(e) === null);
    const files = { ...(wire.scene?.files ?? {}), ...lifted.files };
    await keepCanvasPicture(threadId, done.rev, [...lifted.elements, ...mine], files, version).catch(() => false);
  } catch {
    // The canvas did not answer, or went off: tried again on a frame after the retry time.
    lastFailure.set(key, now);
  } finally {
    working.delete(key);
  }
}

/** Lay out every agent version waiting for a browser engine (on every canvas frame: frames.ts). */
export async function layOutPending(now: () => number = Date.now): Promise<void> {
  const list = await canvasApi.pending().catch(() => null);
  for (const { id, version, picture } of list?.pending ?? []) await layOut(id, version, picture === true, now());
}

/** Forget this window's failures (tests). */
export function resetLayoutTries(): void {
  lastFailure.clear();
  reported.clear();
}
