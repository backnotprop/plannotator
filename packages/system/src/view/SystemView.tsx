// A drawing in a pane or a full window, travelled with a camera. Props only:
// the Inbox owns the address, the reading and the window; this draws what it
// is given and says what the person asked for through the callbacks.
//
// Step A4 (this, ported from G's App.jsx, NOTES.md steps 8f to 8k): the camera
// (the wheel and a pinch about the pointer, + and -, fit, a drag that glides),
// the dive into a window and back out, the wheel through a window's door, the
// crumbs and sheet chips as controls, the zoom group and Key, the keyboard, the
// notes, and the Simple / Full move.
//
// A change (step A5): a PR's revision, a plan, or the gate's touched parts.
// Before / After switch the drawing (the parts both draw travel, the rest
// fades); Steps puts the change's one sequence in place of the sheet. In a
// full window the parts list stands beside the sheet and a numbered legend
// under it; a plan is drawn dashed.
//
// The sheet on screen is always at the world's origin. A dive flies the camera
// into a window's box while the box's inside unrolls out of it and the sheet
// around lowers; at 97% of the way it re-roots the world on the inside sheet
// and glides the rest. The inside is drawn from the at-rest layout the dive
// lands on, so nothing flashes or jumps at the landing (G step 8h).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import type { Revision, SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import { kindLabel } from '../draw/format.ts';
import { Sheet } from '../draw/Sheet.tsx';
import { hasSimple, WIN_HEAD } from '../layout/compose.ts';
import type { SheetLayout } from '../layout/types.ts';
import { layoutAtRest, lodAt, scopeLabel, scopePath, sheetOr } from './rest.ts';
import { useSize, useText } from './text.ts';
import {
  CAM_MS, camAt, clamp, DIVE_MS, diveInk, doorOf, doorT, type DoorWindow, GLIDE_DECAY, LAND, lerp, paneH, reduced, restCam, spring, springStep, STEP_MS, SW_CALM, SW_EXIT, SW_LEAD,
  toSheet, WHEEL_TAU, WHEEL_TAU_PINCH, wOf, xf, ZOOM_STEP, zoomAbout, fitRect, type Cam, type Rect, type SpringState, type Stage,
} from './camera.ts';
import { all, born, clearFlip, easeOut, FULL_LINES, FULL_WORDS, placesOf, startFlip, type Flip } from './flip.ts';
import { KeyCard, NotesCard } from './cards.tsx';
import { applyChange, hasSteps, type ChangeView } from '../change/apply.ts';
import { changeSummary, isRevision, type ChangeFile } from '../change/summary.ts';
import { PartsList } from './PartsList.tsx';
import { StepsStage } from './StepsStage.tsx';

export type Reading = 'simple' | 'full';

export type SystemViewProps = {
  model: SystemModel;
  /** The sheet to show; the landing sheet when left out. A new value travels there (surface, dive, or turn the sheet). */
  sheet?: string;
  /** The project the drawing belongs to, shown as the first crumb (the Inbox's project name). */
  project?: string;
  /** Simple or Full (default Full) of the sheet on screen; a window's inside is drawn in the same reading. */
  reading?: Reading;
  /** pane: the drawing fits the pane's width and grows down; window: it fits the window. */
  layout: 'pane' | 'window';
  /** Single-key shortcuts (+, -, F, N, 1 to 9) while the focus is in the drawing (default on). The Inbox passes its Single-key shortcuts setting. */
  keys?: boolean;
  /** A change to draw: a PR's revision, a plan, or the gate's touched parts (amber only). Opens on the sheet it touches most when `sheet` is left out. */
  revision?: Revision | GateResult;
  /** Before, After (default) or Steps of a change. A gate result has After only; Steps needs a revision with steps. */
  view?: 'before' | 'after' | 'steps';
  /** plan: the change drawn dashed where not built, for Shape's System (plan) tab. Default review. */
  mode?: 'review' | 'plan';
  /** The PR's changed files with their counts (`git diff --numstat`): they name each part's files and counts. */
  files?: ChangeFile[];
  /** The PR as the forge knows it: its number and title (else the revision's) and its state. */
  pr?: { number?: number; title?: string; state?: 'open' | 'merged' | 'closed' };
  /** The PR's number opens its Details (as the PR title does in the Inbox's review). */
  onOpenDetails?(): void;
  /** The sheet on screen changed: a dive or a climb landed, a chip or a crumb was pressed, the wheel crossed a door. */
  onNavigate(sheet: string): void;
  /** Shown as the Simple / Full switch when given, on a sheet that has both readings. */
  onReading?(r: Reading): void;
  /** Shows Before / After / Steps when given (As built / As planned in a plan); Esc in Steps asks for After. */
  onView?(v: 'before' | 'after' | 'steps'): void;
  /** "diff ›" and a file in the parts list: open that file of the PR. In a full window, shows the parts list. */
  onOpenFile?(path: string, part: string): void;
  /** Shown as Open full window when given, in the pane. */
  onOpenFull?(): void;
  /** Shown as a close button when given; Esc on the landing sheet calls it too. */
  onClose?(): void;
};

/** A window being entered or left: the part, the sheet inside, the box its inside opens from, and how far (0 outside, 1 inside). */
type Dive = { part: string; code: string; r: Rect; s: number; t: number };
type DiveRun = Dive & { t0: number; S: SpringState; A: Cam; B: Cam; done: boolean; then?: () => void; onIn: () => void; onOut: () => void; restIn: () => Cam };
type Door = DoorWindow & { id: string; code: string; r: Rect; s: number };


export function SystemView({
  model: base, sheet, project, reading = 'full', layout, keys = true, revision, view = 'after', mode = 'review', files, pr,
  onNavigate, onReading, onView, onOpenFile, onOpenFull, onClose, onOpenDetails,
}: SystemViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const curRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const { epoch } = useText(root);
  const size = useSize(stageRef);
  const simple = reading === 'simple';

  // ---------------------------------------------------------------- the change on the drawing
  const change = revision ?? null;
  const rev = change && isRevision(change) ? change : null;
  const plan = mode === 'plan' && !!change;
  const summary = useMemo(() => (change ? changeSummary(base, change, files) : null), [base, change, files]);
  const canSteps = hasSteps(change);
  const vw: ChangeView = !change ? 'after' : view === 'steps' && canSteps ? 'steps' : view === 'before' && rev ? 'before' : 'after';
  const asBefore = vw === 'before';
  const model = useMemo(() => (change ? applyChange(base, change, asBefore ? 'before' : 'after', files) : base), [base, change, asBefore, files]);
  const stepsModel = useMemo(() => (change && canSteps && vw === 'steps' ? applyChange(base, change, 'steps', files) : null), [base, change, canSteps, vw, files]);
  const [picked, setPicked] = useState<string | null>(null);
  const [rowHover, setRowHover] = useState<string | null>(null);

  // ---------------------------------------------------------------- the sheet on screen
  const [cur, setCurS] = useState(() => sheetOr(model, sheet ?? summary?.sheet));
  const curNow = useRef(cur);
  const setCur = (c: string) => { curNow.current = c; setCurS(c); };
  const code = model.sheets[cur] ? cur : sheetOr(model, cur);
  const s = model.sheets[code];
  const scope = s?.scope ?? 'root';
  const L = useMemo(() => (s ? layoutAtRest(model, code, simple) : null), [model, code, simple, s, epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const LRef = useRef(L);
  const turn = useRef<{ from: SheetLayout | null; cut: boolean; same?: boolean; fromModel?: SystemModel } | null>(null);
  const modelNow = useRef(model);
  if (modelNow.current !== model) {
    // Before and After of the sheet on screen: the parts both draw travel, what one alone draws fades
    if (LRef.current && LRef.current !== L && LRef.current.id === code) turn.current = { from: LRef.current, fromModel: modelNow.current, cut: reduced(), same: true };
    modelNow.current = model;
  }
  LRef.current = L;
  const restOf = useCallback((c: string) => layoutAtRest(model, c, simple), [model, simple, epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastIn = useRef<Record<string, string>>({}); // scope -> the sheet last shown there
  /** The sheet a window opens onto: where its scope was left, else its first sheet. */
  const childFor = useCallback((sc: string) => {
    const last = lastIn.current[sc];
    return last && model.sheets[last] ? last : model.byScope[sc]?.[0];
  }, [model]);

  // ---------------------------------------------------------------- the stage and the camera
  const stageW = size.w;
  const stageH = layout === 'pane' ? (L ? paneH(L.w, L.h, stageW) : 200) : size.h;
  const st: Stage = useMemo(() => ({ w: stageW, h: stageH, layout }), [stageW, stageH, layout]);
  const stRef = useRef(st); stRef.current = st;
  const restK = (c: string) => { const C = restOf(c); return restCam(C.w, C.h, stRef.current).k; };
  const restNow = () => { const C = LRef.current!; return restCam(C.w, C.h, stRef.current); };

  const [, setTick] = useState(0);
  const camRef = useRef<Cam | null>(null);
  const dvRef = useRef<Dive | null>(null);
  /** Runs what is current in the frame it is called from (a spring's frame, a wheel event), so the camera, a dive's ink and a move land in one paint. */
  const moved = useRef(0); // when the camera last moved: idle layout waits until it has been still a while
  const draw = (sync = true) => {
    moved.current = performance.now();
    if (worldRef.current && camRef.current) worldRef.current.style.transform = xf(camRef.current);
    if (sync) flushSync(() => setTick((n) => n + 1));
    else setTick((n) => n + 1);
  };
  const putCam = (c: Cam, sync = true) => { camRef.current = c; draw(sync); };

  // every move that holds the camera; whoever takes it next stops what had it
  const A = useRef<{ cam?: () => void; dive?: DiveRun | null; wheel?: { stop: () => void; x: number; X: number; v: number; w: number; px: number; py: number } | null; stepTo?: Cam | null; flight?: { from: Cam; to: Cam; S: SpringState } | null; flip?: Flip | null; glide?: boolean }>({});
  const take = (cancel?: () => void) => {
    const prev = A.current.cam;
    A.current.cam = cancel;
    A.current.stepTo = null;
    A.current.flight = null;
    prev?.();
  };
  /** Reduced motion: the camera cuts and the world fades up over 180 ms. */
  const calm = () => worldRef.current?.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: SW_CALM, easing: 'ease-out' });
  /** A flight in place (fit, refit, keep in view, + and -): ms90 to 90% of the way; v0 is speed carried from the flight it replaces. */
  const flyTo = (to: Cam, ms90 = CAM_MS, done?: () => void, v0 = 0, kick = true) => {
    const from = camRef.current;
    if (!from || reduced()) { take(); calm(); putCam(to, false); done?.(); return; }
    const w = wOf(ms90);
    const S = { x: 0, v: v0 + (kick ? w / 2 : 0), to: 1 };
    take(spring(S, w, (e) => putCam(camAt(from, to, e)), done));
    A.current.flight = { from, to, S };
  };

  // the camera rests on the sheet when the stage first has a size, and again when it changes size
  useLayoutEffect(() => {
    if (!L || !stageW || (layout === 'window' && !size.h)) return;
    if (A.current.dive) return;
    take();
    camRef.current = restCam(L.w, L.h, st);
    draw(false);
  }, [stageW, layout === 'window' ? size.h : 0, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  // the world's transform is written here and by every move, never by React's style, so a frame is never a frame behind
  useLayoutEffect(() => { if (worldRef.current && camRef.current) worldRef.current.style.transform = xf(camRef.current); });

  // ---------------------------------------------------------------- naming and the host's address
  const named = useRef(code);
  const [said, setSaid] = useState('');
  const name = (c: string, words: string) => {
    if (named.current === c) return;
    named.current = c;
    setSaid(words);
    onNavigate(c);
  };
  const insideWords = (c: string) => {
    const sh = model.sheets[c];
    return sh ? `${scopeLabel(model, sh.scope)}, ${kindLabel(sh.kind).toLowerCase()} sheet` : c;
  };

  // ---------------------------------------------------------------- windows and doors
  /** The window parts of a layout: the box, the scope it opens, the sheet inside and where its inside opens from. */
  const windowOf = (Lc: SheetLayout, id: string) => {
    const b = Lc.parts[id];
    const sc = b?.opens;
    if (!b || !b.cw || !sc) return null;
    const c = childFor(sc);
    if (!c) return null;
    const C = restOf(c);
    const sc2 = b.w / C.w;
    return { id, code: c, C, s: sc2, r: { x: b.x, y: b.y + WIN_HEAD, w: b.w, h: Math.max(0, b.h - WIN_HEAD) } };
  };
  /** The window under a stage point, with how close its inside is to its own rest scale (1 = at the door). */
  const windowAt = (c: Cam, px: number, py: number, Lc = LRef.current): Door | null => {
    if (!Lc || Lc.simple) return null;
    const [wx, wy] = toSheet(c, px, py);
    for (const id of Object.keys(Lc.parts)) {
      const b = Lc.parts[id]!;
      // the box first: the inside's layout is read only for the window under the point (or the one being opened)
      if (!b.cw || wx < b.x || wx > b.x + b.w || wy < b.y || (wy > b.y + b.h && id !== near.current)) continue;
      const w = windowOf(Lc, id);
      if (!w) continue;
      if (wy > Math.max(w.r.y + w.C.h * w.s, b.y + b.h)) continue;
      return doorFor(c, w);
    }
    return null;
  };
  const doorFor = (c: Cam, w: { id: string; code: string; s: number; r: Rect }): Door => {
    const ratio = (c.k * w.s) / restK(w.code);
    return { id: w.id, code: w.code, r: w.r, s: w.s, ratio, ...doorOf(r0Of(w)) };
  };
  const r0Of = (w: { code: string; s: number }) => (restNow().k * w.s) / restK(w.code);
  // the window the wheel last went toward or came out of; it stays the one being
  // opened while it is open at all, so the sheet around never pops back in under a pointer that wandered off it
  const near = useRef<string | null>(null);
  const focusPt = useRef<[number, number] | null>(null);
  const doorNow = (c: Cam): Door | null => {
    const Lc = LRef.current;
    if (!Lc || Lc.simple || dvRef.current || A.current.flip) return null;
    // at the sheet's rest scale or below, every window is at rest (doorT is 0): nothing to read
    if (c.k <= restNow().k * (1 + 1e-6)) { near.current = null; return null; }
    const [px, py] = focusPt.current ?? [stRef.current.w / 2, stRef.current.h / 2];
    let d = windowAt(c, px, py);
    if (!d && near.current) {
      const w = windowOf(Lc, near.current);
      const d2 = w && doorFor(c, w);
      if (d2 && d2.ratio > d2.lo) d = d2;
    }
    near.current = d && d.ratio > d.lo * 0.98 ? d.id : null;
    return d;
  };

  /** The sheet around this one and the window this one opens from, for a climb. */
  const parentOf = (c: string) => {
    const sc = model.sheets[c]?.scope;
    if (!sc || sc === 'root') return null;
    const part = model.owner[sc];
    const psc = model.parentOf[sc] ?? 'root';
    if (!part) return null;
    const cands = [lastIn.current[psc], ...(model.byScope[psc] ?? [])].filter((x): x is string => !!x && !!model.sheets[x]);
    for (const p of cands) {
      const PL = restOf(p);
      const b = PL.parts[part];
      if (b?.cw) return { pcode: p, part, PL, r: { x: b.x, y: b.y + WIN_HEAD, w: b.w, h: Math.max(0, b.h - WIN_HEAD) }, s: b.w / restOf(c).w };
    }
    return { pcode: cands[0], part, PL: cands[0] ? restOf(cands[0]) : null, r: null, s: 1 };
  };

  // ---------------------------------------------------------------- the dive
  const diveTo = (D: DiveRun, to: number) => {
    D.S.v += (to - D.S.x) * (wOf(DIVE_MS) / 2); // the input's push toward where it now goes
    D.S.to = to;
  };
  const putDive = (D: Dive | null) => { dvRef.current = D; };
  const startDive = (D: DiveRun) => {
    A.current.dive = D;
    const land = (glide: boolean) => {
      if (D.done) return;
      D.done = true;
      A.current.dive = null;
      const inward = D.S.to === 1, { x, v } = D.S;
      (inward ? D.onIn : D.onOut)();
      // the last few percent: the same spring, now in the world it landed in, with the speed it had
      if (glide) flyTo(inward ? D.restIn() : D.A, DIVE_MS, undefined, inward ? v / Math.max(1e-3, 1 - x) : -v / Math.max(1e-3, x), false);
      else draw(false);
    };
    // x is the camera's way from A to B; the drawing's t starts where a wheel left the window (t0)
    const tOf = (x: number) => D.t0 + (1 - D.t0) * clamp(x, 0, 1);
    const put = (x: number) => { D.t = tOf(x); putDive(D); putCam(camAt(D.A, D.B, clamp(x, 0, 1))); };
    if (reduced()) { take(); calm(); D.S.x = D.S.to; D.t = tOf(D.S.to); putDive(D); camRef.current = camAt(D.A, D.B, D.S.to); land(false); return; }
    let stop: (() => void) | null = null;
    const show = (t: number) => {
      put(t);
      if (!D.done && ((D.S.to === 1 && t >= 1 - LAND) || (D.S.to === 0 && t <= LAND))) { stop?.(); land(true); }
    };
    stop = spring(D.S, wOf(DIVE_MS), show, () => land(false));
    take(() => { stop!(); if (D.done) return; D.S.x = D.S.to; D.t = tOf(D.S.to); land(false); });
  };
  /** The inside sheet becomes the world's origin; the camera is the same camera, written in its units. */
  /** A move that takes the sheet's parts away (a dive, a climb, a turn) leaves the keyboard on the stage, not on a part that is about to go. */
  const holdFocus = () => {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    if (a && a !== stageRef.current && root.current?.contains(a) && !a.closest('.sys-bar')) stageRef.current?.focus({ preventScroll: true });
  };
  const landIn = (part: string, child: string, r: Rect, sc: number, from: string) => {
    lastIn.current[model.sheets[from]?.scope ?? 'root'] = from;
    const c = camRef.current!;
    camRef.current = { ...c, k: c.k * sc, cx: (c.cx - r.x) / sc, cy: (c.cy - r.y) / sc };
    putDive(null);
    near.current = null;
    setCur(child);
    name(child, `Inside ${model.parts[part]?.name ?? part}, ${kindLabel(model.sheets[child]!.kind).toLowerCase()} sheet`);
  };
  const dive = (part: string, then?: () => void) => {
    const D0 = A.current.dive;
    if (D0) { if (D0.part === part) { D0.then = then; diveTo(D0, 1); } return; }
    const Lc = LRef.current, from = curNow.current;
    if (!Lc || !camRef.current) return;
    const w = windowOf(Lc, part);
    if (!w) return;
    endFlip();
    holdFocus();
    const B = fitRect({ x: w.r.x, y: w.r.y, w: w.r.w, h: w.C.h * w.s }, stRef.current, 1 / w.s);
    // a wheel half way into this window: the dive goes on from there
    const d = doorNow(camRef.current);
    const t0 = d && d.id === part ? doorT(d, r0Of(w)) : 0;
    const D: DiveRun = {
      part, code: w.code, r: w.r, s: w.s, t: t0, t0, A: camRef.current, B, then, done: false, S: { x: 0, v: 0, to: 0 },
      restIn: () => ({ ...B, k: B.k * w.s, cx: (B.cx - w.r.x) / w.s, cy: (B.cy - w.r.y) / w.s }),
      onIn: () => { landIn(part, w.code, w.r, w.s, from); if (D.then) setTimeout(D.then, 40); },
      onOut: () => { putDive(null); draw(false); },
    };
    putDive(D);
    diveTo(D, 1);
    startDive(D);
  };
  /** Up one level: the sheet around comes back with this sheet inside its window, and the dive plays backwards. */
  const surface = (then?: () => void) => {
    const D0 = A.current.dive;
    if (D0) { D0.then = then; diveTo(D0, 0); return; }
    const c1 = curNow.current, P = parentOf(c1);
    if (!P || !P.pcode || !camRef.current) return;
    endFlip();
    holdFocus();
    lastIn.current[model.sheets[c1]?.scope ?? 'root'] = c1;
    const PL = P.PL!;
    const Bout = restCam(PL.w, PL.h, stRef.current);
    if (!P.r) {
      // no window to climb into: the sheet around comes back at once
      setCur(P.pcode);
      camRef.current = Bout;
      name(P.pcode, `Out to ${scopeLabel(model, model.sheets[P.pcode]!.scope)}`);
      draw(false);
      then?.();
      return;
    }
    const { r, s: sc } = P;
    const c = camRef.current;
    const c2 = { ...c, k: c.k / sc, cx: r.x + c.cx * sc, cy: r.y + c.cy * sc };
    camRef.current = c2;
    setCur(P.pcode);
    near.current = null;
    // t = 1 is this sheet where it was (c2), t = 0 the sheet around at rest
    const D: DiveRun = {
      part: P.part, code: c1, r, s: sc, t: 1, t0: 0, A: Bout, B: c2, then, done: false, S: { x: 1, v: 0, to: 1 },
      restIn: () => c,
      onIn: () => landIn(P.part, c1, r, sc, P.pcode!), // turned back in
      onOut: () => { putDive(null); name(P.pcode!, `Out to ${scopeLabel(model, model.sheets[P.pcode!]!.scope)}`); draw(false); if (D.then) setTimeout(D.then, 40); },
    };
    putDive(D);
    diveTo(D, 0);
    startDive(D);
  };

  // ---------------------------------------------------------------- the wheel's doors (one territory)
  /** After a zoom the person drives: cross a door when the scale says so. True when the world was re-rooted. */
  const crossDoor = (c: Cam, dir: number) => {
    if (A.current.dive || A.current.flip) return false;
    if (dir > 0) {
      const d = doorNow(c);
      if (d && d.ratio >= d.at) {
        take();
        const from = curNow.current;
        camRef.current = c;
        landIn(d.id, d.code, d.r, d.s, from);
        draw();
        return true;
      }
    }
    if (dir < 0) {
      const P = parentOf(curNow.current);
      if (P?.r && P.pcode) {
        const r0 = (restCam(P.PL!.w, P.PL!.h, stRef.current).k * P.s) / restK(curNow.current);
        if (c.k / restK(curNow.current) < doorOf(r0).hi) {
          take();
          const c1 = curNow.current;
          lastIn.current[model.sheets[c1]?.scope ?? 'root'] = c1;
          camRef.current = { ...c, k: c.k / P.s, cx: P.r.x + c.cx * P.s, cy: P.r.y + c.cy * P.s };
          setCur(P.pcode);
          near.current = P.part;
          name(P.pcode, `Out to ${scopeLabel(model, model.sheets[P.pcode]!.scope)}`);
          draw();
          return true;
        }
      }
    }
    return false;
  };

  // ---------------------------------------------------------------- zoom
  const zoomBy = (f: number) => {
    if (A.current.dive) { diveTo(A.current.dive, f > 1 ? 1 : 0); return; }
    const now = camRef.current;
    if (!now) return;
    const px = stRef.current.w / 2, py = stRef.current.h / 2;
    focusPt.current = [px, py];
    // + and - stack on the target the last step was flying to, so three fast
    // presses reach 1.25 cubed, and the speed already there carries on
    const c = A.current.stepTo ?? now, F = A.current.flight;
    const to = zoomAbout(c, f, px, py);
    let v0 = 0;
    if (A.current.stepTo && F) {
      const vlk = F.S.v * Math.log(F.to.k / F.from.k), span = Math.log(to.k / now.k);
      if (Math.abs(span) > 1e-4) v0 = clamp(vlk / span, 0, 3 * wOf(STEP_MS));
    }
    flyTo(to, STEP_MS, () => { A.current.stepTo = null; crossDoor(camRef.current!, f > 1 ? 1 : -1); }, v0);
    A.current.stepTo = to;
  };
  const fit = () => {
    if (A.current.dive) return;
    near.current = null;
    flyTo(restNow());
  };

  const onWheel = (e: WheelEvent) => {
    // a pane sits in a page that scrolls: there the wheel scrolls the page, and a pinch or Ctrl / Cmd with the wheel zooms
    if (stRef.current.layout === 'pane' && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // a wheel during a dive turns it by its direction, from where it is
    const D = A.current.dive;
    if (D) { const to = e.deltaY < 0 ? 1 : 0; if (D.S.to !== to) diveTo(D, to); return; }
    if (!camRef.current) return;
    const rect = stageRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    focusPt.current = [px, py];
    const dl = -e.deltaY * (e.deltaMode === 1 ? 33 : 1) * (e.ctrlKey ? 0.012 : 0.0022); // the zoom asked, in log scale
    const zoomAt = (d: number, x: number, y: number) => {
      const c = camRef.current!;
      const next = zoomAbout(c, Math.exp(d), x, y);
      camRef.current = next;
      if (!crossDoor(next, d > 0 ? 1 : -1)) putCam(next);
    };
    if (reduced()) { take(); zoomAt(dl, px, py); return; }
    // the wheel's zoom is owed, and the camera pays it off about the pointer on
    // the camera's own spring (WHEEL_TAU 80 ms reads as about 240 ms to 90%, a
    // pinch's 45 as 135): a notch from rest launches it, a notch while it
    // glides the same way moves its target and the speed follows
    const wFor = (pinch: boolean) => 3000 / (3 * (pinch ? WHEEL_TAU_PINCH : WHEEL_TAU));
    const W0 = A.current.wheel;
    if (W0 && A.current.cam === W0.stop) {
      W0.px = px; W0.py = py; W0.w = wFor(e.ctrlKey);
      if (Math.sign(W0.v) !== Math.sign(dl) || Math.abs(W0.v) < 1e-3) W0.v += (W0.w / 2) * dl;
      W0.X += dl;
      return;
    }
    let last: number | null = null, raf = 0;
    const W = { x: 0, X: dl, v: 0, px, py, w: wFor(e.ctrlKey), stop: () => cancelAnimationFrame(raf) };
    W.v = (W.w / 2) * dl;
    const step = (now: number) => {
      const dt = last == null ? 1 / 60 : clamp((now - last) / 1000, 1 / 240, 0.05);
      last = now;
      const x0 = W.x;
      [W.x, W.v] = springStep(W.x, W.v, W.X, W.w, dt);
      const done = Math.abs(W.X - W.x) < 2e-4 && Math.abs(W.v) < 2e-3;
      if (done) W.x = W.X;
      zoomAt(W.x - x0, W.px, W.py);
      A.current.cam = W.stop; // a door crossed mid-glide re-roots under the camera; the glide is relative, so it carries on
      if (!done) raf = requestAnimationFrame(step);
      else A.current.wheel = null;
    };
    take(W.stop);
    A.current.wheel = W;
    raf = requestAnimationFrame(step);
  };
  const wheelRef = useRef(onWheel); wheelRef.current = onWheel;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const on = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, []);

  // ---------------------------------------------------------------- the drag
  const drag = useRef<{ x: number; y: number; cam: Cam; moved: boolean; id: number; lt?: number; lx?: number; ly?: number; vx?: number; vy?: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !camRef.current || (e.target as Element).closest('.sys-zoom, .sys-card-pop, button')) return;
    drag.current = { x: e.clientX, y: e.clientY, cam: camRef.current, moved: false, id: e.pointerId };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || A.current.dive) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) { d.moved = true; stageRef.current?.setPointerCapture?.(d.id); setDragging(true); take(); }
    const t = performance.now();
    if (d.lt) { const dt = Math.max(1, t - d.lt); d.vx = 0.7 * (d.vx || 0) + 0.3 * ((e.clientX - d.lx!) / dt); d.vy = 0.7 * (d.vy || 0) + 0.3 * ((e.clientY - d.ly!) / dt); }
    d.lt = t; d.lx = e.clientX; d.ly = e.clientY;
    putCam({ ...d.cam, cx: d.cam.cx - dx / d.cam.k, cy: d.cam.cy - dy / d.cam.k });
  };
  const onUp = () => {
    const d = drag.current;
    setTimeout(() => { drag.current = null; }, 0);
    if (!d?.moved) return;
    setDragging(false);
    // a drag let go while moving glides on and slows, as a map does under the hand
    if (reduced() || !d.lt || performance.now() - d.lt > 80) return;
    let vx = d.vx || 0, vy = d.vy || 0;
    if (Math.hypot(vx, vy) < 0.12) return;
    let last = performance.now(), raf = 0;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      const f = Math.exp(-GLIDE_DECAY * dt);
      vx *= f; vy *= f;
      const c = camRef.current!;
      putCam({ ...c, cx: c.cx - (vx * dt) / c.k, cy: c.cy - (vy * dt) / c.k });
      if (Math.hypot(vx, vy) > 0.02) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    take(() => cancelAnimationFrame(raf));
  };

  // ---------------------------------------------------------------- the move between layouts (Simple / Full, and sheets of one scope)
  const exitFades = useRef<Animation[]>([]);
  const pendingSimple = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = useRef<{ code: string; simple: boolean; L: SheetLayout | null }>({ code, simple, L });
  const [ghost, setGhost] = useState<{ L: SheetLayout; model: SystemModel; keep: Set<string>; n: number } | null>(null);
  const dropFades = () => { for (const a of exitFades.current) a.cancel(); exitFades.current = []; };
  const endFlip = () => {
    const F = A.current.flip;
    if (!F) return;
    F.stop();
    for (const a of F.fades) a.cancel();
    clearFlip(F);
    A.current.flip = null;
  };
  const sheetEl = () => curRef.current?.querySelector(':scope > .sys-sheet') ?? null;
  /** The switch: into Simple, what only Full draws leaves first (from where it is), and the parts start 60 ms later. */
  const pressReading = (r: Reading) => {
    if (!onReading || A.current.dive) return;
    if (pendingSimple.current) {
      // asked for Simple and pressed again before the parts moved: what was fading comes back from where it is
      clearTimeout(pendingSimple.current);
      pendingSimple.current = null;
      const fs = exitFades.current;
      exitFades.current = [];
      for (const a of fs) a.reverse();
      setTimeout(() => fs.forEach((a) => a.cancel()), SW_EXIT + 40);
      return;
    }
    if (r === reading) return;
    if (r === 'full') { onReading('full'); return; }
    const els = all(sheetEl(), [...FULL_LINES, ...FULL_WORDS]);
    const ops = els.map((el) => +getComputedStyle(el).opacity);
    dropFades();
    if (!ops.some((o) => o > 0.04)) { onReading('simple'); return; }
    exitFades.current = els.map((el, i) => born(el.animate([{ opacity: ops[i] }, { opacity: 0 }], { duration: SW_EXIT, easing: easeOut(), fill: 'forwards' })));
    pendingSimple.current = setTimeout(() => { pendingSimple.current = null; onReading('simple'); }, reduced() ? SW_EXIT : SW_LEAD);
  };
  /** Another sheet of this scope (a chip, keys 1 to 9): the parts both draw travel, the rest fades, the camera refits on the same spring. */
  const turnTo = (c: string, then?: () => void) => {
    const from = curNow.current;
    if (c === from || !model.sheets[c] || A.current.dive) { then?.(); return; }
    holdFocus();
    turn.current = { from: LRef.current, cut: reduced() };
    setCur(c);
    name(c, `${kindLabel(model.sheets[c]!.kind)} sheet: ${model.sheets[c]!.title}`);
    if (then) setTimeout(then, 40);
  };
  // after every commit: start a move when the layout on screen changed in place
  useLayoutEffect(() => {
    const was = shown.current;
    shown.current = { code, simple: !!L?.simple, L };
    if (!L || !was.L || was.L === L) return;
    const root0 = sheetEl();
    const T = turn.current;
    turn.current = null;
    const rest = restCam(L.w, L.h, stRef.current);
    if (T && (was.code !== code || T.same) && (T.cut || !T.from)) {
      // reduced motion, or nothing to move from: the camera cuts to the sheet and the world fades up
      take(); calm();
      camRef.current = rest;
      draw(false);
      return;
    }
    if (T && T.from && (was.code !== code || T.same)) {
      // another sheet of the scope, or the same sheet Before and After a change
      const at = placesOf(A.current.flip);
      endFlip();
      near.current = null;
      const from = T.from;
      const fromModel = T.fromModel ?? model;
      setGhost((g) => ({ L: from, model: fromModel, keep: new Set([...Object.keys(L.parts).map((id) => 'p:' + id), ...L.zones.map((z) => 'z:' + z.id)]), n: (g?.n ?? 0) + 1 }));
      flyTo(rest, CAM_MS);
      if (root0) A.current.flip = startFlip({ root: root0, from, to: L, at, enter: 'sheet', onDone: () => { A.current.flip = null; setGhost(null); } });
      return;
    }
    if (was.code === code && was.simple !== !!L.simple) {
      // the same sheet in its other reading
      const F0 = A.current.flip;
      const at = placesOf(F0);
      const v0 = F0 && F0.S.x > 0.05 && F0.S.x < 0.995 ? clamp(-F0.S.v / F0.S.x, -3 * wOf(CAM_MS), 0) : 0;
      endFlip();
      dropFades();
      const toFull = !L.simple;
      if (reduced() || !root0) {
        take(); calm();
        camRef.current = rest;
        draw(false);
        if (toFull && root0) for (const el of all(root0, [...FULL_LINES, ...FULL_WORDS])) born(el.animate([{ opacity: 0, offset: 0 }], { duration: SW_CALM, easing: easeOut(), fill: 'backwards' }));
        return;
      }
      flyTo(rest, CAM_MS, undefined, A.current.flight ? v0 : 0);
      A.current.flip = startFlip({ root: root0, from: was.L, to: L, at, v0, enter: toFull ? 'full' : 'none', onDone: () => { A.current.flip = null; } });
    }
  });
  // the leaving sheet of a turn: what it alone draws fades out over SW_EXIT; what both draw is the new sheet's, travelling
  useLayoutEffect(() => {
    const g = ghostRef.current;
    if (!g || !ghost) return;
    for (const el of g.querySelectorAll<HTMLElement | SVGElement>('[data-part], [data-zone]')) {
      const k = el.dataset.part ? 'p:' + el.dataset.part : 'z:' + el.dataset.zone;
      if (ghost.keep.has(k)) el.style.visibility = 'hidden';
    }
    born(g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SW_EXIT, easing: easeOut(), fill: 'forwards' }));
  }, [ghost?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { clearTimeout(pendingSimple.current ?? undefined); endFlip(); dropFades(); A.current.cam?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // what the next press may need is laid out in idle time, so a press never waits on a layout (routing a big sheet's
  // lines takes hundreds of ms): the sheet above (Esc), the sheet inside each window (a dive), the other reading
  // (the switch), then the scope's other sheets (a chip)
  useEffect(() => {
    if (!s) return;
    const idle = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const stop = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    const inside = L ? Object.values(L.parts).flatMap((p) => { const c = p.opens ? childFor(p.opens) : undefined; return c ? [() => layoutAtRest(model, c, simple)] : []; }) : [];
    const jobs = [() => parentOf(code), ...inside, () => layoutAtRest(model, code, !simple), ...(model.byScope[scope] ?? []).map((c) => () => layoutAtRest(model, c, simple))];
    let h = 0, dead = false;
    const run = () => { if (dead) return; const j = jobs.shift(); if (!j) return; if (!A.current.dive && !A.current.flip && performance.now() - moved.current > 300) j(); else jobs.unshift(j); h = idle ? idle(run, { timeout: 2000 }) : (setTimeout(run, 200) as unknown as number); };
    h = idle ? idle(run, { timeout: 2000 }) : (setTimeout(run, 200) as unknown as number);
    return () => { dead = true; if (idle && stop) stop(h); else clearTimeout(h); };
  }, [model, code, simple, scope, epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- the host's address: a new `sheet` travels there
  /** Go to any sheet: climb to the scope both share, then dive window by window, then turn the sheet. */
  const travel = (target: string, done?: () => void) => {
    const goal = scopePath(model, target).map(([id]) => id);
    let guard = 0;
    const step = () => {
      if (++guard > 24) return;
      const here = scopePath(model, curNow.current).map(([id]) => id);
      let k = 0;
      while (k < here.length && k < goal.length && here[k] === goal[k]) k++;
      if (k < here.length) { surface(step); return; }
      if (here.length < goal.length) {
        const part = model.owner[goal[here.length]!];
        if (part && LRef.current?.parts[part]?.cw) { dive(part, step); return; }
        const host = (model.byScope[here.at(-1)!] ?? []).find((c) => !!part && restOf(c).parts[part]?.cw);
        if (host && host !== curNow.current) { turnTo(host, step); return; }
        // no window leads there: go straight to it
        turn.current = { from: null, cut: true };
        setCur(target);
        name(target, insideWords(target));
        done?.();
        return;
      }
      if (curNow.current !== target) turnTo(target, done);
      else done?.();
    };
    step();
  };
  const lastProp = useRef(sheet);
  useEffect(() => {
    if (sheet === lastProp.current) return;
    lastProp.current = sheet;
    const c = sheetOr(model, sheet);
    if (c !== named.current) { named.current = c; travel(c); }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- the keyboard
  const [keyOpen, setKeyOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const codes = model.byScope[scope] ?? [code];
  /** Keeps a part in view when the keyboard reaches it off the glass. */
  const keepInView = (id: string) => {
    const b = LRef.current?.parts[id], c = camRef.current;
    if (!b || !c) return;
    const x0 = (b.x - c.cx) * c.k + c.sx, y0 = (b.y - c.cy) * c.k + c.sy, x1 = x0 + b.w * c.k, y1 = y0 + b.h * c.k;
    const m = 24, W = stRef.current.w, H = stRef.current.h;
    if (x0 >= m && y0 >= m && x1 <= W - m && y1 <= H - m) return;
    flyTo({ ...c, cx: b.x + b.w / 2, cy: b.y + b.h / 2, sx: W / 2, sy: H / 2 });
  };
  /** The arrows: the nearest part in that direction, by the centres of their boxes. */
  const nextPart = (id: string, key: string) => {
    const P = LRef.current?.parts;
    const a = P?.[id];
    if (!P || !a) return null;
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const [ux, uy] = ({ ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] } as Record<string, [number, number]>)[key]!;
    let best: string | null = null, bd = Infinity;
    for (const [q, b] of Object.entries(P)) {
      if (q === id) continue;
      const dx = b.x + b.w / 2 - ax, dy = b.y + b.h / 2 - ay;
      const along = dx * ux + dy * uy;
      if (along <= 4) continue;
      const d = along + 2.5 * Math.abs(dx * uy - dy * ux);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, [contenteditable="true"]') || e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const partEl = t.closest<HTMLElement>('.sys-cur [data-part]');
    const k = e.key;
    let did = true;
    if (k === 'Escape' && vw === 'steps') {
      if (onView) onView('after');
      else did = false;
    } else if (k === 'Escape') {
      if (keyOpen || notesOpen) { setKeyOpen(false); setNotesOpen(false); }
      else if (A.current.dive || scopePath(model, curNow.current).length > 1) surface();
      else if (onClose) onClose();
      else did = false;
    } else if (partEl && k.startsWith('Arrow')) {
      const n = nextPart(partEl.dataset.part!, k);
      if (n) curRef.current?.querySelector<HTMLElement>(`[data-part="${CSS.escape(n)}"]`)?.focus({ preventScroll: true });
    } else if (partEl && (k === 'Enter' || k === ' ') && partEl.dataset.opens != null) dive(partEl.dataset.part!);
    else if (!keys || e.shiftKey && !/^[+_]$/.test(k)) did = false;
    else if (k === '+' || k === '=') zoomBy(ZOOM_STEP);
    else if (k === '-' || k === '_') zoomBy(1 / ZOOM_STEP);
    else if (k === 'f' || k === 'F') fit();
    else if (k === 'n' || k === 'N') { if (L?.notes.length) { setNotesOpen((v) => !v); setKeyOpen(false); } else did = false; }
    else if (/^[1-9]$/.test(k) && codes.length > 1 && codes[+k - 1]) turnTo(codes[+k - 1]!);
    else did = false;
    if (did) { e.preventDefault(); e.stopPropagation(); }
  };
  const onFocusIn = (e: ReactFocusEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.sys-cur [data-part]')?.dataset.part;
    if (id && !drag.current && (e.target as Element).matches(':focus-visible')) keepInView(id);
  };
  const onDouble = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.sys-cur [data-part][data-opens]');
    if (el) { e.stopPropagation(); dive(el.dataset.part!); }
  };
  const onEnter = useCallback((id: string) => apiRef.current.dive(id), []);
  const apiRef = useRef({ dive });
  apiRef.current.dive = dive;

  // ---------------------------------------------------------------- what this frame draws
  const cam = camRef.current;
  const dv = dvRef.current;
  const door = cam && L && !dv ? doorNow(cam) : null;
  const w0 = door && L ? windowOf(L, door.id) : null;
  const t = dv ? dv.t : door && w0 ? doorT(door, r0Of(w0)) : 0;
  const mini = dv ? { part: dv.part, code: dv.code, r: dv.r, s: dv.s } : door && t > 0.001 ? { part: door.id, code: door.code, r: door.r, s: door.s } : null;
  const ink = diveInk(t);
  const miniL = mini ? restOf(mini.code) : null;
  const lod = cam ? lodAt(cam.k) : 2;
  // the entered box's own words lower as its inside opens out of it
  useLayoutEffect(() => {
    const parts = curRef.current?.querySelectorAll<HTMLElement>('.sys-parts > .sys-part');
    if (!parts) return;
    for (const el of parts) {
      const mine = mini && el.dataset.part === mini.part;
      const v = mine && ink.box < 0.999 ? String(ink.box) : '';
      if (el.style.opacity !== v && (mine || el.dataset.entering != null)) { el.style.opacity = v; if (mine) el.dataset.entering = ''; else delete el.dataset.entering; }
    }
  });
  const path = s ? scopePath(model, mini && t >= 0.5 ? mini.code : code) : [];
  const shownCode = mini && t >= 0.5 ? mini.code : code;
  const shownSheet = model.sheets[shownCode];
  const shownCodes = model.byScope[shownSheet?.scope ?? scope] ?? [];
  const two = !!s && hasSimple(model, code);
  const pct = cam ? Math.round(cam.k * (mini && t >= 0.5 ? mini.s : 1) * 100) : 100;

  // the PR's number, title and state; the legend under the sheet; the parts list beside it
  const prNum = pr?.number ?? rev?.pr ?? null;
  const prTitle = pr?.title ?? rev?.title ?? '';
  const prState = pr?.state ? <span className={'sys-pr-state sys-pr-' + pr.state}><span className="sys-pr-dot" aria-hidden="true" />{STATE_WORD[pr.state]}</span> : null;
  const pickRow = (id: string) => {
    setPicked(id);
    if (LRef.current?.parts[id]) { keepInView(id); return; }
    // a part on another sheet: go to the sheet that draws it, here first, then the change's own sheet
    const there = [...(model.byScope[scope] ?? []), summary?.sheet ?? '', ...Object.keys(model.sheets)].find((c) => c && model.sheets[c] && restOf(c).parts[id]);
    if (there) travel(there, () => keepInView(id));
  };
  const aside = change && summary && layout === 'window' && onOpenFile && vw !== 'steps' ? (
    <aside className="sys-aside">
      <PartsList model={base} revision={change} files={files} summary={summary} onOpenFile={onOpenFile} selected={picked} onSelect={pickRow} onHover={setRowHover} />
    </aside>
  ) : null;
  const legend = change && summary && layout === 'window' && vw === 'after' ? (
    plan ? (
      <div className="sys-legend sys-legend-key" aria-label="Key to the plan">
        <span className="sys-lg-i"><span className="sys-sw sys-sw-added" aria-hidden="true" />new, proposed</span>
        <span className="sys-lg-i"><span className="sys-sw sys-sw-changed" aria-hidden="true" />changes, proposed</span>
        <span className="sys-lg-i"><span className="sys-sw" aria-hidden="true" />as built today</span>
      </div>
    ) : (
      <ol className="sys-legend" aria-label="The change on this sheet">
        {summary.parts.map((p, i) => (
          <li key={p.id} className={'sys-lg-i sys-ink-' + p.is + (L?.parts[p.id] ? '' : ' sys-lg-off')} title={L?.parts[p.id] ? undefined : 'On another sheet'}>
            <span className="sys-lg-n">{i + 1}</span>{p.name} {p.is}
            {p.files[0] && <span className="sys-mono sys-lg-f">{p.files[0].split('/').slice(-2).join('/')}</span>}
          </li>
        ))}
        {summary.flows.filter((f) => f.is === 'removed').map((f) => <li key={f.id} className="sys-lg-i sys-ink-removed sys-lg-gone">{f.says || f.id}</li>)}
      </ol>
    )
  ) : null;

  return (
    <div ref={root} className={'sys sys-view sys-' + layout + (plan ? ' sys-plan' : '') + (aside ? ' sys-has-aside' : '')} data-sheet={code} data-reading={two ? reading : 'full'} data-view={change ? vw : undefined} onKeyDown={onKeyDown}>
      <div className="sys-bar">
        <nav className="sys-crumbs" aria-label="Where this sheet is">
          {project && <span className="sys-crumb">{project}</span>}
          {path.map(([id, label], i) => {
            const here = i === path.length - 1;
            return (
              <span key={id} className="sys-crumb-w">
                {(project || i > 0) && <span className="sys-crumb-sep" aria-hidden="true">/</span>}
                {here ? (
                  <span className="sys-crumb sys-here" aria-current="location">{label}</span>
                ) : (
                  <button type="button" className="sys-crumb sys-crumb-b" title={`Up to ${label}`} onClick={() => travel(childFor(id) ?? model.root)}>{label}</button>
                )}
              </span>
            );
          })}
          {shownSheet && <span className="sys-code">{shownCode}</span>}
        </nav>
        {vw === 'steps' && stepsModel ? (
          <div className="sys-kind" aria-label="Steps">{rev?.steps?.title || 'Steps'}</div>
        ) : shownSheet && shownCodes.length > 1 ? (
          <div className="sys-chips" role="group" aria-label="Sheets here">
            {shownCodes.map((c, i) => {
              const sh = model.sheets[c]!;
              const on = c === shownCode;
              return (
                <button key={c} type="button" className="sys-chip-b" aria-current={on ? 'page' : undefined} title={`${kindLabel(sh.kind)} (${i + 1}): ${sh.question ?? sh.title}`} aria-label={`${kindLabel(sh.kind)}: ${sh.title}`} onClick={() => !on && turnTo(c)}>
                  {on ? kindLabel(sh.kind) : <span className="sys-chip-k">{c[0]}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          shownSheet && <div className="sys-kind" aria-label="Sheet kind">{kindLabel(shownSheet.kind)}</div>
        )}
        <div className="sys-tools">
          {two && onReading && vw !== 'steps' && (
            <div className="sys-seg" role="radiogroup" aria-label="Reading">
              {(['simple', 'full'] as const).map((r) => (
                <button key={r} type="button" role="radio" aria-checked={reading === r} className="sys-seg-o" data-on={reading === r ? '' : undefined} onClick={() => pressReading(r)}>
                  {r === 'simple' ? 'Simple' : 'Full'}
                </button>
              ))}
            </div>
          )}
          {prNum != null && !plan && (
            onOpenDetails ? (
              <button type="button" className="sys-pr sys-pr-b" title={prTitle || undefined} aria-label={`PR ${prNum}${prTitle ? `: ${prTitle}` : ''}, opens details`} onClick={() => onOpenDetails()}>
                <span>PR {prNum}</span>{prState}
              </button>
            ) : (
              <span className="sys-pr" title={prTitle || undefined}><span>PR {prNum}</span>{prState}</span>
            )
          )}
          {rev && onView && (
            <div className="sys-seg" role="radiogroup" aria-label={plan ? 'As built or as planned' : 'Before or after'}>
              {(['before', 'after', ...(canSteps ? ['steps' as const] : [])] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={vw === v} className="sys-seg-o" data-on={vw === v ? '' : undefined} onClick={() => vw !== v && onView(v)}>
                  {v === 'steps' ? 'Steps' : v === 'before' ? (plan ? 'As built' : 'Before') : plan ? 'As planned' : 'After'}
                </button>
              ))}
            </div>
          )}
          {summary && <Tally s={summary} />}
          {layout === 'pane' && onOpenFull && (
            <button type="button" className="sys-btn" onClick={() => onOpenFull()}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5L8 8M6.5 3.5h-3v9h9v-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Open full window
            </button>
          )}
          {onClose && (
            <button type="button" className="sys-icon-btn" aria-label="Close" onClick={() => onClose()}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          )}
        </div>
      </div>
      <div className="sys-main">
      <div className="sys-col">
      {stepsModel && <StepsStage model={stepsModel} epoch={epoch} />}
      <div
        ref={stageRef}
        tabIndex={0}
        className={'sys-stage' + (dragging ? ' sys-drag' : '')}
        style={stepsModel ? { display: 'none' } : layout === 'pane' ? { height: stageH } : undefined}
        role="group"
        aria-label={s ? `${s.title}: ${s.question ?? ''}` : 'Drawing'}
        aria-roledescription="drawing"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClickCapture={(e) => { if (drag.current?.moved) { e.stopPropagation(); e.preventDefault(); } }}
        onClick={(e) => {
          if ((e.target as Element).closest('.sys-card-pop, .sys-zoom')) return;
          setKeyOpen(false); setNotesOpen(false);
          // a marked part picked on the sheet picks its row in the parts list
          const el = (e.target as HTMLElement).closest<HTMLElement>('.sys-cur [data-part][data-status]');
          setPicked(el ? el.dataset.part! : null);
        }}
        onDoubleClick={onDouble}
        onFocus={onFocusIn}
      >
        {L && cam && (
          <div ref={worldRef} className="sys-world" style={{ transform: xf(cam) }}>
            {ghost && (
              <div ref={ghostRef} key={ghost.n} className="sys-layer sys-ghost" aria-hidden="true">
                <Sheet layout={ghost.L} model={ghost.model} lod={lod} />
              </div>
            )}
            <div ref={curRef} className="sys-layer sys-cur" style={{ opacity: ink.around < 0.999 ? ink.around : undefined, visibility: ink.around < 0.001 ? 'hidden' : undefined }}>
              <Sheet layout={L} model={model} lod={lod} live={!dv} onEnter={onEnter} picked={rowHover ?? picked} />
            </div>
            {mini && miniL && cam && (
              <div
                className="sys-mini"
                aria-hidden="true"
                data-win={mini.part}
                style={{
                  left: mini.r.x, top: mini.r.y, width: miniL.w, height: miniL.h, transform: `scale(${mini.s})`,
                  opacity: ink.ink < 0.999 ? ink.ink : undefined,
                  clipPath: ink.unroll < 0.999 ? `polygon(-40px -40px, ${miniL.w + 40}px -40px, ${miniL.w + 40}px ${lerp(mini.r.h / mini.s, miniL.h + 40, ink.unroll)}px, -40px ${lerp(mini.r.h / mini.s, miniL.h + 40, ink.unroll)}px)` : undefined,
                  ['--sys-mini-paper' as string]: ink.paper,
                }}
              >
                <Sheet layout={miniL} model={model} lod={lodAt(cam.k * mini.s)} />
              </div>
            )}
          </div>
        )}
        {!s && <div className="sys-empty">This drawing has no sheet {sheet ? `called ${sheet}` : 'yet'}.</div>}
        {s && (
          <div className="sys-zoom" role="group" aria-label="Zoom">
            <button type="button" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out" title="Zoom out (-)">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            </button>
            <button type="button" className="sys-pct" onClick={fit} aria-label={`Sheet at ${pct} percent. Fit the sheet`} title="Fit the sheet (F)">{pct}%</button>
            <button type="button" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom in" title="Zoom in (+)">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8M6 2v8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            </button>
            <span className="sys-zsep" aria-hidden="true" />
            <button type="button" aria-expanded={keyOpen} onClick={() => { setKeyOpen((v) => !v); setNotesOpen(false); }} title="Symbols and keys">Key</button>
          </div>
        )}
        {keyOpen && <KeyCard notes={!!L?.notes.length} sheets={codes.length > 1} keys={keys} pane={layout === 'pane'} change={change ? (plan ? 'plan' : rev ? 'review' : 'gate') : null} />}
        {notesOpen && L && <NotesCard notes={L.notes} />}
        <div className="sys-sr" aria-live="polite">{said}</div>
      </div>
      {legend}
      </div>
      {aside}
      </div>
    </div>
  );
}

const STATE_WORD = { open: 'Open', merged: 'Merged', closed: 'Closed' } as const;

/** "3 added · 5 changed · 1 removed", each in its ink. */
function Tally({ s }: { s: NonNullable<ReturnType<typeof changeSummary>> }) {
  const bits = [s.added && ['added', `${s.added} added`], s.changed && ['changed', `${s.changed} changed`], s.removed && ['removed', `${s.removed} removed`]].filter((b): b is [string, string] => !!b);
  if (!bits.length) return <span className="sys-tally">No drawn part changed</span>;
  return (
    <span className="sys-tally">
      {bits.map(([k, t], i) => <span key={k}>{i > 0 && <span className="sys-tally-sep"> · </span>}<span className={'sys-ink-' + k}>{t}</span></span>)}
    </span>
  );
}
