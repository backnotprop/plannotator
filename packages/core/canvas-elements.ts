/**
 * What a stored canvas scene may hold, checked wherever a scene crosses a boundary: the server on every write and
 * every read (packages/server/canvas-capability.ts), and the window before Excalidraw restores a scene
 * (packages/inbox/canvas/board/CanvasBoard.tsx). A scene on disk is untrusted: a hand-edited or corrupted
 * `canvas.json` must not bring an embed, an iframe or a link into the Inbox's own page.
 *
 * - Only the element types the canvas draws with: no `embeddable`, `iframe` or `magicframe` (an `iframe` element
 *   with `customData.generationData` renders a `srcdoc` frame), and no unknown type.
 * - `customData` keeps only what the canvas writes (`part`, `role`, strings); anything else is dropped.
 * - `link` is always null: links are off on the canvas.
 *
 * Browser-safe, no I/O.
 */
import type { CanvasElement } from "./canvas-scene";

export const CANVAS_ELEMENT_TYPES: ReadonlySet<string> = new Set(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "image", "frame", "selection"]);
export const CANVAS_MAX_ELEMENTS = 20_000;

const ID_MAX = 200;

/** One element, cleaned; null when it is not one the canvas may hold (dropped, never an error on read). */
export function cleanCanvasElement(input: unknown): CanvasElement | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const el = input as Record<string, unknown>;
  if (typeof el.id !== "string" || !el.id || el.id.length > ID_MAX) return null;
  if (typeof el.type !== "string" || !CANVAS_ELEMENT_TYPES.has(el.type) || el.type === "selection") return null;
  for (const k of ["x", "y", "width", "height"]) if (typeof el[k] !== "number" || !Number.isFinite(el[k] as number)) return null;
  const raw = el.customData;
  let customData: CanvasElement["customData"] = null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { part, role } = raw as Record<string, unknown>;
    const kept: { part?: string; role?: string } = {};
    if (typeof part === "string" && part.length <= ID_MAX) kept.part = part;
    if (typeof role === "string" && role.length <= 40) kept.role = role;
    customData = kept.part !== undefined || kept.role !== undefined ? kept : null;
  }
  return { ...(el as unknown as CanvasElement), customData, link: null };
}

/**
 * A scene's elements, cleaned. `strict` (a write): anything that is not an element list, or is over the cap, or holds
 * a malformed element, is refused (null). Not strict (a read): what cannot be held is dropped and the rest kept.
 */
export function cleanCanvasElements(input: unknown, strict: boolean): CanvasElement[] | null {
  if (!Array.isArray(input)) return strict ? null : [];
  if (input.length > CANVAS_MAX_ELEMENTS) return strict ? null : [];
  const out: CanvasElement[] = [];
  for (const e of input) {
    const el = cleanCanvasElement(e);
    if (el) out.push(el);
    else if (strict && !isDroppableType(e)) return null;
  }
  return out;
}

/** A well-formed element of a type the canvas leaves out (an embed, an iframe): dropped on a write, not refused. */
function isDroppableType(e: unknown): boolean {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const el = e as Record<string, unknown>;
  return typeof el.id === "string" && typeof el.type === "string" && !CANVAS_ELEMENT_TYPES.has(el.type);
}
