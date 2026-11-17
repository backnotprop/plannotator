/**
 * Lay an agent's board HTML out with the browser's own engine and lift it into Excalidraw elements at the measured
 * places ("HTML in, canvas out"). Runs in a page (the Inbox window), never on a server: real fonts, real text widths,
 * wrapping and flex are the point. It needs no Excalidraw code: it makes plain element objects, which the canvas
 * restores when it loads them.
 *
 * - Every part keeps the id the agent wrote: its main element has that id (a painted box, a picture, or the words of
 *   an unpainted <p>), its other elements `id~…`, and every element carries `customData.part`. A container is an
 *   Excalidraw group named by its id, so the person drags a row with everything in it, and a layout-only container
 *   (no paint) still keeps its id. One an arrow names gets an invisible box to hold the arrow.
 * - Arrows bind to any part with an id, words included, and run straight when that crosses no words, else as an
 *   elbow above or below the target. Notes sit beside their target, level with it, clear of arrows; in a diagram
 *   joined by arrows, below the target.
 * - The person's pins (parts they moved or resized) keep their place and size: the layout gives them that size and
 *   moves them to where the person left them before arrows are routed.
 * - Warnings name the part and what to change, as in the clean-room tool (fake-cli/render.cjs), which this ports.
 */
import type { BoardPin } from "@plannotator/core/canvas-board";
import type { CanvasElement, CanvasParts, CanvasPartInfo } from "@plannotator/core/canvas-scene";

/** The board's colours: the agent writes only these variables. Light; the canvas inverts for dark. */
export const CANVAS_BOARD_COLOURS: Record<string, string> = {
  ink: "#1f2328",
  muted: "#6b7280",
  paper: "#ffffff",
  sunk: "#f3f4f6",
  rule: "#e5e7eb",
  blue: "#2563eb",
  "blue-soft": "#dbeafe",
  green: "#16a34a",
  "green-soft": "#dcfce7",
  amber: "#d97706",
  "amber-soft": "#fef3c7",
  red: "#dc2626",
  "red-soft": "#fee2e2",
};

/** Excalidraw's Helvetica (FONT_FAMILY.Helvetica): a system font, so no font file is fetched for the agent's words. */
export const CANVAS_AGENT_FONT_FAMILY = 2;
const FONT = "Helvetica, Arial, sans-serif";

export interface LiftInput {
  board: string;
  pins?: Record<string, BoardPin>;
  /** The address a stored picture loads from (`files/<name>` in the board). */
  pictureUrl: (name: string) => string;
}

export interface LiftResult {
  elements: CanvasElement[];
  /** Pictures by file id (the stored file's name). */
  files: Record<string, { name: string; mimeType: string }>;
  warnings: string[];
  parts: CanvasParts;
}

type R = { x: number; y: number; w: number; h: number; r: number; b: number };

const STYLE = (root: string) => `
.${root}{${Object.entries(CANVAS_BOARD_COLOURS).map(([k, v]) => `--${k}:${v}`).join(";")};position:absolute;left:0;top:0;display:flex;gap:64px;align-items:flex-start;padding:40px;width:max-content;background:var(--paper);font:15px ${FONT};color:var(--ink);line-height:1.25;-webkit-font-smoothing:antialiased}
.${root} *{box-sizing:border-box}.${root} p{margin:0}.${root} i{display:block;flex:none}.${root} img{display:block;object-fit:contain;max-width:none}
.${root} a[data-arrow]{display:none}
.${root} aside[data-note]{display:block;width:220px;padding:12px 16px;background:var(--amber-soft);border:1px solid var(--amber);font-size:14px}
.${root} [data-frame]{border:2px solid var(--ink);overflow:hidden;background:var(--paper);display:flex;flex-direction:column;flex:none}
.${root} [data-frame=phone]{width:375px;min-height:760px;border-radius:28px}
.${root} [data-frame=tablet]{width:768px;min-height:1000px;border-radius:24px}
.${root} [data-frame=browser]{width:1280px;min-height:800px;border-radius:10px;border-top-width:28px}
.${root} .cv-slot{display:flex;gap:40px;align-items:flex-start}.${root} .cv-notes{display:flex;flex-direction:column;width:220px;flex:none}
.${root} .cv-lbl{position:absolute;font:13px ${FONT};padding:1px 4px;white-space:nowrap}
`;

const AT: Record<string, [number, number]> = {
  "top-left": [1 / 6, 1 / 6], top: [0.5, 1 / 6], "top-right": [5 / 6, 1 / 6], left: [1 / 6, 0.5], center: [0.5, 0.5], right: [5 / 6, 0.5],
  "bottom-left": [1 / 6, 5 / 6], bottom: [0.5, 5 / 6], "bottom-right": [5 / 6, 5 / 6],
};

const hex = (c: string): string | null => {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c.trim());
  if (!m) return c === "transparent" ? null : c;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
};

let seq = 0;
const nonce = () => (Math.floor(Math.random() * 2 ** 31) ^ ++seq) >>> 0;

function base(type: string, id: string, part: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): CanvasElement {
  return {
    id,
    type,
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    width: Math.round(w * 10) / 10,
    height: Math.round(h * 10) / 10,
    angle: 0,
    strokeColor: CANVAS_BOARD_COLOURS.ink,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    customData: { part },
    ...extra,
  };
}

/** Lay the board out in `doc` and lift it. The host it lays out in is removed before this returns. */
export async function liftBoard(input: LiftInput, doc: Document = document): Promise<LiftResult> {
  const root = `cv${Math.random().toString(36).slice(2, 8)}`;
  const host = doc.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-100000px;top:0;width:0;height:0;overflow:visible;pointer-events:none;contain:layout style";
  const style = doc.createElement("style");
  style.textContent = STYLE(root);
  const cv = doc.createElement("div");
  cv.className = root;
  // The board was checked by its rules before it was stored: only the board's elements and inline styles are in it.
  cv.innerHTML = input.board.replace(/src="files\/([^"]+)"/g, (_m, name: string) => `src="${input.pictureUrl(name).replace(/"/g, "&quot;")}" data-file="${name}"`);
  host.append(style, cv);
  doc.body.append(host);
  try {
    await Promise.all([...cv.querySelectorAll("img")].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
    return layOut(cv, input.pins ?? {});
  } finally {
    host.remove();
  }
}

function layOut(cv: HTMLElement, pins: Record<string, BoardPin>): LiftResult {
  const doc = cv.ownerDocument;
  const W: string[] = [];
  const kids = [...cv.children] as HTMLElement[];
  const arrows = [...cv.querySelectorAll<HTMLElement>("a[data-arrow]")];
  const notes = kids.filter((k) => k.matches("aside[data-note]"));
  const pieces = kids.filter((k) => !notes.includes(k) && !k.matches("a[data-arrow]"));
  const byId = (id: string | null) => (id ? (cv.querySelector(`[id="${CSS.escape(id)}"]`) as HTMLElement | null) : null);
  const slots = new Map<HTMLElement, HTMLElement>();
  for (const p of pieces) {
    const slot = doc.createElement("div");
    slot.className = "cv-slot";
    cv.insertBefore(slot, p);
    slot.append(p);
    if (p.style.alignSelf) slot.style.alignSelf = p.style.alignSelf;
    const col = doc.createElement("div");
    col.className = "cv-notes";
    slot.append(col);
    slots.set(slot, col);
  }
  // A note goes beside its target; with painted parts between the target and the right margin, in a diagram, it
  // goes in a band under the target's part instead, lined up under the target.
  const under = new Map<HTMLElement, HTMLElement[]>();
  for (const n of notes) {
    const t = byId(n.dataset.note ?? null);
    const slot = t?.closest<HTMLElement>(".cv-slot");
    if (!t || !slot) {
      cv.append(n);
      continue;
    }
    const piece = slot.firstElementChild as HTMLElement;
    const tr = t.getBoundingClientRect();
    const between = [...piece.querySelectorAll<HTMLElement>("[id]")].some((e) => {
      if (e === t || e.contains(t) || t.contains(e)) return false;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      const painted = e.children.length === 0 || cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0;
      return painted && r.left >= tr.right - 1 && r.top < tr.bottom && r.bottom > tr.top;
    });
    const diagram = arrows.some((a) => {
      const f = byId(a.getAttribute("from"));
      const g = byId(a.getAttribute("to"));
      return !!f && !!g && piece.contains(f) && piece.contains(g);
    });
    if (between && diagram) {
      if (!under.has(slot)) under.set(slot, []);
      under.get(slot)!.push(n);
    } else slots.get(slot)!.append(n);
  }
  for (const [slot, ns] of under) {
    slot.style.flexDirection = "column";
    slot.style.gap = "40px";
    const band = doc.createElement("div");
    band.style.cssText = "position:relative;width:100%";
    slot.insertBefore(band, slots.get(slot)!);
    let right = 0;
    const sr = slot.getBoundingClientRect();
    ns.sort((a, b) => byId(a.dataset.note!)!.getBoundingClientRect().left - byId(b.dataset.note!)!.getBoundingClientRect().left);
    for (const n of ns) {
      band.append(n);
      const t = byId(n.dataset.note!)!.getBoundingClientRect();
      const ml = Math.max(0, t.left + t.width / 2 - sr.left - 110 - right);
      n.style.display = "inline-block";
      n.style.verticalAlign = "top";
      n.style.marginLeft = `${ml}px`;
      n.style.marginRight = "16px";
      right += ml + 220 + 16;
    }
  }
  for (const [, col] of slots) if (!col.children.length) col.remove();
  // A part joined by an arrow to a part on its right keeps that gap free: its notes go below it.
  const slotList = [...slots.keys()];
  const slotOf = (id: string | null) => byId(id)?.closest<HTMLElement>(".cv-slot") ?? null;
  for (const a of arrows) {
    const A = slotOf(a.getAttribute("from"));
    const B = slotOf(a.getAttribute("to"));
    if (A && B && A !== B) (slotList.indexOf(A) < slotList.indexOf(B) ? A : B).dataset.below = "1";
  }
  for (const [slot, col] of slots) {
    if (slot.dataset.below && col.isConnected) {
      slot.style.flexDirection = "column";
      slot.style.gap = "32px";
      col.style.flexDirection = "row";
      col.style.width = "auto";
      col.style.gap = "16px";
    }
  }
  const o = () => cv.getBoundingClientRect();
  const R = (el: Element): R => {
    const c = o();
    const r = el.getBoundingClientRect();
    return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height, r: r.right - c.left, b: r.bottom - c.top };
  };
  // Notes level with their targets, never overlapping each other.
  for (const [slot, col] of slots) {
    if (slot.dataset.below || !col.isConnected) continue;
    const ns = [...col.children].map((n) => ({ n: n as HTMLElement, t: byId((n as HTMLElement).dataset.note ?? null)! })).sort((a, b) => R(a.t).y - R(b.t).y);
    let bottom = R(col).y;
    for (const { n, t } of ns) {
      const tr = R(t);
      const h = n.getBoundingClientRect().height;
      const mt = Math.max(0, tr.y + Math.min(tr.h, 120) / 2 - h / 2 - bottom);
      n.style.marginTop = `${mt}px`;
      n.style.marginBottom = "12px";
      bottom = bottom + mt + h + 12;
    }
  }

  // ---- the person's pins: their size, then their place (outer parts first) ----
  const depthOf = (el: Element) => {
    let d = 0;
    for (let p = el.parentElement; p && p !== cv; p = p.parentElement) d++;
    return d;
  };
  const pinned = Object.entries(pins)
    .map(([id, pin]) => ({ el: byId(id), pin, id }))
    .filter((x): x is { el: HTMLElement; pin: BoardPin; id: string } => !!x.el && !x.el.matches("a[data-arrow]"))
    .sort((a, b) => depthOf(a.el) - depthOf(b.el));
  // A pinned part leaves the flow, and a blank box of its laid-out size holds its place, so the size the person gave
  // it never moves the parts around it (a widened button would widen its whole column).
  for (const { el, pin } of pinned) {
    const was = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const hold = el.ownerDocument.createElement("div");
    hold.setAttribute("aria-hidden", "true");
    hold.style.cssText = `display:${cs.display.startsWith("inline") ? "inline-block" : "block"};flex:none;width:${was.width}px;height:${was.height}px;margin:${cs.margin};align-self:${cs.alignSelf}`;
    el.before(hold);
    el.style.position = "absolute";
    el.style.margin = "0";
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.flex = "none";
    const sized = paintedBox(el) || !hasIdChildren(el);
    el.style.width = `${sized && pin.w > 0 ? pin.w : was.width}px`;
    el.style.height = `${sized && pin.h > 0 ? pin.h : was.height}px`;
  }
  for (const { el, pin } of pinned) {
    const now = unionBox(el, R, cv);
    if (!now) continue;
    const dx = pin.x - now.x;
    const dy = pin.y - now.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.style.left = `${(parseFloat(el.style.left) || 0) + dx}px`;
    el.style.top = `${(parseFloat(el.style.top) || 0) + dy}px`;
  }
  const pinnedIds = new Set(pinned.map((p) => p.id));

  // ---- arrows: routed by the engine, never by the agent ----
  type Route = { aid: string; from: string; to: string; pts: [number, number][]; label: string; color: string; note: boolean };
  const routes: Route[] = [];
  const segs: { s: [number, number]; e: [number, number]; aid: string }[] = [];
  const gapHint = (aid: string, need: number) => {
    const a = byId(aid);
    if (!a || !a.matches("a[data-arrow]")) return "";
    const A = byId(a.getAttribute("from"));
    const B = byId(a.getAttribute("to"));
    if (!A || !B) return "";
    let p = A.parentElement;
    while (p && !p.contains(B)) p = p.parentElement;
    const px = Math.ceil(need / 8) * 8;
    const hint = `; put at least ${px}px between #${A.id} and #${B.id}`;
    return p && p.id && p !== cv && !p.classList.contains("cv-slot") ? `${hint} (gap:${px}px on #${p.id})` : hint;
  };
  const hit = (s: [number, number], e: [number, number], q: { x: number; y: number; r: number; b: number }) => {
    for (let k = 0.04; k < 0.96; k += 0.02) {
      const x = s[0] + (e[0] - s[0]) * k;
      const y = s[1] + (e[1] - s[1]) * k;
      if (x > q.x - 1 && x < q.r + 1 && y > q.y - 2 && y < q.b + 2) return true;
    }
    return false;
  };
  const textRects = () => {
    const out: { x: number; y: number; r: number; b: number; owner: string | undefined; el: HTMLElement }[] = [];
    const wk = doc.createTreeWalker(cv, NodeFilter.SHOW_TEXT);
    const c = o();
    for (let t = wk.nextNode(); t; t = wk.nextNode()) {
      if (!t.textContent?.trim()) continue;
      const p = t.parentElement!;
      if (p.closest("a[data-arrow],.cv-lbl,aside")) continue;
      const rg = doc.createRange();
      rg.selectNodeContents(t);
      for (const q of rg.getClientRects()) out.push({ x: q.left - c.left, y: q.top - c.top, r: q.right - c.left, b: q.bottom - c.top, owner: p.closest("[id]")?.id, el: p });
    }
    return out;
  };
  const endsOf = (aid: string): (HTMLElement | null)[] => {
    const a = byId(aid);
    if (!a) return [];
    if (a.matches("a[data-arrow]")) return [byId(a.getAttribute("from")), byId(a.getAttribute("to"))];
    return [a, byId(a.dataset.note ?? null)];
  };
  const labels: { el: HTMLElement; aid: string }[] = [];
  const draw = (A: R, B: R, at: string | null, label: string, color: string, aid: string, from: string, to: string, note: boolean) => {
    let s: [number, number];
    let e: [number, number];
    if (at) {
      const pm = /^(\d+)% (\d+)%$/.exec(at);
      const f = pm ? [Number(pm[1]) / 100, Number(pm[2]) / 100] : AT[at] ?? [0.5, 0.5];
      e = [B.x + B.w * f[0], B.y + B.h * f[1]];
      if (e[0] > A.r) s = [A.r, Math.min(Math.max(e[1], A.y + 6), A.b - 6)];
      else if (e[0] < A.x) s = [A.x, Math.min(Math.max(e[1], A.y + 6), A.b - 6)];
      else if (e[1] > A.b) s = [Math.min(Math.max(e[0], A.x + 6), A.r - 6), A.b];
      else s = [Math.min(Math.max(e[0], A.x + 6), A.r - 6), A.y];
    } else {
      const oy = [Math.max(A.y, B.y), Math.min(A.b, B.b)];
      const ox = [Math.max(A.x, B.x), Math.min(A.r, B.r)];
      if (A.r <= B.x || B.r <= A.x) {
        const right = A.r <= B.x;
        const ya = oy[1] - oy[0] > 8 ? (oy[0] + oy[1]) / 2 : A.y + A.h / 2;
        const yb = oy[1] - oy[0] > 8 ? ya : B.y + B.h / 2;
        s = [right ? A.r : A.x, ya];
        e = [right ? B.x - 3 : B.r + 3, yb];
      } else if (A.b <= B.y || B.b <= A.y) {
        const down = A.b <= B.y;
        const xa = ox[1] - ox[0] > 8 ? (ox[0] + ox[1]) / 2 : A.x + A.w / 2;
        const xb = ox[1] - ox[0] > 8 ? xa : B.x + B.w / 2;
        s = [xa, down ? A.b : A.y];
        e = [xb, down ? B.y - 3 : B.b + 3];
      } else {
        s = [A.r, A.y + A.h / 2];
        e = [B.r + 3, B.y + B.h / 2];
        W.push(`arrow #${aid}: its two ends overlap (one is inside the other); point from a part beside it`);
      }
    }
    let pts: [number, number][] = [s, e];
    const crosses = (P: [number, number][]) => {
      const ends = endsOf(aid);
      const rects = textRects();
      for (let k = 0; k + 1 < P.length; k++) {
        for (const q of rects) {
          if (ends.some((en) => en && en.contains(q.el))) continue;
          if (hit(P[k], P[k + 1], q)) return true;
        }
      }
      return false;
    };
    if (!at && crosses(pts)) {
      const leftward = B.x + B.w / 2 < A.x;
      const sx = leftward ? A.x : A.r;
      const gx = sx + (leftward ? -14 : 14);
      for (const gy of [B.y - 7, B.b + 7]) {
        const tip = gy < B.y ? B.y - 3 : B.b + 3;
        const P: [number, number][] = [[sx, A.y + A.h / 2], [gx, A.y + A.h / 2], [gx, gy], [B.x + B.w / 2, gy], [B.x + B.w / 2, tip]];
        if (!crosses(P)) {
          pts = P;
          break;
        }
      }
    }
    routes.push({ aid, from, to, pts, label, color, note });
    for (let k = 0; k + 1 < pts.length; k++) segs.push({ s: pts[k], e: pts[k + 1], aid });
    const mid0 = pts.length > 2 ? pts[2] : s;
    const mid1 = pts.length > 2 ? pts[3] : e;
    const len = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]);
    if (len < 28 && !at) W.push(`arrow #${aid} is only ${Math.round(len)}px long, too short to see${gapHint(aid, 40)}`);
    if (label) {
      const d = doc.createElement("div");
      d.className = "cv-lbl";
      d.textContent = label;
      cv.append(d);
      const lw = d.getBoundingClientRect().width;
      const lh = d.getBoundingClientRect().height;
      const horiz = Math.abs(mid1[0] - mid0[0]) >= Math.abs(mid1[1] - mid0[1]);
      d.style.left = `${(mid0[0] + mid1[0]) / 2 - (horiz ? lw / 2 : -6)}px`;
      d.style.top = `${(mid0[1] + mid1[1]) / 2 - (horiz ? lh + 3 : lh / 2)}px`;
      labels.push({ el: d, aid });
    }
  };
  for (const n of notes) {
    const t = byId(n.dataset.note ?? null);
    if (t) draw(R(n), R(t), null, "", CANVAS_BOARD_COLOURS.amber, n.id, n.id, t.id, true);
  }
  for (const a of arrows) {
    const A = byId(a.getAttribute("from"));
    const B = byId(a.getAttribute("to"));
    if (A && B) draw(R(A), R(B), a.getAttribute("at"), (a.textContent ?? "").trim(), CANVAS_BOARD_COLOURS.ink, a.id, A.id, B.id, false);
  }

  // ---- warnings an agent can act on ----
  const partEls = [...cv.querySelectorAll<HTMLElement>("[id]")].filter((e) => !e.matches("a[data-arrow]"));
  for (const { el: l, aid } of labels) {
    const lr = R(l);
    const a = byId(aid);
    const ends = a ? [byId(a.getAttribute("from")), byId(a.getAttribute("to"))] : [];
    const hits = partEls.filter((e) => {
      if (ends.some((en) => en && e.contains(en))) return false;
      if (e.children.length && !e.matches("img")) {
        const cs = getComputedStyle(e);
        if (cs.backgroundColor === "rgba(0, 0, 0, 0)" && !parseFloat(cs.borderTopWidth)) return false;
      }
      const r = R(e);
      return lr.x < r.r - 1 && lr.r > r.x + 1 && lr.y < r.b - 1 && lr.b > r.y + 1;
    });
    const other = labels.some(({ el: m }) => {
      if (m === l) return false;
      const mr = R(m);
      return lr.x < mr.r && lr.r > mr.x && lr.y < mr.b && lr.b > mr.y;
    });
    if (hits.length || other) W.push(`the label "${l.textContent}" of arrow #${aid} does not fit and covers ${hits.length ? hits.slice(0, 3).map((e) => `#${e.id}`).join(", ") : "another label"}${gapHint(aid, lr.w + 24)}`);
  }
  for (const n of notes) {
    const nr = R(n);
    for (const g of segs) {
      const ga = byId(g.aid);
      if (g.aid === n.id || (ga && ga.matches("a[data-arrow]") && (ga.getAttribute("from") === n.id || ga.getAttribute("to") === n.id))) continue;
      if (hit(g.s, g.e, nr)) {
        W.push(`note #${n.id} sits on the arrow ${ga ? `#${g.aid}` : ""}; point the note at another part, or mark the hop with the arrow label instead`);
        break;
      }
    }
  }
  const inner = (el: HTMLElement) => {
    const r = R(el);
    const s = getComputedStyle(el);
    return { x: r.x + parseFloat(s.borderLeftWidth), y: r.y + parseFloat(s.borderTopWidth), r: r.r - parseFloat(s.borderRightWidth), b: r.b - parseFloat(s.borderBottomWidth) };
  };
  for (const el of partEls) {
    const r = R(el);
    if (el.tagName === "IMG" && !((el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)) W.push(`#${el.id}: the picture did not load`);
    if ((r.w < 1 || r.h < 1) && getComputedStyle(el).display !== "none") W.push(`#${el.id}: has no size (0 wide or 0 high); give it width and height or content`);
    const par = el.parentElement?.closest<HTMLElement>("[id]");
    if (par && cv.contains(par) && !pinnedIds.has(el.id)) {
      const pr = inner(par);
      const over: string[] = [];
      if (r.r > pr.r + 1) over.push(`${Math.round(r.r - pr.r)}px on the right`);
      if (r.b > pr.b + 1) over.push(`${Math.round(r.b - pr.b)}px at the bottom`);
      if (r.x < pr.x - 1) over.push(`${Math.round(pr.x - r.x)}px on the left`);
      if (over.length) W.push(`#${el.id} sticks out of #${par.id} by ${over.join(" and ")}${par.matches("[data-frame]") ? " (cut off by the frame)" : ""}; give it less width, less padding, or let it wrap`);
    }
  }
  {
    const wk = doc.createTreeWalker(cv, NodeFilter.SHOW_TEXT);
    for (let t = wk.nextNode(); t; t = wk.nextNode()) {
      if (!t.textContent?.trim()) continue;
      const p = t.parentElement!;
      if (p.closest("a[data-arrow],.cv-lbl")) continue;
      const owner = p.closest<HTMLElement>("[id]");
      if (!owner || !cv.contains(owner)) continue;
      const rg = doc.createRange();
      rg.selectNodeContents(t);
      const tr = rg.getBoundingClientRect();
      const c = o();
      const box = inner(owner);
      const trr = tr.right - c.left;
      const tb = tr.bottom - c.top;
      if (trr > box.r + 2 || tb > box.b + 2) W.push(`#${owner.id}: the words "${t.textContent.trim().slice(0, 30)}" overflow their box by ${Math.round(Math.max(trr - box.r, tb - box.b))}px; give it more room, a smaller font-size, or fewer words`);
    }
  }
  {
    const rects = textRects();
    for (const g of segs) {
      const a = byId(g.aid);
      let ends: (HTMLElement | null)[] = [];
      if (a && a.matches("a[data-arrow]")) ends = [byId(a.getAttribute("from")), byId(a.getAttribute("to"))];
      else if (a) ends = [a, byId(a.dataset.note ?? null)];
      const crossed = new Set<string>();
      for (const q of rects) {
        if (ends.some((en) => en && en.contains(q.el))) continue;
        if (hit(g.s, g.e, q) && q.owner) crossed.add(q.owner);
      }
      if (crossed.size) {
        const el = a as HTMLElement | null;
        const to = el?.matches("a[data-arrow]") ? el.getAttribute("to") : el?.dataset.note;
        const from = el?.matches("aside") ? el.id : el ? el.getAttribute("from") : g.aid;
        W.push(`arrow from #${from} to #${to} crosses the words of ${[...crossed].map((x) => `#${x}`).join(", ")}; point it at the part that holds #${to} (its row or card), or at a part on the side facing the arrow`);
      }
    }
  }

  // ---- lift: every part into elements at its measured place ----
  const elements: CanvasElement[] = [];
  const files: LiftResult["files"] = {};
  const parts: CanvasParts = {};
  const groupsOf = (el: HTMLElement): string[] => {
    const out: string[] = [];
    for (let p: HTMLElement | null = el; p && p !== cv; p = p.parentElement) if (p.id && hasIdChildren(p)) out.push(p.id);
    return out;
  };
  const arrowEnds = new Set<string>();
  for (const r of routes) {
    arrowEnds.add(r.from);
    arrowEnds.add(r.to);
  }
  const main = new Set<string>();
  for (const el of cv.querySelectorAll<HTMLElement>("[id]")) {
    if (el.matches("a[data-arrow]")) continue;
    const id = el.id;
    const parentEl = el.parentElement?.closest<HTMLElement>("[id]");
    const kind: CanvasPartInfo["kind"] = el.matches("aside[data-note]") ? "note" : el.dataset.frame ? "frame" : el.tagName === "IMG" ? "picture" : el.tagName === "P" ? "text" : hasIdChildren(el) ? "group" : "box";
    const words = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    parts[id] = { parent: parentEl && cv.contains(parentEl) ? parentEl.id : null, kind, ...(words ? { words: words.slice(0, 80) } : {}) };
    const groupIds = groupsOf(el);
    const r = R(el);
    if (r.w === 0 && r.h === 0) continue;
    const s = getComputedStyle(el);
    if (el.tagName === "IMG") {
      const name = el.dataset.file ?? "";
      const fileId = name;
      if (name) files[fileId] = { name, mimeType: mimeOf(name) };
      elements.push(base("image", id, id, r.x, r.y, r.w, r.h, { groupIds, fileId: fileId || null, status: "saved", scale: [1, 1], crop: null, strokeColor: "transparent" }));
      main.add(id);
      continue;
    }
    const bg = hex(s.backgroundColor);
    const bt = parseFloat(s.borderTopWidth);
    const bb = parseFloat(s.borderBottomWidth);
    const bl = parseFloat(s.borderLeftWidth);
    const br = parseFloat(s.borderRightWidth);
    const browserFrame = el.dataset.frame === "browser";
    const all = browserFrame ? bl > 0 : bt > 0 && bl > 0 && bb > 0 && br > 0;
    const radius = parseFloat(s.borderTopLeftRadius) || 0;
    const round = radius >= Math.min(r.w, r.h) / 2 - 0.5 && Math.abs(r.w - r.h) < 1 && radius > 0;
    const opacity = Math.round(parseFloat(s.opacity) * 100);
    if (bg || all) {
      elements.push(base(round ? "ellipse" : "rectangle", id, id, r.x, r.y, r.w, r.h, {
        groupIds,
        backgroundColor: bg ?? "transparent",
        strokeColor: all ? (hex(s.borderLeftColor) ?? "transparent") : "transparent",
        strokeWidth: all ? Math.max(1, bl) : 1,
        roundness: !round && radius ? (radius >= 16 ? { type: 3 } : { type: 3, value: radius }) : null,
        opacity,
      }));
      main.add(id);
      if (browserFrame) {
        elements.push(base("rectangle", `${id}~bar`, id, r.x, r.y, r.w, bt, { groupIds, backgroundColor: hex(s.borderTopColor) ?? CANVAS_BOARD_COLOURS.ink, strokeColor: hex(s.borderTopColor) ?? CANVAS_BOARD_COLOURS.ink, strokeWidth: Math.max(1, bl), roundness: { type: 3, value: radius } }));
      }
    }
    if (!all) {
      const rule = (side: string, x0: number, y0: number, x1: number, y1: number, width: number, color: string) =>
        elements.push(base("line", `${id}~rule-${side}`, id, x0, y0, x1 - x0, y1 - y0, { groupIds, strokeColor: hex(color) ?? CANVAS_BOARD_COLOURS.rule, strokeWidth: Math.max(1, width), points: [[0, 0], [x1 - x0, y1 - y0]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null }));
      if (bt) rule("t", r.x, r.y, r.r, r.y, bt, s.borderTopColor);
      if (bb) rule("b", r.x, r.b, r.r, r.b, bb, s.borderBottomColor);
      if (bl) rule("l", r.x, r.y, r.x, r.b, bl, s.borderLeftColor);
      if (br) rule("r", r.r, r.y, r.r, r.b, br, s.borderRightColor);
    }
    // Words: one text element per part, its lines where the browser broke them.
    const text = textOf(el, cv);
    if (text) {
      const fs = parseFloat(s.fontSize);
      const lhPx = parseFloat(s.lineHeight) || fs * 1.25;
      const owned = !main.has(id);
      const tid = owned ? id : `${id}~t`;
      if (owned) main.add(id);
      elements.push(base("text", tid, id, text.x, text.y, text.w, text.lines.length * lhPx, {
        groupIds,
        text: text.lines.join("\n"),
        originalText: text.lines.join("\n"),
        fontSize: fs,
        fontFamily: CANVAS_AGENT_FONT_FAMILY,
        textAlign: s.textAlign === "center" ? "center" : s.textAlign === "right" || s.textAlign === "end" ? "right" : "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: Math.round((lhPx / fs) * 1000) / 1000,
        strokeColor: hex(text.color) ?? CANVAS_BOARD_COLOURS.ink,
        opacity,
      }));
    }
    // A part an arrow names holds the arrow: one with no element of its own gets an invisible box.
    if (!main.has(id) && arrowEnds.has(id)) {
      elements.push(base("rectangle", id, id, r.x, r.y, r.w, r.h, { groupIds, strokeColor: "transparent", backgroundColor: "transparent", customData: { part: id, role: "anchor" } }));
      main.add(id);
    }
  }
  // A device's outline is drawn over what it holds (the page clipped them; the canvas does not).
  for (const [id, info] of Object.entries(parts)) {
    if (info.kind !== "frame") continue;
    const frame = elements.find((e) => e.id === id);
    if (!frame || frame.strokeColor === "transparent") continue;
    let last = -1;
    elements.forEach((e, i) => {
      if (e.groupIds?.includes(id)) last = i;
    });
    elements.splice(last + 1, 0, { ...frame, id: `${id}~outline`, backgroundColor: "transparent", seed: nonce(), versionNonce: nonce(), boundElements: [] });
    frame.strokeColor = "transparent";
  }
  // Arrows and notes' pointers, bound at both ends.
  const byElementId = new Map(elements.map((e) => [e.id, e]));
  for (const r of routes) {
    const id = r.note ? `${r.aid}~arrow` : r.aid;
    const part = r.aid;
    if (!r.note) parts[part] = { parent: null, kind: "arrow", ...(r.label ? { words: r.label } : {}) };
    const [x0, y0] = r.pts[0];
    const pts = r.pts.map(([x, y]) => [Math.round((x - x0) * 10) / 10, Math.round((y - y0) * 10) / 10] as [number, number]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const start = byElementId.get(r.from);
    const end = byElementId.get(r.to);
    const groupIds = r.note ? (byElementId.get(r.aid)?.groupIds ?? []) : [];
    const arrow = base("arrow", id, part, x0, y0, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
      groupIds,
      strokeColor: r.color,
      strokeWidth: 2,
      points: pts,
      lastCommittedPoint: null,
      startArrowhead: null,
      endArrowhead: "arrow",
      startBinding: start ? { elementId: start.id, focus: 0, gap: 1 } : null,
      endBinding: end ? { elementId: end.id, focus: 0, gap: 3 } : null,
      elbowed: false,
      roundness: null,
    });
    elements.push(arrow);
    for (const end_ of [start, end]) if (end_) (end_.boundElements as { id: string; type: string }[]).push({ id, type: "arrow" });
    if (r.label) {
      const lab = labels.find((l) => l.aid === r.aid);
      if (lab) {
        const lr = R(lab.el);
        const lid = `${part}~label`;
        elements.push(base("text", lid, part, lr.x + 4, lr.y + 1, lr.w - 8, lr.h - 2, {
          text: r.label,
          originalText: r.label,
          fontSize: 13,
          fontFamily: CANVAS_AGENT_FONT_FAMILY,
          textAlign: "center",
          verticalAlign: "middle",
          containerId: id,
          autoResize: true,
          lineHeight: 1.25,
          strokeColor: CANVAS_BOARD_COLOURS.ink,
        }));
        (arrow.boundElements as { id: string; type: string }[]).push({ id: lid, type: "text" });
      }
    }
  }
  return { elements, files, warnings: [...new Set(W)], parts };
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
}

const hasIdChildren = (el: Element) => !!el.querySelector("[id]:not(a[data-arrow])");

function paintedBox(el: HTMLElement): boolean {
  const s = getComputedStyle(el);
  return s.backgroundColor !== "rgba(0, 0, 0, 0)" || (parseFloat(s.borderTopWidth) > 0 && parseFloat(s.borderLeftWidth) > 0) || el.tagName === "IMG";
}

/** The box a part's elements will have: its own painted box, else the box of its words and inner parts. */
function unionBox(el: HTMLElement, R: (el: Element) => R, cv: HTMLElement): { x: number; y: number } | null {
  if (paintedBox(el) || !hasIdChildren(el)) {
    const t = paintedBox(el) ? null : textOf(el, cv);
    const r = R(el);
    return t ? { x: t.x, y: t.y } : { x: r.x, y: r.y };
  }
  let x = Infinity;
  let y = Infinity;
  for (const k of el.querySelectorAll<HTMLElement>("[id]")) {
    if (k.matches("a[data-arrow]") || hasIdChildren(k)) continue;
    const b = paintedBox(k) ? R(k) : textOf(k, cv) ?? R(k);
    x = Math.min(x, b.x);
    y = Math.min(y, b.y);
  }
  return Number.isFinite(x) ? { x, y } : null;
}

/** The words a part holds directly (not its inner parts'), as laid-out lines, in `cv`'s coordinates. */
function textOf(el: HTMLElement, cv: HTMLElement): { lines: string[]; x: number; y: number; w: number; color: string } | null {
  const doc = el.ownerDocument;
  const nodes: Text[] = [];
  const wk = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = wk.nextNode() as Text | null; t; t = wk.nextNode() as Text | null) {
    if (!t.textContent?.trim()) continue;
    if (t.parentElement!.closest("[id]") !== el) continue;
    if (t.parentElement!.closest("a[data-arrow]")) continue;
    nodes.push(t);
  }
  if (!nodes.length) return null;
  const lines: { text: string; left: number; right: number; top: number; bottom: number }[] = [];
  const range = doc.createRange();
  for (const t of nodes) {
    const s = t.textContent!;
    const re = /\S+/g;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      range.setStart(t, m.index);
      range.setEnd(t, m.index + m[0].length);
      const rects = [...range.getClientRects()];
      const q = rects[0];
      if (!q) continue;
      const last = lines[lines.length - 1];
      const right = rects[rects.length - 1].right;
      if (last && Math.abs(last.top - q.top) < 2 + q.height / 3) {
        const gap = q.left - last.right;
        last.text += gap > 1 || /\s$/.test(s.slice(0, m.index)) ? ` ${m[0]}` : m[0];
        last.right = Math.max(last.right, right);
        last.bottom = Math.max(last.bottom, q.bottom);
      } else lines.push({ text: m[0], left: q.left, right, top: q.top, bottom: q.bottom });
    }
  }
  if (!lines.length) return null;
  const x = Math.min(...lines.map((l) => l.left));
  const w = Math.max(...lines.map((l) => l.right)) - x;
  const cs = getComputedStyle(el);
  // Line boxes: the first line's top, at the element's line height.
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
  const top = lines[0].top - (lh - (lines[0].bottom - lines[0].top)) / 2;
  const view = cv.getBoundingClientRect();
  return { lines: lines.map((l) => l.text), x: x - view.left, y: top - view.top, w: Math.max(w, 1), color: cs.color };
}
