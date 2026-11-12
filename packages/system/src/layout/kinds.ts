import type { Payload, Sheet, SystemModel } from '../format/types.ts';
import { FIELD_TOP, FOOT_H, M, outerTest, versionOf, W } from './common.ts';
import { placeLetters } from './labels.ts';
import { balance, FONTS, lh, textWidth, wrap } from './measure.ts';
import type { Edge, Figure, PartBox, Pt, Rect, SheetLayout, Zone } from './types.ts';

export type KindOpts = { H?: number };

const partOut = (r: Omit<PartBox, 'marks' | 'status'>, marks: string[]): PartBox => ({ ...r, marks, status: null });

function finish(
  sheet: Sheet,
  code: string,
  opts: KindOpts,
  o: { parts: Record<string, PartBox>; zones?: Zone[]; edges?: Edge[]; figures?: Figure[]; fieldBottom: number; rects: Record<string, Rect> },
): SheetLayout {
  const natural = o.fieldBottom + FOOT_H;
  const H = Math.max(opts.H ?? 0, natural);
  const letters = placeLetters(sheet.notes.filter((n) => o.rects[n.on]), o.rects, []);
  return {
    id: code, kind: sheet.kind, scope: sheet.scope, w: W, h: H, title: sheet.title, question: sheet.question,
    parts: o.parts, zones: o.zones ?? [], edges: o.edges ?? [], letters, splits: [], callouts: [], figures: o.figures ?? [],
    notes: sheet.notes, natural, dense: false, simple: false, compact: false,
  };
}

function boxOf(pl: Payload, maxW: number) {
  const lines = pl.lines.map(String);
  const title = String(pl.name || pl.title || '');
  const tw = textWidth(title, FONTS.monoT);
  const lw = Math.max(0, ...lines.map((l) => textWidth(l, FONTS.mono)));
  const w = Math.min(maxW, Math.max(tw, lw) + 24);
  return { title, lines, by: pl.by || null, w, h: 10 + (title ? lh(17) : 0) + lines.length * lh(15.5) + 8 };
}

function laneSub(name: string, marks: string[], sub: string, w: number): string {
  if (!sub) return '';
  const need = 28 + (marks.length ? 28 : 0) + textWidth(name, FONTS.laneName) + 12 + textWidth(sub, FONTS.laneSub);
  return need <= w ? sub : '';
}

function flowSheet(model: SystemModel, code: string, opts: KindOpts): SheetLayout {
  const sheet = model.sheets[code]!;
  const P = model.parts;
  const isOuter = outerTest(model, sheet.scope);
  const lanes0 = sheet.lanes.filter((id) => P[id]);
  const half = (lanes0.length - 1) / 2;
  const lanes = [
    ...lanes0.filter((id, i) => isOuter(id) && i <= half),
    ...lanes0.filter((id) => !isOuter(id)),
    ...lanes0.filter((id, i) => isOuter(id) && i > half),
  ];
  const places = sheet.places.map((pl) => ({ ...pl, lanes: pl.lanes.filter((l) => !isOuter(l)) })).filter((pl) => pl.lanes.length);
  const TIME_W = 78;
  const x0 = M + TIME_W, x1 = W - M;
  const wt = (id: string) => (isOuter(id) ? 0.75 : 1);
  const unit = (x1 - x0) / Math.max(1, lanes.reduce((a, id) => a + wt(id), 0));
  const lx: Record<string, number> = {}, laneW: Record<string, number> = {};
  {
    let acc = x0;
    for (const id of lanes) {
      laneW[id] = unit * wt(id);
      lx[id] = acc + laneW[id]! / 2;
      acc += laneW[id]!;
    }
  }
  const headY = FIELD_TOP + (places.length ? 44 : 4);
  const HEAD_H = 50;
  const parts: Record<string, PartBox> = {}, rects: Record<string, Rect> = {};
  const margins: Figure[] = [];
  for (const id of lanes) {
    const p = P[id]!;
    if (isOuter(id)) {
      margins.push({ id: 'margin:' + id, type: 'text', x: lx[id]! - laneW[id]! / 2 + 4, y: headY + 16, w: laneW[id]! - 8, text: p.name, cls: 'fig-port' });
      continue;
    }
    const w = laneW[id]! - 30;
    const marks = p.marks.slice(0, 1);
    rects[id] = { x: lx[id]! - w / 2, y: headY, w, h: HEAD_H };
    parts[id] = partOut({ ...rects[id]!, v: 'lane', sub: laneSub(p.name, marks, p.sub, w) }, marks);
  }

  const figures: Figure[] = [], edges: Edge[] = [];
  const boxes: Rect[] = [];
  const skyAt = (a: number, b: number) => boxes.reduce((m, r) => (r.x < b && r.x + r.w > a ? Math.max(m, r.y + r.h) : m), 0);
  let lastY = headY + HEAD_H + 6;
  const notesOn: Record<string, string> = Object.fromEntries(sheet.notes.map((n) => [n.on, n.l]));
  const ticks: { y: number; at: string }[] = [];
  const lineH = lh(16);

  sheet.hops.forEach((h, i) => {
    const hid = h.id || `h${i + 1}`;
    const id = `${code}.${hid}`;
    if (h.on) {
      if (lx[h.on] == null) return;
      const t = wrap(h.do || '', FONTS.stepSub, laneW[h.on]! - 60);
      const tw = Math.min(laneW[h.on]! - 36, Math.max(...t.lines.map((l) => textWidth(l, FONTS.stepSub))) + 26);
      const bh = t.lines.length * lineH + 12;
      const x = lx[h.on]! - tw / 2;
      const y = Math.max(lastY + 16, skyAt(x - 6, x + tw + 6) + 12);
      const box = { x, y, w: tw, h: bh };
      boxes.push(box);
      figures.push({ id, type: 'step', ...box, lines: t.lines, letter: notesOn[hid] ?? null, status: null });
      if (h.at) ticks.push({ y: y + bh / 2, at: h.at });
      lastY = y + bh / 2;
      return;
    }
    if (!h.from || !h.to || lx[h.from] == null || lx[h.to] == null) return;
    const xa = lx[h.from]!, xb = lx[h.to]!;
    const right = xb > xa;
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
    const span = hi - lo;
    const lab = balance(h.says || '', FONTS.label, Math.max(80, span - 34), 2);
    const letter = notesOn[hid] ?? null;
    const lw = lab.width + 6 + (letter ? 24 : 0), lbh = lab.lines.length * lineH + 2;
    const labX = right ? xa + 10 : xa - 10 - lw;
    const pl = h.payload ? boxOf(h.payload, Math.max(120, span - 28)) : null;
    const y = Math.max(lastY + 24, skyAt(lo - 2, hi + 2) + 12, skyAt(labX - 4, labX + lw + 4) + lbh + 10);
    const pts: Pt[] = [[xa, y], [xb, y]];
    const lb = { x: labX, y: y - lbh - 3, w: lw, h: lbh, lines: lab.lines };
    boxes.push({ x: lo, y: y - 3, w: span, h: 6 }, lb);
    if (pl) {
      const px = right ? xa + 12 : xa - 12 - pl.w;
      const pbox = { x: px, y: y + 9, w: pl.w, h: pl.h };
      boxes.push({ ...pbox, h: pbox.h + 4 });
      figures.push({ id: id + ':p', type: 'payload', ...pbox, title: pl.title, lines: pl.lines, edge: id, status: null });
    }
    edges.push({
      id, from: [h.from], to: h.to, says: h.says || '', pts, lb, quiet: false, letter,
      status: null, line: null, dash: h.reply ? '5 4' : null, flow: h.flow,
    });
    if (h.at) ticks.push({ y, at: h.at });
    lastY = y;
  });

  const fieldBottom = Math.max(lastY, ...boxes.map((b) => b.y + b.h)) + 30;
  for (const id of [...lanes].reverse())
    figures.unshift({ id: 'life:' + id, type: 'lifeline', under: true, x: lx[id]!, y0: headY + (isOuter(id) ? 26 : HEAD_H), y1: fieldBottom - 6, faint: isOuter(id) });
  figures.push(...margins);
  figures.push({ id: 'time:h', type: 'text', x: M, y: headY + 14, w: TIME_W - 10, text: sheet.time || 'time', cls: 'fig-timeh' });
  figures.push({ id: 'time:axis', type: 'vline', under: true, x: M + TIME_W - 16, y0: headY + 34, y1: fieldBottom - 6, arrow: true });
  // ticks never overlap: a tick too close to the one above moves down
  ticks.sort((a, b) => a.y - b.y).forEach((t, k) => {
    if (k && t.y < ticks[k - 1]!.y + 17) t.y = ticks[k - 1]!.y + 17;
  });
  ticks.forEach((t, k) => figures.push({ id: 'tick' + k, type: 'tick', x: M, y: t.y, w: TIME_W - 22, at: t.at, status: null }));

  const zones: Zone[] = [];
  places.forEach((pl, k) => {
    const ls = pl.lanes.filter((l) => lx[l] != null);
    if (!ls.length) return;
    const a = Math.min(...ls.map((l) => lx[l]! - laneW[l]! / 2)) + 5, b = Math.max(...ls.map((l) => lx[l]! + laneW[l]! / 2)) - 5;
    zones.push({ id: 'place' + k, x: a, y: FIELD_TOP, w: b - a, h: fieldBottom - FIELD_TOP, label: pl.label, means: pl.means, tone: pl.tone || 'stone', marks: pl.marks, band: true });
  });
  return finish(sheet, code, opts, { parts, zones, edges, figures, fieldBottom, rects });
}

function landscapeSheet(model: SystemModel, code: string, opts: KindOpts): SheetLayout {
  const sheet = model.sheets[code]!;
  const P = model.parts;
  const cols = sheet.columns;
  const GAP = 22, PAD = 14, TG = 10, TILE_MIN = 120, TILE_H = lh(116), HEAD = 44;
  const n = Math.max(1, cols.length);
  const colW = (W - M * 2 - (n - 1) * GAP) / n;
  const per = Math.max(1, Math.floor((colW - PAD * 2 + TG) / (TILE_MIN + TG)));
  const tw = (colW - PAD * 2 - (per - 1) * TG) / per;
  const parts: Record<string, PartBox> = {}, rects: Record<string, Rect> = {};
  let deepest = 0;
  const figures: Figure[] = [];
  const usedCount = (id: string) => P[id]?.usedBy.length ?? 0;
  const noteH = lh(18.5);
  let tileH = TILE_H;
  if (opts.H) {
    const rowsMax = Math.max(1, ...cols.map((c) => Math.ceil(c.row.filter((id) => P[id]).length / per)));
    const noteMax = Math.max(0, ...cols.map((c) => (c.says ? 12 + wrap(c.says, FONTS.note, colW - PAD * 2).lines.length * noteH : 0)));
    const room = opts.H - FOOT_H - FIELD_TOP - HEAD - PAD - noteMax - 16 - 40;
    tileH = Math.max(TILE_H, Math.min(lh(156), Math.floor(room / rowsMax - TG)));
  }
  const showFor = tileH >= lh(140);
  cols.forEach((c, ci) => {
    const cx = M + ci * (colW + GAP);
    const ids = c.row.filter((id) => P[id]);
    ids.forEach((id, k) => {
      const r = Math.floor(k / per), q = k % per;
      const used = usedCount(id);
      const rr = { x: cx + PAD + q * (tw + TG), y: FIELD_TOP + HEAD + r * (tileH + TG), w: tw, h: tileH };
      rects[id] = rr;
      const ver = versionOf(P[id]!.facts);
      const sub = [ver, used ? `${used} part${used > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || null;
      parts[id] = partOut({ ...rr, v: showFor ? 'tilefor' : 'tile', sub }, P[id]!.marks.slice(0, 1));
    });
    const rows = Math.ceil(ids.length / per);
    let bottom = FIELD_TOP + HEAD + rows * (tileH + TG) - TG + PAD;
    if (c.says) {
      const t = wrap(c.says, FONTS.note, colW - PAD * 2);
      figures.push({ id: 'colnote' + ci, type: 'text', x: cx + PAD, y: bottom + 6, w: colW - PAD * 2, text: c.says, cls: 'fig-colnote' });
      bottom += 12 + t.lines.length * noteH;
    }
    deepest = Math.max(deepest, bottom);
  });
  const fieldBottom = deepest + 16;
  const zones: Zone[] = cols.map((c, ci) => ({
    id: 'col' + ci, x: M + ci * (colW + GAP), y: FIELD_TOP, w: colW, h: fieldBottom - FIELD_TOP,
    label: c.label, means: c.means, tone: c.tone || 'stone', marks: c.marks, band: true,
  }));
  return finish(sheet, code, opts, { parts, zones, figures, fieldBottom, rects });
}

function algorithmSheet(model: SystemModel, code: string, opts: KindOpts): SheetLayout {
  const sheet = model.sheets[code]!;
  const P = model.parts;
  const LW = 392;
  const SX = M + LW + 210;
  const SW = 300;
  const EX = SX + SW / 2 + 74, EW = 214;
  const CW = 268, CX = W - M - CW;
  const parts: Record<string, PartBox> = {}, rects: Record<string, Rect> = {}, figures: Figure[] = [], edges: Edge[] = [];
  const notesOn: Record<string, string> = Object.fromEntries(sheet.notes.map((n) => [n.on, n.l]));
  const L16 = lh(16), L18 = lh(18), L15 = lh(15), L17 = lh(17);

  const isOuter = outerTest(model, sheet.scope);
  const ep0 = sheet.endpoint && P[sheet.endpoint] ? sheet.endpoint : null;
  const ep = ep0 && !isOuter(ep0) ? ep0 : null;
  let y = FIELD_TOP + 4;
  let entry: Rect | null = null;
  if (ep0 && !ep) {
    const text = sheet.route || P[ep0]!.sub || '';
    const ew = Math.min(SW + 80, textWidth(text, FONTS.mono) + 40);
    entry = { x: SX - ew / 2, y, w: ew, h: 34 };
    if (text) figures.push({ id: 'entry', type: 'term', ...entry, lines: [text], code: null, mono: true });
    y += 34;
  }
  if (ep) {
    const bw = EX + EW - (SX - SW / 2 - 40);
    const p = P[ep]!;
    const marks = p.marks.slice(0, 1);
    rects[ep] = { x: SX - SW / 2 - 40, y, w: bw, h: 50 };
    parts[ep] = partOut({ ...rects[ep]!, v: 'lane', sub: laneSub(p.name, marks, sheet.route || p.sub, bw) }, marks);
    y += 50;
  }
  let prev = { x: SX, y };
  const arrow = (from: { x: number; y: number }, to: { x: number; y: number }, label: string | null) =>
    figures.push({ id: 'sp' + figures.length, type: 'arrow', pts: [[from.x, from.y], [to.x, to.y]], label });
  let pendingLabel: string | null = null;
  let calledLast = 0;
  sheet.steps.forEach((st, i) => {
    const sid = st.id || `s${i + 1}`;
    const id = `${code}.${sid}`;
    const letter = notesOn[sid] ?? null;
    if (st.if) {
      const t = wrap(st.if, FONTS.stepSub, 150);
      const dh = Math.max(70, t.lines.length * L16 + 40), dw = 236;
      const top = y + 30;
      arrow(prev, { x: SX, y: top }, pendingLabel);
      figures.push({ id, type: 'diamond', x: SX - dw / 2, y: top, w: dw, h: dh, lines: t.lines, letter });
      const cy = top + dh / 2;
      const no = Array.isArray(st.no) ? st.no[0] : st.no;
      if (no) {
        const exo = typeof no === 'object' ? (no as { end?: unknown; code?: unknown }) : null;
        const words = String(exo ? (exo.end ?? '') : no);
        const et = wrap(words, FONTS.stepSub, EW - 30);
        const eh = et.lines.length * L16 + 14;
        figures.push({ id: id + ':no', type: 'term', x: EX, y: cy - eh / 2, w: EW, h: eh, lines: et.lines, code: exo?.code ? [String(exo.code)] : null, bad: true });
        arrow({ x: SX + dw / 2, y: cy }, { x: EX, y: cy }, st.no_says || 'no');
      }
      prev = { x: SX, y: top + dh };
      pendingLabel = st.yes_says || 'yes';
      y = top + dh;
      return;
    }
    if (st.end) {
      const t = wrap(st.end, FONTS.step, SW - 40 - 34);
      const th = t.lines.length * L18 + 16;
      const top = y + 30;
      arrow(prev, { x: SX, y: top }, pendingLabel);
      figures.push({ id, type: 'term', x: SX - (SW - 40) / 2, y: top, w: SW - 40, h: th, lines: t.lines, code: st.code ? [st.code] : null, letter });
      prev = { x: SX, y: top + th };
      pendingLabel = null;
      y = top + th;
      if (sheet.metric) {
        const my = top + th / 2;
        figures.push({ id: 'metric', type: 'arrow', pts: [[SX + (SW - 40) / 2, my], [CX - 24, my]], label: null, heavy: true });
        figures.push({ id: 'metric:t', type: 'text', x: SX + (SW - 40) / 2 + 16, y: my + 6, w: CX - SX - 40, text: sheet.metric, cls: 'fig-metric' });
      }
      return;
    }
    const t = wrap(st.do || '', FONTS.step, SW - 28);
    const codeLines = st.code ? wrap(st.code, FONTS.mono, SW - 28).lines : [];
    const bh = 12 + t.lines.length * L18 + (codeLines.length ? 6 + codeLines.length * L15 : 0) + 10;
    const top = y + 30;
    arrow(prev, { x: SX, y: top }, pendingLabel);
    figures.push({ id, type: 'step', strong: true, x: SX - SW / 2, y: top, w: SW, h: bh, lines: t.lines, code: codeLines, letter });
    const called = st.calls && P[st.calls] ? st.calls : null;
    if (called && isOuter(called)) {
      const cy = top + bh / 2;
      const says = st.says || (st.flow ? model.flows[st.flow]?.says : '') || '';
      const xe = W - M - 4;
      const lab = balance(says, FONTS.label, xe - (SX + SW / 2) - 40, 2);
      const lbh = lab.lines.length * L16 + 2;
      edges.push({
        id: id + ':call', from: [ep0 || called], to: called, says, pts: [[SX + SW / 2, cy], [xe, cy]], quiet: false, letter: null,
        lb: { x: SX + SW / 2 + 14, y: cy - lbh - 3, w: lab.width + 6, h: lbh, lines: lab.lines },
        status: null, line: null, flow: st.flow,
        port: { x: xe - 220, y: cy + 6, w: 220, h: 16, text: P[called]!.name, dir: 'out', edge: 'right' },
      });
    } else if (called) {
      const cy = top + bh / 2;
      if (!rects[called]) {
        const cp = P[called]!;
        const ph = cp.sub ? 54 : Math.max(54, Math.ceil(8 + 20 + 4 + Math.min(3, wrap(cp.role || '', FONTS.boxRole, CW - 26).lines.length) * L17 + 11));
        const ry = Math.max(cy - ph / 2, calledLast + 16);
        rects[called] = { x: CX, y: ry, w: CW, h: ph };
        parts[called] = partOut({ ...rects[called]!, v: 'box' }, cp.marks.slice(0, 1));
        calledLast = ry + ph;
      }
      const r = rects[called]!;
      const ly = Math.min(Math.max(cy, r.y + 14), r.y + r.h - 14);
      const says = st.says || (st.flow ? model.flows[st.flow]?.says : '') || '';
      const lab = balance(says, FONTS.label, CX - (SX + SW / 2) - 40, 2);
      const lbh = lab.lines.length * L16 + 2;
      const mx = (SX + SW / 2 + CX) / 2;
      const pts: Pt[] = ly === cy ? [[SX + SW / 2, cy], [CX, cy]] : [[SX + SW / 2, cy], [mx, cy], [mx, ly], [CX, ly]];
      edges.push({
        id: id + ':call', from: [sheet.endpoint || called], to: called, says, pts, quiet: false, letter: null,
        lb: { x: SX + SW / 2 + 14, y: cy - lbh - 3, w: lab.width + 6, h: lbh, lines: lab.lines },
        status: null, line: null, flow: st.flow,
      });
    }
    prev = { x: SX, y: top + bh };
    pendingLabel = null;
    y = top + bh;
  });
  let fieldBottom = y + 24;

  let ly = FIELD_TOP + 4;
  if (sheet.loads) {
    const Ld = sheet.loads;
    const t = wrap(Ld.what || '', FONTS.step, LW - 30);
    const cmd = Ld.cmd ? wrap(Ld.cmd, FONTS.mono, LW - 30).lines : [];
    const h = 12 + 16 + t.lines.length * L18 + (cmd.length ? 6 + cmd.length * L15 : 0) + 12;
    figures.push({ id: 'loads', type: 'load', x: M, y: ly, w: LW, h, when: Ld.when || 'At start', lines: t.lines, code: cmd, size: Ld.size || null });
    if (ep) figures.push({ id: 'loads:a', type: 'arrow', pts: [[M + LW, ly + 24], [rects[ep]!.x, ly + 24]], label: null, dashed: true });
    else if (entry) figures.push({ id: 'loads:a', type: 'arrow', pts: [[M + LW, entry.y + entry.h / 2], [entry.x, entry.y + entry.h / 2]], label: null, dashed: true });
    ly += h + 26;
  }
  for (const k of ['request', 'response'] as const) {
    const s = sheet[k];
    if (!s) continue;
    const b = boxOf(s, LW);
    figures.push({ id: k, type: 'payload', x: M, y: ly, w: LW, h: b.h, title: b.title, lines: b.lines, schema: true });
    ly += b.h + 22;
  }
  fieldBottom = Math.max(fieldBottom, ly, ...Object.values(rects).map((r) => r.y + r.h + 20));
  return finish(sheet, code, opts, { parts, edges, figures, fieldBottom, rects });
}

export const KINDS: Record<string, { field: 'lanes' | 'columns' | 'steps'; compose: (model: SystemModel, code: string, opts: KindOpts) => SheetLayout }> = {
  flow: { field: 'lanes', compose: flowSheet },
  landscape: { field: 'columns', compose: landscapeSheet },
  algorithm: { field: 'steps', compose: algorithmSheet },
};
