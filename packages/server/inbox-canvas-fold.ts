/**
 * A linked computer's canvas saves, folded while they wait in the outbox (inbox-machines.ts, the forward).
 *
 * A save of a linked computer's thread names only what the person changed (`partial`), each element under its version,
 * and that computer keeps the higher version of each (mergeSave in packages/shared/inbox/canvas/changes.ts). So two
 * saves that wait for it are the same as one that names the newer of each element: while a save waits and has never
 * left, the next one for the same thread is folded into it. Minutes of drawing while that computer is away are one
 * entry, whatever window, tab or reload made them.
 */

type Element = { id: string; version?: number };

const elementsOf = (body: Record<string, unknown>): Element[] => {
  const scene = body.scene as { elements?: unknown } | null | undefined;
  return Array.isArray(scene?.elements) ? (scene.elements as unknown[]).filter((e): e is Element => !!e && typeof e === "object" && typeof (e as Element).id === "string") : [];
};
const goneOf = (body: Record<string, unknown>): string[] => (Array.isArray(body.gone) ? body.gone.filter((id): id is string => typeof id === "string") : []);

/**
 * One save that does what `held` (waiting, never sent) and then `next` would do there: each element at its higher
 * version (the newer save's on a tie), what either removes and the newer does not name again, the newer appState, and
 * the older `have` (what the window had when the first of them was made, so the far computer answers with the scene
 * when anything landed since). Null when either is not a partial canvas save.
 */
export function foldCanvasSave(held: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> | null {
  if (held.partial !== true || next.partial !== true) return null;
  const heldScene = held.scene as Record<string, unknown> | null | undefined;
  const nextScene = next.scene as Record<string, unknown> | null | undefined;
  if (!heldScene || typeof heldScene !== "object" || !nextScene || typeof nextScene !== "object") return null;
  const nextGone = new Set(goneOf(next));
  const elements = new Map<string, Element>();
  for (const el of elementsOf(held)) if (!nextGone.has(el.id)) elements.set(el.id, el);
  for (const el of elementsOf(next)) {
    const old = elements.get(el.id);
    if (!old || (old.version ?? 0) <= (el.version ?? 0)) elements.set(el.id, el);
  }
  const gone = [...new Set([...goneOf(held), ...nextGone])].filter((id) => !elements.has(id));
  const { gone: _heldGone, ...rest } = { ...held, ...next };
  return {
    ...rest,
    idempotency_key: held.idempotency_key,
    have: Number.isInteger(held.have) ? held.have : next.have,
    scene: { ...heldScene, ...nextScene, elements: [...elements.values()], files: {} },
    ...(gone.length > 0 ? { gone } : {}),
  };
}
