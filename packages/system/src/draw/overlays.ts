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

export const OVERLAYS: Overlay[] = [];
export const pickOverlays = (ids: string[] | undefined, list: Overlay[] = OVERLAYS) => list.filter((o) => (ids ?? []).includes(o.id));

export const OV_SEP = ' · ';
const inkOf = (o: Overlay) => o.ink || 'var(--sys-ink)';

export type Tail = { at: number; ink: string };
export type OverlaidLine = { says: string; line: LineClass | null; tails: Tail[] | null };
export type PartOverlay = { tint: string | null; marks: { text: string; ink: string }[] };

export function overlayLine(e: { says: string; line: LineClass | null }, f: Flow | undefined, model: SystemModel, id: string, list: Overlay[]): OverlaidLine {
  let says = e.says, line = e.line;
  const tails: Tail[] = [];
  for (const o of list) {
    if (!e.line) continue;
    const add = o.says && f ? o.says(f, e.line, model, id) : null;
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
