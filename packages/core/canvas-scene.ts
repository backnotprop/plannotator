/**
 * The thread canvas's scene, read without Excalidraw: which elements are the agent's parts (by the ids it wrote),
 * where each part stands, what the person moved, resized or deleted, and the short text an agent reads back
 * (`plannotator canvas read`) and the reply box shows ("Canvas marks"). Browser-safe and dependency-free.
 *
 * An agent part's elements carry `customData.part` (the board id) and an id that is the part's own (`row2`) or
 * starts with it (`row2~t`, `row2~rule-b`). A copy the person pastes gets a new id, so it is the person's own.
 * Containers are Excalidraw groups named by their id, so a part's box is the box of its elements and its children's.
 */
import type { BoardPin, BoardStanding } from "./canvas-board";

export interface CanvasElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  isDeleted?: boolean;
  groupIds?: readonly string[];
  customData?: { part?: string; role?: string } | null;
  points?: readonly (readonly [number, number])[];
  text?: string;
  originalText?: string;
  fileId?: string | null;
  containerId?: string | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  [key: string]: unknown;
}

/** What the layout made of each part with an id: its container and what kind of part it is. */
export interface CanvasPartInfo {
  parent: string | null;
  kind: "frame" | "box" | "text" | "picture" | "note" | "arrow" | "group";
  /** The first words it holds (for read-back: "a loop around #row2 (Ben Okafor)"). */
  words?: string;
}
export type CanvasParts = Record<string, CanvasPartInfo>;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const partOf = (el: CanvasElement): string | null => {
  const part = el.customData?.part;
  if (typeof part !== "string" || !part) return null;
  return el.id === part || el.id.startsWith(`${part}~`) ? part : null;
};

export const isLive = (el: CanvasElement): boolean => !el.isDeleted;

/** An element's box on the canvas; a stroke's or an arrow's is the box of its points. */
export function boxOf(el: CanvasElement): Box {
  if (el.points && el.points.length) {
    const xs = el.points.map((p) => p[0]);
    const ys = el.points.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return { x: el.x + x0, y: el.y + y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
  }
  return { x: el.x, y: el.y, w: el.width, h: el.height };
}

const union = (a: Box | undefined, b: Box): Box => {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Each part's box: its own elements' and every part's inside it. Arrows count only for themselves. */
export function partBoxes(elements: readonly CanvasElement[], parts: CanvasParts): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const el of elements) {
    if (!isLive(el)) continue;
    const part = partOf(el);
    if (!part || !parts[part]) continue;
    const b = boxOf(el);
    out.set(part, union(out.get(part), b));
    if (parts[part].kind === "arrow" || el.type === "arrow") continue;
    let p = parts[part].parent;
    for (let guard = 0; p && guard < 64; guard++) {
      if (parts[p]) out.set(p, union(out.get(p), b));
      p = parts[p]?.parent ?? null;
    }
  }
  return out;
}

const NEAR = 1.5;
const near = (a: number, b: number) => Math.abs(a - b) <= NEAR;

export interface PartChange {
  id: string;
  moved: { dx: number; dy: number } | null;
  resized: { w: number; h: number } | null;
  box: Box;
}

/**
 * Parts the person moved or resized on their own between two scenes: a part that moved with its container is not
 * listed again (only the container is), one moved inside a moved container is. Arrows follow their ends and are
 * never listed.
 */
export function changedParts(before: readonly CanvasElement[], after: readonly CanvasElement[], parts: CanvasParts): PartChange[] {
  const was = new Map(before.filter(isLive).map((e) => [e.id, e]));
  const nowBoxes = partBoxes(after, parts);
  // Each part's elements (its own and its children's) present in both scenes, as before/after boxes.
  const subtree = new Map<string, { own: boolean; b: Box; a: Box }[]>();
  for (const el of after) {
    if (!isLive(el) || el.type === "arrow") continue;
    const part = partOf(el);
    const old = was.get(el.id);
    if (!part || !parts[part] || !old) continue;
    const pair = { b: boxOf(old), a: boxOf(el) };
    let p: string | null = part;
    for (let guard = 0; p && guard < 64; guard++) {
      if (!subtree.has(p)) subtree.set(p, []);
      subtree.get(p)!.push({ own: p === part, ...pair });
      p = parts[p]?.parent ?? null;
    }
  }
  const depth = (id: string) => {
    let n = 0;
    for (let p = parts[id]?.parent; p; p = parts[p]?.parent ?? null) n++;
    return n;
  };
  const sized = (q: { b: Box; a: Box }) => !near(q.a.w, q.b.w) || !near(q.a.h, q.b.h);
  const shifted = (q: { b: Box; a: Box }) => !near(q.a.x, q.b.x) || !near(q.a.y, q.b.y);
  const info = new Map<string, { t: { dx: number; dy: number } | null; all: boolean; resized: boolean }>();
  const out: PartChange[] = [];
  for (const id of [...subtree.keys()].sort((x, y) => depth(x) - depth(y))) {
    if (parts[id]?.kind === "arrow") continue;
    const pairs = subtree.get(id)!;
    const first = pairs[0];
    const dx = first.a.x - first.b.x;
    const dy = first.a.y - first.b.y;
    const whole = pairs.every((q) => !sized(q) && near(q.a.x - q.b.x, dx) && near(q.a.y - q.b.y, dy));
    const t = whole ? { dx, dy } : null;
    const all = pairs.every((q) => sized(q) || shifted(q));
    const own = pairs.filter((q) => q.own);
    const resized = own.length ? own.some(sized) : all && pairs.some(sized);
    info.set(id, { t, all, resized });
    const parent = parts[id]?.parent;
    const pi = parent ? info.get(parent) : undefined;
    // Its own shape moved without what is inside it (a button dragged off its label): the part moved, by its shape.
    const ownT = !t && own.length && !own.some(sized) && own.every((q) => near(q.a.x - q.b.x, own[0].a.x - own[0].b.x) && near(q.a.y - q.b.y, own[0].a.y - own[0].b.y)) ? { dx: own[0].a.x - own[0].b.x, dy: own[0].a.y - own[0].b.y } : null;
    const moveT = t ?? ownT;
    const movedAlone = !!moveT && (!near(moveT.dx, 0) || !near(moveT.dy, 0)) && !(pi?.t && near(pi.t.dx, moveT.dx) && near(pi.t.dy, moveT.dy));
    const resizedAlone = resized && !(pi?.resized && all);
    if (!movedAlone && !resizedAlone) continue;
    const box = nowBoxes.get(id);
    if (!box) continue;
    const ownNow = own.length ? own.reduce<Box | undefined>((u, q) => union(u, q.a), undefined)! : box;
    out.push({
      id,
      moved: movedAlone && moveT ? { dx: Math.round(moveT.dx), dy: Math.round(moveT.dy) } : null,
      resized: resizedAlone ? { w: Math.round(ownNow.w), h: Math.round(ownNow.h) } : null,
      // Pinned where its own shape is now when only that moved or changed size, so what it holds follows it.
      box: roundBox(own.length && (ownT || resizedAlone) ? ownNow : box),
    });
  }
  return out;
}

const roundBox = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });

/** Parts that had elements before and have none now; only the outermost of a deleted container is listed first. */
export function deletedParts(before: readonly CanvasElement[], after: readonly CanvasElement[], parts: CanvasParts): string[] {
  const had = partBoxes(before, parts);
  const has = partBoxes(after, parts);
  const gone = [...had.keys()].filter((id) => !has.has(id));
  const set = new Set(gone);
  const depth = (id: string) => {
    let n = 0;
    for (let p = parts[id]?.parent; p; p = parts[p]?.parent ?? null) n++;
    return n;
  };
  // A note or arrow that only went because its target did is not the person's deletion of it.
  return gone.filter((id) => !(parts[id]?.parent && set.has(parts[id].parent!))).sort((x, y) => depth(x) - depth(y));
}

/** Every id inside a part (the part included). */
export function partAndInside(id: string, parts: CanvasParts): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const [k, p] of Object.entries(parts)) if (p.parent === out[i]) out.push(k);
  return out;
}

/**
 * The person's standing after a save: every part they moved or resized since the layout is pinned at its box now
 * (pins they made before stay, at their new box), and every part they deleted is deleted.
 */
export function standingAfter(laidOut: readonly CanvasElement[], now: readonly CanvasElement[], parts: CanvasParts, standing: BoardStanding): { pins: Record<string, BoardPin>; newlyDeleted: string[] } {
  const pins: Record<string, BoardPin> = {};
  const boxes = partBoxes(now, parts);
  for (const id of Object.keys(standing.pins)) {
    const b = boxes.get(id);
    if (b) pins[id] = roundBox(b);
  }
  for (const c of changedParts(laidOut, now, parts)) {
    if (parts[c.id]?.kind === "arrow") continue;
    pins[c.id] = c.box;
  }
  const already = new Set(standing.deleted);
  const newlyDeleted = deletedParts(laidOut, now, parts).filter((id) => !already.has(id));
  for (const d of newlyDeleted) for (const inner of partAndInside(d, parts)) delete pins[inner];
  return { pins, newlyDeleted };
}

// ---------- read-back ----------

const words = (s: string, max = 6) => {
  const w = s.replace(/\s+/g, " ").trim().split(" ");
  return w.length > max ? `${w.slice(0, max).join(" ")}…` : w.join(" ");
};
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inside = (outer: Box, inner: Box) => inner.x >= outer.x - 2 && inner.y >= outer.y - 2 && inner.x + inner.w <= outer.x + outer.w + 2 && inner.y + inner.h <= outer.y + outer.h + 2;

/** The top-level part a part sits in. */
const topOf = (id: string, parts: CanvasParts) => {
  let t = id;
  for (let guard = 0; parts[t]?.parent && guard < 64; guard++) t = parts[t].parent!;
  return t;
};

function partsAround(stroke: Box, boxes: Map<string, Box>, parts: CanvasParts): string[] {
  const enclosed = [...boxes.entries()].filter(([id, b]) => parts[id]?.kind !== "arrow" && inside(stroke, b) && b.w * b.h < stroke.w * stroke.h).map(([id]) => id);
  const set = new Set(enclosed);
  return enclosed.filter((id) => !(parts[id]?.parent && set.has(parts[id].parent!)));
}

function levelWith(b: Box, boxes: Map<string, Box>, parts: CanvasParts): string | null {
  const cy = centre(b).y;
  let best: { id: string; area: number } | null = null;
  for (const [id, pb] of boxes) {
    const info = parts[id];
    if (!info || info.kind === "arrow" || info.kind === "note" || !info.parent) continue;
    if (cy < pb.y || cy > pb.y + pb.h) continue;
    // The widest part at that height that is not a whole frame or top-level part.
    const top = boxes.get(topOf(id, parts));
    if (top && pb.h > top.h * 0.6) continue;
    const area = pb.w * pb.h;
    if (!best || area > best.area) best = { id, area };
  }
  if (best) return best.id;
  let nearest: { id: string; d: number } | null = null;
  for (const [id, pb] of boxes) {
    if (parts[id]?.kind === "arrow") continue;
    const d = Math.hypot(centre(pb).x - centre(b).x, centre(pb).y - centre(b).y);
    if (!nearest || d < nearest.d) nearest = { id, d };
  }
  return nearest?.id ?? null;
}

function besideOf(b: Box, boxes: Map<string, Box>, parts: CanvasParts): string {
  let nearest: { id: string; d: number } | null = null;
  for (const [id, pb] of boxes) {
    if (parts[id]?.parent || parts[id]?.kind === "arrow") continue;
    const dx = Math.max(pb.x - (b.x + b.w), b.x - (pb.x + pb.w), 0);
    const dy = Math.max(pb.y - (b.y + b.h), b.y - (pb.y + pb.h), 0);
    const d = Math.hypot(dx, dy);
    if (!nearest || d < nearest.d) nearest = { id, d };
  }
  if (!nearest) return "";
  const pb = boxes.get(nearest.id)!;
  const side = b.x >= pb.x + pb.w ? "right of" : b.x + b.w <= pb.x ? "left of" : b.y + b.h <= pb.y ? "above" : b.y >= pb.y + pb.h ? "below" : "on";
  return ` ${side} #${nearest.id}`;
}

const named = (id: string, parts: CanvasParts) => (parts[id]?.words ? `#${id} ("${words(parts[id].words!)}")` : `#${id}`);

export interface ReadBackInput {
  /** The scene as the agent's latest version was laid out. */
  laidOut: readonly CanvasElement[];
  now: readonly CanvasElement[];
  parts: CanvasParts;
  /** A picture's file on disk, by its file id, for "pasted a picture". */
  fileName?: (fileId: string) => string | null;
}

/**
 * What the person did since the agent's latest version, one line each, by the agent's ids: moved or resized parts,
 * deleted parts, ink and what it encloses, words and what they are level with, pasted pictures, other drawn shapes.
 */
export function readBackLines(input: ReadBackInput): string[] {
  const { laidOut, now, parts } = input;
  const out: string[] = [];
  for (const c of changedParts(laidOut, now, parts)) {
    if (c.resized && c.moved && (c.moved.dx || c.moved.dy)) out.push(`resized ${named(c.id, parts)} to ${c.resized.w}x${c.resized.h} and moved it by ${signed(c.moved.dx)},${signed(c.moved.dy)}`);
    else if (c.resized) out.push(`resized ${named(c.id, parts)} to ${c.resized.w}x${c.resized.h}`);
    else if (c.moved) out.push(`moved ${named(c.id, parts)} by ${signed(c.moved.dx)},${signed(c.moved.dy)}`);
  }
  for (const id of deletedParts(laidOut, now, parts)) out.push(`deleted ${named(id, parts)}`);
  // Words the person changed inside a part of the agent's.
  const wasText = new Map(laidOut.filter((e) => isLive(e) && e.type === "text" && partOf(e)).map((e) => [e.id, e.text ?? ""]));
  for (const el of now) {
    if (!isLive(el) || el.type !== "text" || !partOf(el)) continue;
    const was = wasText.get(el.id);
    if (was !== undefined && was.replace(/\s+/g, " ").trim() !== (el.text ?? "").replace(/\s+/g, " ").trim()) out.push(`changed the words of #${partOf(el)} to "${words(el.text ?? "", 12)}"`);
  }
  const before = new Set(laidOut.map((e) => e.id));
  const boxes = partBoxes(now, parts);
  const byId = new Map(now.map((e) => [e.id, e]));
  for (const el of now) {
    if (!isLive(el) || partOf(el) || before.has(el.id)) continue;
    // A label typed on the person's own shape or arrow is told with it.
    if (el.type === "text" && el.containerId && byId.get(el.containerId) && !partOf(byId.get(el.containerId)!)) continue;
    const b = boxOf(el);
    if (el.type === "freedraw") {
      const pts = el.points ?? [];
      if (b.w < 4 && b.h < 4) {
        out.push(`tapped a dot${besideOf(b, boxes, parts)}`);
        continue;
      }
      const first = pts[0];
      const last = pts[pts.length - 1];
      const closed = !!first && !!last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.25 * Math.max(b.w, b.h);
      const around = partsAround(b, boxes, parts);
      if (closed && around.length) out.push(`drew a loop around ${around.slice(0, 4).map((id) => named(id, parts)).join(", ")}`);
      else if (closed) out.push(`drew a loop${besideOf(b, boxes, parts)}`);
      else {
        const over = [...boxes.entries()].filter(([id, pb]) => parts[id]?.kind !== "arrow" && parts[id]?.parent && b.x < pb.x + pb.w && b.x + b.w > pb.x && b.y < pb.y + pb.h && b.y + b.h > pb.y && pb.h < b.h * 3).map(([id]) => id);
        const set = new Set(over);
        const outer = over.filter((id) => !(parts[id]?.parent && set.has(parts[id].parent!)));
        out.push(outer.length ? `drew a stroke over ${outer.slice(0, 3).map((id) => named(id, parts)).join(", ")}` : `drew a stroke${besideOf(b, boxes, parts)}`);
      }
    } else if (el.type === "text") {
      const t = (el.text ?? "").trim();
      if (!t) continue;
      const level = levelWith(b, boxes, parts);
      out.push(`wrote "${words(t, 16)}"${level ? ` level with ${named(level, parts)}` : besideOf(b, boxes, parts)}`);
    } else if (el.type === "image") {
      const name = el.fileId ? input.fileName?.(el.fileId) : null;
      out.push(`pasted a picture${besideOf(b, boxes, parts)}${name ? `: ${name}` : ""}`);
    } else if (el.type === "arrow" || el.type === "line") {
      const from = el.startBinding?.elementId ? partOf(byId.get(el.startBinding.elementId) ?? ({} as CanvasElement)) : null;
      const to = el.endBinding?.elementId ? partOf(byId.get(el.endBinding.elementId) ?? ({} as CanvasElement)) : null;
      const label = now.find((t) => t.type === "text" && t.containerId === el.id && isLive(t))?.text;
      const ends = from && to ? ` from #${from} to #${to}` : to ? ` to #${to}` : from ? ` from #${from}` : besideOf(b, boxes, parts);
      out.push(`drew ${el.type === "arrow" ? "an arrow" : "a line"}${ends}${label ? ` labelled "${words(label, 10)}"` : ""}`);
    } else {
      const around = partsAround(b, boxes, parts);
      const label = now.find((t) => t.type === "text" && t.containerId === el.id && isLive(t))?.text;
      const kind = el.type === "rectangle" ? "a box" : el.type === "ellipse" ? "an ellipse" : el.type === "diamond" ? "a diamond" : el.type === "frame" ? "a frame" : `a ${el.type}`;
      out.push(`drew ${kind}${around.length ? ` around ${around.slice(0, 4).map((id) => named(id, parts)).join(", ")}` : besideOf(b, boxes, parts)}${label ? ` with "${words(label, 12)}"` : ""}`);
    }
  }
  return out;
}

/** Elements the agent drew (its parts), the rest being the person's own. */
export const agentElements = (elements: readonly CanvasElement[]) => elements.filter((e) => partOf(e) !== null);
export const personElements = (elements: readonly CanvasElement[]) => elements.filter((e) => partOf(e) === null);
