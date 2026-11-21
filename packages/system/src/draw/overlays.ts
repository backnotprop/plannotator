// Overlays: a named layer a reader turns on over the same drawing. The
// mechanism only; the package ships no overlay (a number about how a system
// performs is never part of a line's words in the base drawing, and a drawing
// made from code has no such numbers).
//
// An overlay is one descriptor. Every field is optional:
//   id      its name
//   label   the word on a control that turns it on
//   ink     its colour: everything the overlay adds is drawn in it
//   says(flow, line, model, id)  words added after a line's own words, past a
//           middle dot, in the overlay's ink; null for none
//   line(line, model, id)        a line's pen: { w, ink }; null leaves the base pen
//   part(part, model, id)        a part's { tint, mark }: tint 0 to 1 (a wash of
//           the ink over the box), mark a short text in its top-right corner
// Overlays apply at layout time (layout/compose.ts), because added words change
// where a line's words fit. Simple never shows overlays.
import type { Flow, Part, SystemModel } from '../format/types.ts';
import type { LineClass } from '../layout/types.ts';

export type Overlay = {
  id: string;
  label?: string;
  ink?: string;
  says?: (f: Flow, line: LineClass | null, model: SystemModel, id: string) => string | null;
  line?: (line: LineClass | null, model: SystemModel, id: string) => { w?: number; ink?: string } | null;
  part?: (p: Part, model: SystemModel, id: string) => { tint?: number | true; mark?: string } | null;
};

/** The overlays a drawing may turn on. Empty: the mechanism ships, no overlay does. */
export const OVERLAYS: Overlay[] = [];
export const pickOverlays = (ids: string[] | undefined, list: Overlay[] = OVERLAYS) => list.filter((o) => (ids ?? []).includes(o.id));

/** The middle dot that starts an overlay's words. */
export const OV_SEP = ' · ';
const inkOf = (o: Overlay) => o.ink || 'var(--sys-ink)';

export type Tail = { at: number; ink: string };
export type OverlaidLine = { says: string; line: LineClass | null; tails: Tail[] | null };
export type PartOverlay = { tint: string | null; marks: { text: string; ink: string }[] };

/** A line with the overlays applied: its words gain each overlay's words, its pen the last overlay's colouring. */
export function overlayLine(e: { says: string; line: LineClass | null }, f: Flow | undefined, model: SystemModel, id: string, list: Overlay[]): OverlaidLine {
  let says = e.says, line = e.line;
  const tails: Tail[] = [];
  for (const o of list) {
    if (!e.line) continue;
    const add = o.says && f ? o.says(f, e.line, model, id) : null;
    // the label wraps on single spaces, so the text is kept in that form and
    // the offset of the overlays' words holds across the wrapped lines
    if (add && says) {
      says = String(says).replace(/\s+/g, ' ').trim();
      tails.push({ at: says.length + OV_SEP.length, ink: inkOf(o) });
      says = says + OV_SEP + String(add).replace(/\s+/g, ' ').trim();
    }
    const c = o.line ? o.line(e.line, model, id) : null;
    if (c && line) line = { ...line, ...(c.w != null ? { w: c.w } : {}), ink: c.ink || inkOf(o) };
  }
  return { says, line, tails: tails.length ? tails : null };
}

/** A part's tint and marks from the overlays (the last tint wins; every mark is kept). */
export function overlayPart(p: Part, model: SystemModel, id: string, list: Overlay[]): PartOverlay | null {
  let tint: string | null = null;
  const marks: { text: string; ink: string }[] = [];
  for (const o of list) {
    const c = o.part ? o.part(p, model, id) : null;
    if (c?.tint) tint = `color-mix(in oklab, ${inkOf(o)} ${Math.round(Math.max(0, Math.min(1, c.tint === true ? 0.12 : c.tint)) * 100)}%, transparent)`;
    if (c?.mark) marks.push({ text: String(c.mark), ink: inkOf(o) });
  }
  return tint || marks.length ? { tint, marks } : null;
}
