/**
 * The person's canvas edits put onto a newer scene (useThreadCanvas.ts). The canvas can change somewhere else while
 * the person draws: the agent's new version, its layout, another window's save. Nothing the person did is lost.
 *
 * - `base`: the scene the person's canvas started from (what it was last given).
 * - `local`: what the person's canvas holds now.
 * - `server`: the newer scene.
 *
 * An element the person added, changed or deleted (`isDeleted`) since `base` keeps the person's copy, compared by
 * id, `version` and `versionNonce`. Every other element takes the server's copy; one the server no longer has is
 * dropped. The server's order is kept; the person's own new elements go on top, in their order. Pure, no I/O.
 */
import type { CanvasElement } from '@plannotator/core/canvas-scene';

const sameStamp = (a: CanvasElement, b: CanvasElement) => a.version === b.version && a.versionNonce === b.versionNonce;

/** The elements of `local` the person added, changed or deleted since `base`, by id. */
export function personEdits(base: readonly CanvasElement[], local: readonly CanvasElement[]): Map<string, CanvasElement> {
  const before = new Map(base.map((e) => [e.id, e]));
  const out = new Map<string, CanvasElement>();
  for (const e of local) {
    const b = before.get(e.id);
    if (!b || !sameStamp(b, e)) out.set(e.id, e);
  }
  return out;
}

export function rebaseScene(base: readonly CanvasElement[], local: readonly CanvasElement[], server: readonly CanvasElement[]): CanvasElement[] {
  const mine = personEdits(base, local);
  const out: CanvasElement[] = [];
  const placed = new Set<string>();
  for (const s of server) {
    out.push(mine.get(s.id) ?? s);
    placed.add(s.id);
  }
  for (const e of local) if (!placed.has(e.id) && mine.has(e.id)) out.push(e);
  return out;
}

/** Two element lists hold the same elements at the same versions, in the same order. */
export function sameScene(a: readonly CanvasElement[], b: readonly CanvasElement[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.id !== b[i]!.id || !sameStamp(a[i]!, b[i]!) || !!a[i]!.isDeleted !== !!b[i]!.isDeleted) return false;
  return true;
}
