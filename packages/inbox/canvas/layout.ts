/**
 * The thread canvas's layout (docs/agent-guides/inbox-canvas.md "Where the layout runs"): an agent's board is HTML,
 * and only a browser engine lays HTML out, so the Inbox window does it. Every window open on this computer, while the
 * canvas is on, lays out each agent version waiting for one (`GET /api/canvas/pending`), in the background, whether or
 * not its canvas is open: the lift (packages/ui/components/canvas/lift.ts) measures the board in an off-screen box,
 * the server keeps the elements and the warnings the agent's CLI is waiting for, and the window then draws the
 * version's picture (the message's preview card, `canvas read --png`). Two windows racing: the first answer wins,
 * the other's is refused as stale and dropped.
 */
import { partOf, type CanvasElement } from '@plannotator/core/canvas-scene';
import { canvasApi, type CanvasFileRef } from './client';
import { subscribeCanvasFrames } from './frames';

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

/** Pictures for a scene, loaded as data URLs (the picture's export needs them in memory). */
export async function sceneFiles(threadId: string, files: Record<string, CanvasFileRef>) {
  const { fileData } = await import('@plannotator/ui/components/canvas/picture');
  const out: Record<string, { dataURL: string; mimeType: string }> = {};
  await Promise.all(
    Object.entries(files).map(async ([id, f]) => {
      const data = await fileData(canvasApi.fileUrl(threadId, f.name), f.mimeType);
      if (data) out[id] = data;
    }),
  );
  return out;
}

/** Draw and keep a canvas's picture (the current one, and the version's when named). */
export async function keepCanvasPicture(threadId: string, rev: number, elements: readonly CanvasElement[], files: Record<string, CanvasFileRef>, version?: number) {
  const { canvasPicture, blobDataUrl } = await import('@plannotator/ui/components/canvas/picture');
  const blob = await canvasPicture(elements, await sceneFiles(threadId, files));
  if (!blob) return;
  await canvasApi.picture(threadId, { rev, ...(version ? { version } : {}), dataURL: await blobDataUrl(blob) });
}

const working = new Set<string>();

async function layOut(threadId: string, version: number, pictureOnly: boolean): Promise<void> {
  const key = `${threadId}:${version}`;
  if (working.has(key)) return;
  working.add(key);
  try {
    const wire = await canvasApi.read(threadId);
    if (pictureOnly) {
      // Its picture only: the agent's version as it was laid out (the version's own scene).
      const v = await canvasApi.version(threadId, version);
      if (v.scene) await keepCanvasPicture(threadId, wire.rev, v.scene.elements, v.scene.files, version);
      return;
    }
    if (!wire.board || wire.layout?.state !== 'pending' || wire.layout.version !== version) return;
    const { liftBoard } = await import('@plannotator/ui/components/canvas/lift');
    const lifted = await liftBoard({ board: wire.board, pins: wire.pins, pictureUrl: (name) => canvasApi.fileUrl(threadId, name) });
    const before = wire.scene?.elements ?? [];
    // The first version changes nothing: there was nothing before it.
    const changed = before.some((e) => partOf(e) !== null) ? changedPartCount(before, lifted.elements) : 0;
    const done = await canvasApi.layout(threadId, { version, elements: lifted.elements, files: lifted.files, warnings: lifted.warnings, parts: lifted.parts, changed }).catch(() => null);
    if (!done) return;
    const mine = before.filter((e) => partOf(e) === null);
    const files = { ...(wire.scene?.files ?? {}), ...lifted.files };
    await keepCanvasPicture(threadId, done.rev, [...lifted.elements, ...mine], files, version).catch(() => {});
  } catch {
    // Another window laid it out, or the canvas went off: nothing to do here. The next frame tries again.
  } finally {
    working.delete(key);
  }
}

async function layOutPending(): Promise<void> {
  const list = await canvasApi.pending().catch(() => null);
  for (const { id, version, picture } of list?.pending ?? []) await layOut(id, version, picture === true);
}

/** Lay out every waiting version now and on every canvas frame, until stopped (the canvas went off, the window closed). */
export function startCanvasLayout(): () => void {
  void layOutPending();
  return subscribeCanvasFrames(() => void layOutPending());
}
