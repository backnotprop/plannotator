import type { Band, Cell, Part, SideSection, Sheet, SystemModel } from '../format/types.ts';
import { hasMark, WIDE_MARKS } from '../draw/mark-ids.ts';
import { lineOfFlow, lineOfMany } from '../draw/grammar.ts';
import { overlayLine, overlayPart, pickOverlays, type Overlay } from '../draw/overlays.ts';
import { FIELD_TOP, FOOT_H, M, outerTest, portText, W } from './common.ts';
import { KINDS } from './kinds.ts';
import { placeLabels, placeLetters } from './labels.ts';
import { currentText, measureEpoch, fitName, FONTS, lh, longestWord, textWidth, wrap } from './measure.ts';
import { marksOf } from '../change/marks.ts';
import { routeAll, type RouteRect, type Strip, type Riser, type BandBox } from './route.ts';
import type { CalloutBox, Edge, LineClass, PartBox, Pt, Rect, SheetLayout, Split, Variant, Zone } from './types.ts';

export { W } from './common.ts';

type WCell = { id?: string; gap?: boolean; fixed?: boolean; stack?: WCell[]; span: number | null };
type WBand = Omit<Band, 'row' | 'split'> & { row: WCell[]; split: Band['split']; hair?: boolean };
type WSheet = Omit<Sheet, 'bands'> & { bands: WBand[]; simple?: boolean };
type WPart = Part & { _win?: boolean; _cw?: number };

const toCell = (c: Cell): WCell =>
  c.type === 'gap' ? { gap: true, fixed: c.fixed, span: c.span } : c.type === 'stack' ? { stack: c.stack.map(toCell), span: c.span } : { id: c.id, span: c.span };
const working = (s: Sheet): WSheet => ({ ...s, bands: s.bands.map((b) => ({ ...b, row: b.row.map(toCell) })) });
const idsOf = (c: WCell): string[] => (c.stack ? c.stack.filter((s) => s.id).map((s) => s.id!) : c.id ? [c.id] : []);

function withoutOuter(sheet: WSheet, isOuter: (id: string) => boolean): WSheet {
  const cell = (c: WCell): WCell | null => {
    if (c.gap) return c;
    if (c.stack) {
      const st = c.stack.filter((x) => !x.id || !isOuter(x.id));
      return st.length ? { ...c, stack: st } : null;
    }
    return c.id && isOuter(c.id) ? null : c;
  };
  const tidy = (row: (WCell | null)[]): WCell[] => {
    if (row.every((c) => c)) return row as WCell[];
    const out: WCell[] = [];
    for (const c of row) {
      if (!c) continue;
      if (c.gap && (!out.length || out[out.length - 1]!.gap)) continue;
      out.push(c);
    }
    while (out.length && out[out.length - 1]!.gap) out.pop();
    return out;
  };
  const bands = sheet.bands.map((b) => ({ ...b, row: tidy(b.row.map(cell)) })).filter((b) => b.row.some((c) => !c.gap));
  const side = (list: SideSection[]) => list.map((sec) => ({ ...sec, stack: sec.stack.filter((id) => !isOuter(id)) })).filter((sec) => sec.stack.length);
  const kept = new Set(bands.map((b) => b.id));
  return {
    ...sheet, bands, left: side(sheet.left), right: side(sheet.right),
    groups: sheet.groups.map((g) => ({ ...g, around: g.around.filter((id) => kept.has(id)) })).filter((g) => g.around.length),
    brace: sheet.brace && sheet.brace.over.some((id) => kept.has(id)) ? { ...sheet.brace, over: sheet.brace.over.filter((id) => kept.has(id)) } : null,
    callouts: sheet.callouts.filter((c) => !isOuter(c.to)),
  };
}

type PortFlow = { id: string; dir: 'in' | 'out'; inner: string[]; outer: string[]; edge?: 'top' | 'bottom' };
function portFlows(model: SystemModel, sheet: WSheet, placed: Set<string>, isOuter: (id: string) => boolean): PortFlow[] {
  const ids = sheet.show === 'all' ? Object.keys(model.flows) : sheet.show;
  const out: PortFlow[] = [];
  for (const id of ids) {
    const f = model.flows[id];
    if (!f) continue;
    const fromIn = f.from.filter((x) => placed.has(x)), fromOut = f.from.filter((x) => isOuter(x));
    if (placed.has(f.to) && !fromIn.length && fromOut.length) out.push({ id, dir: 'in', inner: [f.to], outer: fromOut });
    else if (fromIn.length && isOuter(f.to)) out.push({ id, dir: 'out', inner: fromIn, outer: [f.to] });
  }
  return out;
}

const HEAD = 36;
const PADX = 18, PADB = 16;
const GUT = 66;
const CG = 16;
const UNITS = 24;
const AUTO_GAP = 4;
const SIDE_W = 256, SIDE_GAP = 34, CALL_W = 236, CALL_GAP = 50, BRACE = 46;
export const WIN_HEAD = 66;
export const MIN_H = 900;
const BAND_WRAP = 8;
const FAN_IN = 6;
const ROLE_LINES = 3;
const ROW_GAP = 34;
const DENSE_LINES = 40;
const RISER = 48;
const GUT_DENSE = 80;
const PORT_H = 44;

const KIND_VARIANT: Record<string, Variant> = { conceptual: 'plate', logical: 'box', deployment: 'node', service: 'card', flow: 'box' };

function variantFor(sheet: WSheet, band: WBand | null, p: WPart, side?: SideSection): Variant {
  if (side) return side.tone ? 'node' : p.marks.length > 1 && !p.wordmark ? 'rowx' : 'row';
  const plain = (x: Variant): Variant => (sheet.simple && (x === 'card' || x === 'node') ? 'box' : x);
  if (band?.show) return plain(band.show as Variant);
  const v = plain(KIND_VARIANT[sheet.kind] ?? 'box');
  if (p._win && (sheet.kind === 'conceptual' || sheet.kind === 'logical')) return 'window';
  return v;
}

function shownMarks(p: Part, v: Variant, suppressed: Set<string>): string[] {
  const ms = p.marks.filter((m) => !suppressed.has(m));
  if (v === 'card') return p.marks;
  if (v === 'plate' || v === 'window' || v === 'rowx') return ms;
  return ms.slice(0, 1);
}

const TAG_MAX = 96;
const oneMarkW = (m: string) => (!hasMark(m) ? Math.min(TAG_MAX, textWidth(m, FONTS.tag) + 12) + 6 : WIDE_MARKS.has(m) ? 34 : 22);
const markW = (marks: string[]) => marks.reduce((s, m) => s + oneMarkW(m), 0);

function minWidth(p: WPart, v: Variant, marks: string[]): number {
  const mk = markW(marks);
  switch (v) {
    // a plate's name may take two lines, so it asks for half its width, never less than its longest word
    case 'plate':
      return Math.max(
        Math.max(longestWord(p.name, FONTS.plateName), textWidth(p.name, FONTS.plateName) / 2 + 12) + Math.min(mk, 44) + 40,
        longestWord(p.role, FONTS.plateRole) + 34,
      );
    case 'window':
      // 260 is the narrowest width at which a window's inside still reads as a sheet.
      return Math.max(260, textWidth(p.name, FONTS.plateName) + Math.min(mk, 44) + 60);
    case 'chip':
      return Math.max(textWidth(p.name, FONTS.chipName) + mk + 30, textWidth(p.sub || p.role || '', FONTS.monoSm) + 26);
    case 'card':
      return 200;
    case 'bar':
      return textWidth(p.name, FONTS.barName) + mk + 60;
    default:
      return Math.max(longestWord(p.name, FONTS.boxName) + mk + 40, 96);
  }
}
function comfortWidth(p: WPart, v: Variant, marks: string[]): number {
  if (v === 'plate')
    return Math.max(
      minWidth(p, v, marks),
      textWidth(p.name, FONTS.plateName) + Math.min(markW(marks), 44) + 40,
      (p.role ? (textWidth(p.role, FONTS.plateRole) / ROLE_LINES) * 1.15 : 0) + 34,
    );
  if (v === 'box' || v === 'node') return textWidth(p.name, FONTS.boxName) + markW(marks) + 46;
  return minWidth(p, v, marks);
}

const cardText = (p: Part, k: string) => (p.card && typeof p.card[k] === 'string' ? (p.card[k] as string) : '');
const cardList = (p: Part, k: string) => (p.card && Array.isArray(p.card[k]) ? (p.card[k] as unknown[]) : []);
const subOf = (p: Part, v: Variant) => (v === 'node' ? cardText(p, 'config') || p.sub || p.role : p.sub);

const lineW = (tw: number, pad: number) => (tw + pad <= 280 ? tw + pad + 2 : tw * 0.55 + pad);
function naturalWidth(p: WPart, v: Variant, marks: string[]): number {
  if (v === 'plate' || v === 'window') {
    const pl = Math.max(
      minWidth(p, 'plate', marks),
      textWidth(p.name, FONTS.plateName) + (marks.length ? markW(marks.slice(0, 2)) + 8 : 0) + 40,
      p.role ? lineW(textWidth(p.role, FONTS.plateRole), 34) : 0,
    );
    return p._cw || p._win || v === 'window' ? Math.max(pl, minWidth(p, 'window', marks)) : pl;
  }
  if (v === 'box' || v === 'node') {
    const sub = subOf(p, v), s = sub || p.role, font = sub ? FONTS.mono : FONTS.boxRole;
    // Never narrower than the longest word: a wider word would break inside itself and read as cut off.
    return Math.max(minWidth(p, v, marks), comfortWidth(p, v, marks), s ? Math.min(lineW(textWidth(s, font), 40), 360) : 0, s ? Math.ceil(longestWord(s, font)) + 28 : 0);
  }
  if (v === 'chip') return minWidth(p, v, marks);
  return 0;
}

export const CUE_H = 22;
function heightOf(p: WPart, v: Variant, w: number, marks: string[], childH?: number): number {
  return heightOf0(p, v, w, marks, childH) + (p._cw && v !== 'window' ? lh(CUE_H) : 0);
}
function heightOf0(p: WPart, v: Variant, w: number, marks: string[], childH?: number): number {
  switch (v) {
    case 'window':
      return WIN_HEAD + Math.round((w * (childH || MIN_H)) / W);
    case 'plate': {
      const role = Math.min(ROLE_LINES, wrap(p.role, FONTS.plateRole, w - 32).lines.length);
      const inline = marks.length <= 2 ? markW(marks) + (marks.length ? 8 : 0) : 0;
      const nameL = wrap(p.name, FONTS.plateName, w - 32 - inline).lines.length;
      let h = 13 + nameL * lh(24) + 5 + role * lh(18.5);
      if (p.sub) h += 9 + wrap(p.sub, FONTS.mono, w - 32).lines.length * lh(15);
      if (marks.length > 2) h += 12 + 20;
      return Math.ceil(h + 15);
    }
    case 'chip':
      return 30 + lh(18) + lh(14) - 4;
    case 'bar':
      return 54;
    case 'row':
      return Math.ceil(7 + Math.min(2, wrap(p.name, FONTS.rowName, w - 6 - markW(marks)).lines.length) * lh(20) + 2 + Math.min(ROLE_LINES, wrap(p.role, FONTS.rowRole, w - 6).lines.length) * lh(17) + 8);
    case 'rowx':
      return Math.ceil(11 + Math.min(2, wrap(p.name, FONTS.rowName, w - 6).lines.length) * lh(20) + 2 + Math.min(ROLE_LINES, wrap(p.role, FONTS.rowRole, w - 6).lines.length) * lh(17) + 12 + 20 + 8);
    case 'card': {
      if (!p.card) return 120;
      return 42 + 66 + (21 + 17 + cardList(p, 'entry').length * 23) + (21 + 17 + cardList(p, 'binds').length * 20) + 62 + 58 + 8;
    }
    default: {
      const sub = subOf(p, v);
      const nameLines = Math.max(1, fitName(p.name, FONTS.boxName, w - 27 - markW(marks) - 8).lines.length);
      let h = 8 + lh(20) * nameLines;
      if (sub) h += 3 + Math.min(3, wrap(sub, FONTS.mono, w - 27).lines.length) * lh(15);
      else if (p.role) h += 4 + Math.min(3, wrap(p.role, FONTS.boxRole, w - 27).lines.length) * lh(17);
      return Math.max(54, Math.ceil(h + 11));
    }
  }
}

type Slot = WCell & { units: number; minW: number; comfortW: number; auto?: boolean; x: number; w: number };

function allocate(cells: Slot[], unitW: number, cg = CG): number {
  const fixed = cells.reduce((s, c) => s + (c.units || 0), 0);
  const autos = cells.filter((c) => !c.units);
  const need = autos.map((c) => Math.max(2, Math.ceil((c.minW + cg) / unitW)));
  const total = Math.max(UNITS, fixed + need.reduce((s, n) => s + n, 0));
  const left = total - fixed - need.reduce((s, n) => s + n, 0);
  const weight = autos.map((c) => c.comfortW || c.minW);
  const sumW = weight.reduce((s, n) => s + n, 0) || 1;
  const share = weight.map((wt) => (left * wt) / sumW);
  const got = share.map(Math.floor);
  const rest = left - got.reduce((s, n) => s + n, 0);
  const order = share.map((s, i): [number, number] => [s - Math.floor(s), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  if (order.length) for (let k = 0; k < rest; k++) got[order[k % order.length]![1]]!++;
  autos.forEach((c, i) => {
    c.units = need[i]! + got[i]!;
  });
  return total;
}

type WFlow = { id: string; from: string[]; to: string; both: boolean; says: string; quiet: boolean; line: LineClass | null; tails: Edge['tails']; fan?: Edge['fan']; port?: boolean; portOf?: { from: string[]; to: string } };

function shownFlows(model: SystemModel, sheet: WSheet, placed: Set<string>, ov: Overlay[]): WFlow[] {
  const ids = sheet.show === 'all' ? Object.keys(model.flows) : sheet.show;
  const out: WFlow[] = [];
  for (const id of ids) {
    const f = model.flows[id];
    if (!f) continue;
    const from = f.from.filter((x) => placed.has(x));
    if (!from.length || !placed.has(f.to)) continue;
    const o = overlayLine({ says: sheet.says[id] ?? f.says, line: lineOfFlow(model, id) }, f, model, id, ov);
    out.push({ id, from, to: f.to, both: f.both, says: o.says, quiet: sheet.quiet.includes(id), line: o.line, tails: o.tails });
  }
  return out;
}

function fanIn(flows: WFlow[]): WFlow[] {
  const by: Record<string, WFlow[]> = {};
  for (const f of flows) if (!f.both && f.from.length === 1) (by[f.to] ??= []).push(f);
  const gone = new Set<string>(), out: WFlow[] = [];
  for (const [to, list] of Object.entries(by)) {
    if (list.length <= FAN_IN) continue;
    list.forEach((f) => gone.add(f.id));
    out.push({
      id: 'fan:' + to, from: [...new Set(list.map((f) => f.from[0]!))], to, both: false, says: `${list.length} lines`, quiet: false, tails: null,
      fan: list.map((f) => ({ id: f.id, from: f.from[0]!, says: f.says })), line: lineOfMany(list.map((f) => f.line)),
    });
  }
  return [...flows.filter((f) => !gone.has(f.id)), ...out];
}

function sideHead(sec: SideSection): number {
  const full = textWidth(sec.label, FONTS.band) + (sec.means ? textWidth(sec.means, FONTS.bandMeans) + 12 : 0) + (sec.marks.length ? 26 : 0);
  if (full <= SIDE_W - 28) return 1;
  return wrap(sec.label, FONTS.band, SIDE_W - 28).lines.length + (sec.means ? wrap(sec.means, FONTS.bandMeans, SIDE_W - 28).lines.length : 0);
}

function simpleSheet(s: WSheet): WSheet {
  const bands: WBand[] = s.bands.map((b) => ({
    ...b, means: '', split: null,
    row: b.row.filter((c) => !c.gap).flatMap((c): WCell[] => (c.stack ? c.stack.filter((q) => q.id).map((q) => ({ id: q.id, span: null })) : [{ ...c, span: null }])),
  }));
  const sides: WBand[] = [...s.left, ...s.right]
    .filter((sec) => sec.stack.length)
    .map((sec, i) => ({ id: sec.id || `side${i}`, label: sec.label, means: '', tone: sec.tone || 'none', hair: !sec.tone, show: '', marks: sec.marks, split: null, row: sec.stack.map((id) => ({ id, span: null })) }));
  return { ...s, simple: true, bands: [...bands, ...sides], left: [], right: [], groups: [], callouts: [], notes: [], brace: null, show: [], quiet: [] };
}
const SIMPLE_GUT = 20;
const LINE_GAP = 72;

export type LayoutOpts = {
  /** The paper height; the sheet is never shorter than its drawing. */
  H?: number;
  simple?: boolean;
  compact?: boolean;
  childH?: Record<string, number>;
  overlays?: string[];
  gutAdd?: number;
};

const hiddenWords = (L: SheetLayout) => L.edges.filter((e) => e.says && !e.quiet && e.lb?.hidden).length;

const KEPT = new WeakMap<SystemModel, Map<string, SheetLayout>>();
const keptKey = (code: string, opts: LayoutOpts) => {
  const t = currentText();
  return `${code}|${measureEpoch()}|${t.type}|${t.sans}|${t.mono}|${JSON.stringify({ ...opts, childH: undefined })}|${JSON.stringify(opts.childH ?? {})}`;
};

export function layoutSheet(model: SystemModel, code: string, opts: LayoutOpts = {}): SheetLayout {
  let m = KEPT.get(model);
  if (!m) KEPT.set(model, (m = new Map()));
  const k = keptKey(code, opts);
  const hit = m.get(k);
  if (hit) return hit;
  let L = layoutSheet0(model, code, opts);
  if (!L.dense && !L.simple && model.sheets[code]!.bands.length) {
    let n = hiddenWords(L);
    for (const add of [28, 56, 84]) {
      if (!n) break;
      const L2 = layoutSheet0(model, code, { ...opts, gutAdd: add });
      const n2 = hiddenWords(L2);
      if (n2 < n) {
        L = L2;
        n = n2;
      }
    }
  }
  L = marked(model, L);
  m.set(k, L);
  return L;
}

function marked(model: SystemModel, L: SheetLayout): SheetLayout {
  const mk = marksOf(model);
  if (!mk) return L;
  const parts: SheetLayout['parts'] = {};
  for (const [id, b] of Object.entries(L.parts)) {
    const p = Object.hasOwn(mk.parts, id) ? mk.parts[id]! : null;
    parts[id] = p ? { ...b, status: p.is, n: p.n, lines: p.lines, ...(p.who ? { who: p.who } : {}) } : b;
  }
  const flowIs = (id: string | null | undefined) => (id && Object.hasOwn(mk.flows, id) ? mk.flows[id]! : null);
  const hopIs = (id: string) => (Object.hasOwn(mk.hops, id) ? mk.hops[id]! : null);
  const edges = L.edges.map((e) => {
    const st = e.style === 'aud' ? null : hopIs(e.id) ?? flowIs(e.flow ?? e.id) ?? (e.fan?.some((f) => flowIs(f.id)) ? 'changed' : null);
    return st ? { ...e, status: st } : e;
  });
  const figures = L.figures.map((f) => {
    const st = hopIs(f.id) ?? (f.edge ? hopIs(f.edge) : null);
    return st ? { ...f, status: st } : f;
  });
  return { ...L, parts, edges, figures };
}

export function hasSimple(model: SystemModel, code: string): boolean {
  const s = model.sheets[code];
  return !!s?.bands.length && withoutOuter(working(s), outerTest(model, s.scope)).bands.length > 0;
}

const opensFrom = (model: SystemModel, p: Part | undefined, here: string) =>
  p && p.child && model.byScope[p.child]?.length && (p.in || 'root') === here ? p.child : null;

type WRow = { cells: Slot[]; h: number; y: number };
type LBand = WBand & { x: number; w: number; y: number; h: number; rows: WRow[]; cells: Slot[]; labelled: boolean };

function layoutSheet0(model: SystemModel, code: string, opts: LayoutOpts): SheetLayout {
  const sheet0 = model.sheets[code]!;
  const isOuter = outerTest(model, sheet0.scope);
  const sheet1 = withoutOuter(working(sheet0), isOuter);
  const SIMPLE = !!opts.simple && sheet1.bands.length > 0;
  const sheet = SIMPLE ? simpleSheet(sheet1) : sheet1;
  const own = KINDS[sheet.kind];
  if (own && sheet0[own.field].length > 0 && !sheet0.bands.length) return own.compose(model, code, { H: opts.H });

  const here = sheet.scope || 'root';
  const P: Record<string, WPart> = {};
  for (const [id, p0] of Object.entries(model.parts)) {
    const p: WPart = SIMPLE ? { ...p0, sub: '' } : p0;
    const opens = opensFrom(model, p0, here);
    P[id] = opens ? (opts.compact ? { ...p, _cw: model.byScope[opens]!.length } : { ...p, _win: true }) : p;
  }
  const placed = new Set<string>();
  const bandOf: Record<string, string> = {};
  for (const b of sheet.bands)
    for (const c of b.row)
      for (const id of idsOf(c))
        if (P[id]) {
          placed.add(id);
          bandOf[id] = b.id;
        }
  const sideOf: Record<string, SideSection> = {};
  for (const s of [...sheet.left, ...sheet.right])
    for (const id of s.stack)
      if (P[id]) {
        placed.add(id);
        sideOf[id] = s;
      }
  const OV = SIMPLE ? [] : pickOverlays(opts.overlays);
  const flows = fanIn(shownFlows(model, sheet, placed, OV));
  const ports = SIMPLE ? [] : portFlows(model, sheet, placed, isOuter);
  const bandIx: Record<string, number> = Object.fromEntries(sheet.bands.map((b, i) => [b.id, i]));
  const upper = (id: string) => (bandOf[id] == null ? true : bandIx[bandOf[id]!]! < sheet.bands.length / 2);
  for (const q of ports) q.edge = (q.dir === 'in' ? upper(q.inner[0]!) : q.inner.some(upper)) ? 'top' : 'bottom';
  const arrIn = ports.some((q) => q.edge === 'top'), arrOut = ports.some((q) => q.edge === 'bottom');
  const dense = sheet.bands.some((b) => b.row.filter((c) => !c.gap).length > BAND_WRAP) || flows.length >= DENSE_LINES;
  const CG0 = dense ? RISER : CG;

  const suppress: Record<string, Set<string>> = {};
  const sup = (id: string, ms: string[]) => {
    const s = (suppress[id] ??= new Set());
    ms.forEach((m) => s.add(m));
  };
  for (const id of placed) sup(id, []);
  if (sheet.brace) for (const id of placed) if (sheet.brace.over.includes(bandOf[id] ?? '')) sup(id, sheet.brace.marks);
  for (const g of sheet.groups) for (const id of placed) if (g.around.includes(bandOf[id] ?? '')) sup(id, g.marks);
  for (const b of sheet.bands) for (const id of placed) if (bandOf[id] === b.id) sup(id, b.marks);
  for (const s of [...sheet.left, ...sheet.right]) for (const id of s.stack) sup(id, s.marks);
  const supOf = (id: string) => suppress[id] ?? new Set<string>();

  const leftCall = sheet.callouts.some((c) => c.side === 'left');
  const rightCall = sheet.callouts.some((c) => c.side === 'right');
  let x = M;
  const callLX = x;
  if (leftCall) x += CALL_W + CALL_GAP;
  const sideLX = x;
  if (sheet.left.length) x += SIDE_W + SIDE_GAP;
  if (sheet.brace) x += BRACE;
  const fieldX = x;
  let xr = W - M;
  const callRX = xr - CALL_W;
  if (rightCall) xr -= CALL_W + CALL_GAP;
  const sideRX = xr - SIDE_W;
  if (sheet.right.length) xr -= SIDE_W + SIDE_GAP;
  const fieldW = xr - fieldX;

  const inGroup = (bid: string) => sheet.groups.find((g) => g.around.includes(bid));
  const GROUP_IN = 20;

  const linked = (a: string[], b: string[]) =>
    flows.some((f) => (f.from.some((s) => a.includes(s)) && b.includes(f.to)) || (f.from.some((s) => b.includes(s)) && a.includes(f.to)));
  const rects: Record<string, RouteRect & { v: Variant; band?: string; side?: string }> = {};
  const bands: LBand[] = sheet.bands.map((b) => {
    const g = inGroup(b.id);
    const bx = fieldX + (g ? GROUP_IN : 0), bw = fieldW - (g ? GROUP_IN * 2 : 0);
    const innerX = bx + PADX, innerW = bw - PADX * 2;
    const nParts = b.row.filter((c) => !c.gap).length;
    let nRows = nParts > BAND_WRAP ? Math.ceil(nParts / BAND_WRAP) : 1;
    // a row whose measured minimums do not fit the band wraps into one more row
    const minOf = (c: WCell) =>
      Math.max(60, ...idsOf(c).filter((id) => P[id]).map((id) => {
        const v = variantFor(sheet, b, P[id]!);
        return minWidth(P[id]!, v, shownMarks(P[id]!, v, supOf(id)));
      })) + CG0;
    if (!b.split && !b.row.some((c) => c.span)) {
      const sumMin = b.row.filter((c) => !c.gap).reduce((a, c) => a + minOf(c), 0) - CG0;
      while (nRows < nParts && sumMin / nRows > innerW) nRows++;
    }
    const per = Math.ceil(nParts / nRows);
    const chunks: WCell[][] = [[]];
    let k = 0;
    for (const c of b.row) {
      if (!c.gap && k === per) {
        chunks.push([]);
        k = 0;
      }
      if (c.gap && !chunks[chunks.length - 1]!.length) continue; // a row never starts with a gap
      chunks[chunks.length - 1]!.push(c);
      if (!c.gap) k++;
    }
    const rows: WRow[] = chunks.map((row) => {
      const cells: Slot[] = [];
      row.forEach((c, i) => {
        if (i > 0 && !dense) {
          const prev = row[i - 1]!;
          if (!prev.gap && !c.gap && linked(idsOf(prev), idsOf(c))) cells.push({ gap: true, span: null, units: AUTO_GAP, auto: true, minW: 0, comfortW: 0, x: 0, w: 0 });
        }
        const ms = idsOf(c).filter((id) => P[id]).map((id) => {
          const v = variantFor(sheet, b, P[id]!);
          const mk = shownMarks(P[id]!, v, supOf(id));
          return [minWidth(P[id]!, v, mk), comfortWidth(P[id]!, v, mk)] as const;
        });
        const minW = c.gap ? 0 : Math.max(60, ...ms.map((m) => m[0]));
        const comfortW = c.gap ? 0 : Math.max(60, ...ms.map((m) => m[1]));
        cells.push({ ...c, units: c.gap ? (c.fixed ? (c.span ?? 1) * 2 : 1) : c.span ? c.span * 2 : 0, minW, comfortW, x: 0, w: 0 });
      });
      const parts_ = cells.filter((c) => !c.gap);
      const cg = !dense || parts_.length < 2 ? CG0 : Math.max(CG, Math.min(RISER, (innerW - parts_.reduce((a, c) => a + Math.max(c.minW, Math.min(c.comfortW, 170)), 0)) / (parts_.length - 1)));
      const unitW0 = (innerW + cg) / UNITS;
      const eq = Math.floor(UNITS / per);
      let total: number;
      if (dense && nRows > 1 && cells.every((c) => !c.gap && !c.units) && cells.every((c) => c.minW + cg <= eq * unitW0)) {
        cells.forEach((c) => {
          c.units = eq;
        });
        total = UNITS;
      } else total = allocate(cells, unitW0, cg);
      const unitW = (innerW + cg) / total;
      let u = 0;
      for (const c of cells) {
        c.x = innerX + u * unitW;
        c.w = c.units * unitW - cg;
        u += c.units;
      }
      if (!dense && !SIMPLE) {
        const ps = cells.filter((c) => !c.gap);
        const nat = ps.map((c) => {
          const nws = idsOf(c).filter((id) => P[id]).map((id) => {
            const v = variantFor(sheet, b, P[id]!);
            return naturalWidth(P[id]!, v, shownMarks(P[id]!, v, supOf(id)));
          });
          return nws.length && nws.every((n) => n > 0) ? Math.round(Math.max(...nws)) : 0;
        });
        // every box fits at its natural width: spread with equal gaps across
        // the band; otherwise each keeps the slot it was given
        const fits = nat.every((n) => n > 0) && nat.reduce((a, n) => a + n, 0) + (ps.length - 1) * cg <= innerW;
        if (fits) {
          ps.forEach((c, i) => {
            c.w = nat[i]!;
          });
          const gapW = ps.length > 1 ? (innerW - nat.reduce((a, n) => a + n, 0)) / (ps.length - 1) : 0;
          let xx = innerX;
          for (const c of ps) {
            c.x = xx;
            xx += c.w + gapW;
          }
        } else if (nat.every((n) => n > 0) && !b.row.some((c) => c.span)) {
          const wordsW = (a: string[], b2: string[]) =>
            Math.max(0, ...flows.filter((f) => (f.from.some((q) => a.includes(q)) && b2.includes(f.to)) || (f.from.some((q) => b2.includes(q)) && a.includes(f.to))).map((f) => textWidth(String(f.says || ''), FONTS.label) / 2 + 28));
          const gaps = ps.map((c, i) => (i === 0 ? 0 : linked(idsOf(ps[i - 1]!), idsOf(c)) ? Math.min(180, Math.max(LINE_GAP, wordsW(idsOf(ps[i - 1]!), idsOf(c)))) : cg));
          const room = innerW - gaps.reduce((a, g2) => a + g2, 0), sum = nat.reduce((a, n) => a + n, 0);
          let xx = innerX;
          ps.forEach((c, i) => {
            xx += gaps[i]!;
            c.w = Math.floor((nat[i]! * room) / sum);
            c.x = xx;
            xx += c.w;
          });
        } else {
          ps.forEach((c, i) => {
            if (nat[i]! > 0 && nat[i]! < c.w) c.w = nat[i]!;
          });
        }
      }
      return { cells, h: 0, y: 0 };
    });
    return { ...b, x: bx, w: bw, y: 0, h: 0, rows, cells: rows.flatMap((r) => r.cells), labelled: !!b.label };
  });

  const childH = (id: string) => opts.childH?.[P[id]?.child ?? ''];
  const cellH = (id: string, v: Variant, w: number) =>
    SIMPLE && v === 'window'
      ? heightOf({ ...P[id]!, _cw: 1, _win: false }, 'plate', w, shownMarks(P[id]!, 'plate', supOf(id)))
      : heightOf(P[id]!, v, w, shownMarks(P[id]!, v, supOf(id)), childH(id));
  for (const b of bands) {
    for (const row of b.rows) {
      let rowH = 0;
      for (const c of row.cells) {
        if (c.gap) continue;
        const ids = idsOf(c).filter((id) => P[id]);
        if (c.stack) {
          const hs = ids.map((id) => cellH(id, variantFor(sheet, b, P[id]!), c.w));
          rowH = Math.max(rowH, hs.reduce((a, h) => a + h, 0) + (hs.length - 1) * 14);
        } else if (ids.length) rowH = Math.max(rowH, cellH(ids[0]!, variantFor(sheet, b, P[ids[0]!]!), c.w));
      }
      row.h = rowH || 40;
    }
    b.h = (b.labelled ? HEAD : PADB) + b.rows.reduce((a, r) => a + r.h, 0) + (b.rows.length - 1) * ROW_GAP + PADB;
  }

  const gapsN = Math.max(1, bands.length - 1);
  const groupExtra = sheet.groups.length * (42 + 16);
  const GUTTER = SIMPLE ? SIMPLE_GUT : dense ? GUT_DENSE : GUT;
  const gutAdd = opts.gutAdd ?? 0;
  const PH = PORT_H + Math.round(gutAdd * 0.6);
  const naturalField = bands.reduce((s, b) => s + b.h, 0) + gapsN * (GUTTER + gutAdd) + groupExtra + (arrIn ? PH : 0) + (arrOut ? PH : 0);
  const sideNeed = Math.max(0, ...[sheet.left, sheet.right].map((col) =>
    col.reduce((s, sec) => s + 40 + sec.stack.reduce((a, id) => a + (P[id] ? heightOf(P[id]!, variantFor(sheet, null, P[id]!, sec), SIDE_W - 24, []) + (sec.tone ? 10 : 0) : 0), 0) + 30, 0)));
  const natural = FIELD_TOP + Math.max(naturalField, sideNeed) + FOOT_H;
  const H = Math.max(opts.H ?? 0, natural);
  const spare = H - natural;
  const gut = GUTTER + gutAdd + (bands.length > 1 && !SIMPLE ? Math.min(40, spare / (gapsN + 1)) : 0);

  let y = FIELD_TOP + (arrIn ? PH : 0);
  const groupBoxes: { g: (typeof sheet.groups)[number]; y0: number; y1: number }[] = [];
  bands.forEach((b, i) => {
    const g = inGroup(b.id);
    if (g && g.around[0] === b.id) {
      y += 42;
      groupBoxes.push({ g, y0: y - 42, y1: y });
    }
    b.y = y;
    y += b.h;
    if (g && g.around[g.around.length - 1] === b.id) {
      y += 16;
      const gb = groupBoxes.find((q) => q.g === g);
      if (gb) gb.y1 = y;
    }
    if (i < bands.length - 1) y += gut;
  });
  let fieldBottom = y + (arrOut ? PH : 0);
  const portBottomY = y + 18 + (PH - PORT_H);

  for (const b of bands) {
    let top = b.y + (b.labelled ? HEAD : PADB);
    for (const row of b.rows) {
      row.y = top;
      for (const c of row.cells) {
        if (c.gap) continue;
        const ids = idsOf(c).filter((id) => P[id]);
        if (c.stack) {
          const n = ids.length;
          const hs = ids.map((id) => (SIMPLE ? cellH(id, variantFor(sheet, b, P[id]!), c.w) : heightOf(P[id]!, variantFor(sheet, b, P[id]!), c.w, shownMarks(P[id]!, variantFor(sheet, b, P[id]!), supOf(id)))));
          const more = SIMPLE ? Math.max(0, row.h - hs.reduce((a, h) => a + h, 0) - (n - 1) * 14) / n : 0;
          let yy = top;
          ids.forEach((id, k2) => {
            const h = hs[k2]! + more;
            rects[id] = { x: c.x, y: yy, w: c.w, h, v: variantFor(sheet, b, P[id]!), band: b.id };
            yy += h + 14;
          });
        } else if (ids.length) {
          const id = ids[0]!;
          const v = variantFor(sheet, b, P[id]!);
          const h = SIMPLE ? row.h : Math.min(row.h, heightOf(P[id]!, v, c.w, shownMarks(P[id]!, v, supOf(id)), childH(id)));
          rects[id] = { x: c.x, y: top, w: c.w, h, v, band: b.id };
        }
      }
      top += row.h + ROW_GAP;
    }
  }

  const zones: Zone[] = [];
  const sideCol = (col: SideSection[], colX: number) => {
    let cy = FIELD_TOP;
    for (const sec of col) {
      const align = sec.beside ? bands.find((b) => b.id === sec.beside) : undefined;
      if (align) cy = Math.max(cy, align.y);
      const y0 = cy;
      const lines = sec.label ? sideHead(sec) : 0;
      let yy = y0 + (sec.label ? 30 + (lines - 1) * lh(13) : 12);
      for (const id of sec.stack) {
        if (!P[id]) continue;
        const v = variantFor(sheet, null, P[id]!, sec);
        const h = heightOf(P[id]!, v, SIDE_W - 24, shownMarks(P[id]!, v, supOf(id)));
        rects[id] = { x: colX + 12, y: yy, w: SIDE_W - 24, h, v, side: sec.id };
        yy += h + (sec.tone ? 10 : 0);
      }
      let y1 = yy + (sec.tone ? 6 : 12);
      if (align) y1 = Math.max(y1, align.y + align.h);
      zones.push({
        id: sec.id, x: colX, y: y0, w: SIDE_W, h: y1 - y0, label: sec.label, tone: sec.tone || 'none', hair: !sec.tone, marks: sec.marks,
        labelW: lines > 1 ? SIDE_W - 20 : undefined, labelH: lines ? lh(13) * lines + 13 : 26,
      });
      cy = y1 + 24;
    }
    fieldBottom = Math.max(fieldBottom, cy - 24);
  };
  sideCol(sheet.left, sideLX);
  sideCol(sheet.right, sideRX);

  for (const b of bands)
    if (b.labelled) zones.push({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, label: b.label, means: b.means || undefined, tone: b.tone || 'stone', marks: b.marks, band: true, ...(b.hair ? { hair: true } : {}) });
  for (const gb of groupBoxes) zones.unshift({ id: gb.g.id, x: fieldX, y: gb.y0, w: fieldW, h: gb.y1 - gb.y0, label: gb.g.label, means: gb.g.means || undefined, tone: 'none', solid: true, marks: gb.g.marks });

  const splits: Split[] = [];
  for (const b of bands) {
    if (!b.split) continue;
    const i = b.cells.findIndex((c) => c.id === b.split!.before);
    if (i < 0) continue;
    const prev = b.cells[i - 1];
    const before = b.cells.slice(0, i).filter((c) => !c.gap).pop();
    const sx = before ? (before.x + before.w + b.cells[i]!.x) / 2 : prev && prev.gap ? prev.x + prev.w / 2 + CG / 2 : b.cells[i]!.x - CG / 2;
    splits.push({ x: sx, y0: b.y + 8, y1: b.y + b.h - 8, left: b.split.left, right: b.split.right, ty: b.y + 13 });
  }

  const parts: Record<string, PartBox> = {};
  for (const [id, r] of Object.entries(rects)) {
    const p = P[id]!;
    const box: PartBox = { x: r.x, y: r.y, w: r.w, h: r.h, v: r.v, band: r.band, side: r.side, marks: shownMarks(p, r.v, supOf(id)), status: null, opens: opensFrom(model, model.parts[id], here) };
    if (OV.length) box.ov = overlayPart(model.parts[id]!, model, id, OV);
    // a box name never breaks inside a word: when it would, the box draws the
    // fitted lines, each word whole or ending in an ellipsis
    if ((r.v === 'box' || r.v === 'node') && p.name) {
      const f = fitName(p.name, FONTS.boxName, r.w - 27 - markW(box.marks) - 8);
      if (f.cut) box.nl = f.lines;
    }
    if (p._cw && r.v !== 'window') box.cw = p._cw;
    parts[id] = box;
  }

  const callouts: (CalloutBox & { arrow: Pt[] })[] = [];
  sheet.callouts.forEach((c, i) => {
    const r = rects[c.to];
    if (!r) return;
    // a title never breaks inside a word: a word wider than the column ends in
    // an ellipsis and the full title rides along for the hover
    const tf = fitName(c.title, FONTS.calloutTitle, CALL_W, 3);
    const t = tf.lines;
    const b = wrap(c.text, FONTS.calloutText, CALL_W).lines;
    const h = t.length * lh(21) + 9 + b.length * lh(19);
    const cx0 = c.side === 'left' ? callLX : callRX;
    const ay = r.y + Math.min(r.h / 2, 60);
    const top = Math.max(FIELD_TOP, ay - 14);
    const arrow: Pt[] = c.side === 'left'
      ? [[Math.min(cx0 + Math.max(...t.map((l) => textWidth(l, FONTS.calloutTitle))) + 14, r.x - 50), ay], [r.x - 4, ay]]
      : [[cx0 - 14, ay], [r.x + r.w + 4, ay]];
    callouts.push({ id: 'call' + i, x: cx0, y: top, w: CALL_W, h, title: t, full: tf.cut ? c.title : null, text: b, side: c.side, arrow, to: c.to });
  });

  const header = { x: M, y: 30, w: 900, h: FIELD_TOP - 40 };
  const bandHeads = zones.filter((z) => z.label).map((z) => ({
    x: z.x + 10, y: z.y + 4, h: z.labelH ?? 26,
    w: z.labelW ?? textWidth(z.label, FONTS.band) + (z.means ? textWidth(z.means, FONTS.bandMeans) + 12 : 0) + (z.marks.length ? 26 : 0) + 16,
  }));
  const splitHeads = splits.flatMap((s) => [
    { x: s.x - 12 - textWidth(s.left, FONTS.bandMeans), y: s.ty - 4, w: textWidth(s.left, FONTS.bandMeans) + 4, h: 20 },
    { x: s.x + 10, y: s.ty - 4, w: textWidth(s.right, FONTS.bandMeans) + 4, h: 20 },
  ]);
  const obstacles: Rect[] = [...Object.values(rects), ...callouts.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })), ...bandHeads, ...splitHeads];
  const bounds = { x0: 20, y0: FIELD_TOP - 30, x1: W - 20, y1: fieldBottom + 26 };
  const containerOf: Record<string, Rect> = {};
  for (const [id, r] of Object.entries(rects)) {
    const z = zones.find((q) => q.id === (r.band || r.side));
    if (z) containerOf[id] = z;
  }
  const routeRects: Record<string, RouteRect> = Object.fromEntries(Object.entries(rects).map(([id, r]) => [id, parts[id]!.opens ? { ...r, bubble: true } : r]));
  const bandBoxes: BandBox[] = bands.map((b) => ({ id: b.id, x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h }));
  const env = [...bandBoxes.map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 })), ...zones].reduce(
    (m, z) => ({ x0: Math.min(m.x0, z.x), y0: Math.min(m.y0, z.y), x1: Math.max(m.x1, z.x + z.w), y1: Math.max(m.y1, z.y + z.h) }),
    { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 },
  );
  const strips: Strip[] = [];
  const risers: Riser[] = [];
  for (const b of bands) {
    b.rows.forEach((r, i) => {
      if (i > 0) {
        const prev = b.rows[i - 1]!;
        strips.push({ band: b.id, x0: b.x, x1: b.x + b.w, y0: prev.y + prev.h, y1: r.y });
      }
      if (dense) {
        const cs = r.cells.filter((c) => !c.gap);
        for (let k = 0; k < cs.length - 1; k++) risers.push({ x: Math.round(cs[k]!.x + cs[k]!.w + (cs[k + 1]!.x - cs[k]!.x - cs[k]!.w) / 2), band: b.id });
      }
    });
  }
  let channels: { gutters: number[]; lanes: number[] } | null = null;
  if (dense) {
    const byY = [...bandBoxes].sort((a, b) => a.y0 - b.y0);
    const gutters: number[] = [];
    for (let i = 0; i < byY.length - 1; i++) if (byY[i + 1]!.y0 - byY[i]!.y1 > 24) gutters.push(Math.round((byY[i]!.y1 + byY[i + 1]!.y0) / 2));
    const fx0 = Math.min(...bandBoxes.map((b) => b.x0)), fx1 = Math.max(...bandBoxes.map((b) => b.x1));
    const lanes: number[] = [];
    const sideZ = zones.filter((z) => !z.band);
    const lz = sideZ.filter((z) => z.x + z.w <= fx0), rz = sideZ.filter((z) => z.x >= fx1);
    if (lz.length) lanes.push(Math.round((Math.max(...lz.map((z) => z.x + z.w)) + fx0) / 2));
    if (rz.length) lanes.push(Math.round((Math.min(...rz.map((z) => z.x)) + fx1) / 2));
    channels = { gutters, lanes };
  }
  const portRects: Record<string, RouteRect & { text: string; dir: 'in' | 'out'; edge: 'top' | 'bottom' }> = {};
  for (const edgeOf of ['top', 'bottom'] as const) {
    const list = ports
      .filter((q) => q.edge === edgeOf && q.inner.some((id) => rects[id]))
      .map((q) => {
        const r = rects[q.inner.find((id) => rects[id])!]!;
        const text = portText(model, q.outer);
        return { q, text, w: Math.min(320, textWidth(text, FONTS.port) + 4), cx: r.x + r.w / 2, x: 0 };
      })
      .sort((a, b) => a.cx - b.cx);
    let edge = fieldX;
    for (const it of list) {
      it.x = Math.max(edge, Math.min(xr - it.w, it.cx - it.w / 2));
      edge = it.x + it.w + 18;
    }
    let over = list.length ? list[list.length - 1]!.x + list[list.length - 1]!.w - xr : 0;
    for (let i = list.length - 1; i >= 0 && over > 0; i--) {
      const it = list[i]!;
      const room = i ? it.x - (list[i - 1]!.x + list[i - 1]!.w + 18) : it.x - fieldX;
      const d = Math.min(over, Math.max(0, room));
      for (let j = i; j < list.length; j++) list[j]!.x -= d;
      over -= d;
    }
    for (const it of list) {
      const y0 = edgeOf === 'top' ? FIELD_TOP + 4 : portBottomY;
      portRects['port:' + it.q.id] = { x: it.x, y: y0, w: it.w, h: 16, text: it.text, dir: it.q.dir, edge: edgeOf };
    }
  }
  for (const q of ports) {
    const pid = 'port:' + q.id;
    if (!portRects[pid]) continue;
    const f = model.flows[q.id]!;
    const o = overlayLine({ says: sheet.says[q.id] ?? f.says, line: lineOfFlow(model, q.id) }, f, model, q.id, OV);
    flows.push({
      id: q.id, from: q.dir === 'in' ? [pid] : q.inner.filter((id) => rects[id]), to: q.dir === 'in' ? q.inner[0]! : pid,
      both: f.both, says: o.says, quiet: sheet.quiet.includes(q.id), line: o.line, tails: o.tails, portOf: { from: f.from, to: f.to },
    });
    routeRects[pid] = portRects[pid]!;
    obstacles.push({ x: portRects[pid]!.x, y: portRects[pid]!.y, w: portRects[pid]!.w, h: portRects[pid]!.h });
  }
  const routes = routeAll(flows, routeRects, obstacles, bounds, containerOf, {
    dense, env: env.x0 < 1e9 ? env : null, bandBoxes, strips, risers, channels, heads: [...bandHeads, ...splitHeads],
  });
  const notesOn: Record<string, string> = Object.fromEntries(sheet.notes.filter((n) => flows.some((f) => f.id === n.on)).map((n) => [n.on, n.l]));
  const edges: Edge[] = flows
    .filter((f) => routes[f.id])
    .map((f) => {
      const e: Edge = {
        id: f.id, from: f.from, to: f.to, both: f.both, says: f.says, quiet: f.quiet, status: null, line: f.line, tails: f.tails,
        ...(f.fan ? { fan: f.fan } : {}), ...routes[f.id], letter: notesOn[f.id] ?? null, flow: f.fan ? null : f.id,
      };
      if (f.portOf) {
        const pid = f.from[0]?.startsWith('port:') ? f.from[0] : f.to;
        const pr = portRects[pid]!;
        e.port = { x: pr.x, y: pr.y, w: pr.w, h: pr.h, text: pr.text, dir: pr.dir, edge: pr.edge };
        e.from = f.portOf.from;
        e.to = f.portOf.to;
      }
      return e;
    });
  const labels = placeLabels({
    edges, parts: Object.values(rects), dense, zones, strict: !dense,
    lines: splits.map((q): [Pt, Pt] => [[q.x, q.y0], [q.x, q.y1]]),
    blocks: [header, ...callouts.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })), ...bandHeads, ...splitHeads],
    soft: zones.filter((z) => z.label).map((z) => ({ x: z.x, y: z.y, w: z.w, h: HEAD })),
    bounds: { x0: M - 30, y0: FIELD_TOP - 20, x1: W - M + 30, y1: fieldBottom + 30 },
  });
  for (const e of edges) e.lb = labels[e.id] ?? null;

  for (const c of callouts) edges.push({ id: c.id, from: [], to: c.to, says: '', quiet: false, status: null, line: null, letter: null, pts: c.arrow, style: 'aud' });

  const taken: Rect[] = Object.values(labels).filter((l) => !l.hidden);
  for (const p of Object.values(parts)) {
    if (!(p.v === 'window' || p.cw)) continue;
    taken.push({ x: p.x + p.w - 26, y: p.y - 26, w: 52, h: 52 }, { x: p.x + p.w - 16, y: p.y + p.h - 16, w: 32, h: 32 });
    if (p.cw) taken.push({ x: p.x, y: p.y + p.h - 28, w: 140, h: 28 });
  }
  const letters = placeLetters(sheet.notes.filter((n) => rects[n.on]), rects, taken);
  // a note on a quiet line, or on a line whose label found no room, keeps its
  // letter on the line itself (middle of the longest segment) so it never vanishes
  for (const e of edges) {
    if (!e.letter || !e.pts || (!e.quiet && e.lb && !e.lb.hidden)) continue;
    let best: Pt | null = null, bl = -1;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [ax, ay] = e.pts[i]!, [bx, by] = e.pts[i + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len > bl) {
        bl = len;
        best = [(ax + bx) / 2, (ay + by) / 2];
      }
    }
    if (best) letters.push({ l: e.letter, x: best[0], y: best[1], on: e.id });
    e.letter = null;
  }

  return {
    id: code, kind: sheet.kind, scope: sheet.scope, w: W, h: H, title: sheet.title, question: sheet.question,
    parts, zones, edges, letters, splits, callouts: callouts.map(({ arrow: _a, ...c }) => c), figures: [],
    notes: sheet.notes, natural, dense, simple: SIMPLE, compact: !!opts.compact,
  };
}

export type SystemLayouts = {
  /** Every sheet laid out in its full form, windows open. */
  sheets: Record<string, SheetLayout>;
  /** The at-rest form of every sheet that has windows: each window a plain box with its cue. */
  compact: Record<string, SheetLayout>;
  childH: Record<string, number>;
};

export function layoutSystem(model: SystemModel, how: { simple?: boolean | Set<string>; overlays?: string[] } = {}): SystemLayouts {
  const sheets: Record<string, SheetLayout> = {}, compact: Record<string, SheetLayout> = {}, childH: Record<string, number> = {};
  const simpleIn = (sc: string) => how.simple === true || (how.simple instanceof Set && how.simple.has(sc || 'root'));
  const so = (c: string): LayoutOpts => (simpleIn(model.sheets[c]?.scope ?? 'root') && hasSimple(model, c) ? { simple: true } : { overlays: how.overlays ?? [] });
  const depthOf = (sc: string) => {
    let d = 0;
    for (let q = sc; q && q !== 'root' && d < 50; q = model.parentOf[q] || 'root') d++;
    return d;
  };
  const scopes = Object.keys(model.byScope).sort((a, b) => depthOf(b) - depthOf(a));
  for (const scope of scopes) {
    const codes = model.byScope[scope]!.filter((c) => model.sheets[c]);
    if (!codes.length) continue;
    const nat: Record<string, number> = {};
    for (const c of codes) nat[c] = layoutSheet(model, c, { childH, ...so(c) }).natural;
    childH[scope] = nat[codes[0]!]!;
    for (const c of codes) sheets[c] = layoutSheet(model, c, { H: nat[c], childH, ...so(c) });
    for (const c of codes) {
      if (!Object.values(sheets[c]!.parts).some((q) => q.v === 'window')) continue;
      compact[c] = restLayout(model, c, { ...so(c), childH });
    }
  }
  return { sheets, compact, childH };
}

export function restLayout(model: SystemModel, code: string, opts: { simple?: boolean; overlays?: string[]; childH?: Record<string, number> } = {}): SheetLayout {
  const o: LayoutOpts = { compact: true, simple: !!opts.simple && hasSimple(model, code), overlays: opts.overlays ?? [], childH: opts.childH };
  const nat = layoutSheet(model, code, o).natural;
  return layoutSheet(model, code, { ...o, H: nat });
}
