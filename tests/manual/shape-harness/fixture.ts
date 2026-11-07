// The harness's board: "Snooze announcement", the Inbox feature that merged as
// PR #2547, in the Shape format (@plannotator/core/shape). The drawn views are
// the approved prototype's Picture and How it works rewritten as agent HTML;
// the code files and patch are #2547's own (files/). Thread messages are
// invented for the harness.
import type { ShapeBoard, ShapeCodeView, ShapeRef } from '@plannotator/core/shape';
import patch from './files/snooze.patch.txt?raw';
import intro from './files/snoozeIntro.ts.txt?raw';
import server from './files/inbox-snooze-intro.ts.txt?raw';
import rows from './files/snoozeIntroRows.ts.txt?raw';
import dialog from './files/SnoozeIntro.tsx.txt?raw';
import tryIt from './files/snoozeIntroTry.ts.txt?raw';
import { SNOOZE_EXAMPLES } from './examples';

export const PR_URL = 'https://github.com/backnotprop/plannotator/pull/2547';

const P = {
  who: 'packages/server/inbox-snooze-intro.ts',
  server: 'packages/server/inbox.ts',
  config: 'packages/shared/config.ts',
  when: 'packages/inbox/snoozeIntro.ts',
  rows: 'packages/inbox/snoozeIntroRows.ts',
  app: 'packages/inbox/App.tsx',
  api: 'packages/inbox/api.ts',
  board: 'packages/inbox/board/BoardPage.tsx',
  dialog: 'packages/inbox/components/SnoozeIntro.tsx',
  css: 'packages/inbox/inbox.css',
  tryIt: 'packages/inbox/snoozeIntroTry.ts',
  tour: 'packages/inbox/tour/model.ts',
};

/** The files the whole-file viewer can open. */
export const SOURCES: Record<string, string> = {
  [P.when]: intro,
  [P.who]: server,
  [P.rows]: rows,
  [P.dialog]: dialog,
  [P.tryIt]: tryIt,
};

/** What the stand-in agent can change. */
export interface SnoozeModel {
  calmKnown: boolean;
  onceLabel: string;
  neverLabel: string;
  calmReq: boolean;
  /** v2 said "Not now? Snooze it."; v3 says it is new. */
  words: 'old' | 'new';
}

export const CALM_AS_BUILT = [
  'you read the thread 5 s or more, and left nothing typed',
  '2+ threads you read and left a day ago; 3+ rows',
  'the page open 60 s or more',
  'no tour, update or other one-time dialog this load',
  'nothing open over the page, no toast; settled 2.5 s',
];

export const V3: SnoozeModel = { calmKnown: false, onceLabel: 'Shown once, ever', neverLabel: 'after it closes', calmReq: false, words: 'new' };
export const V2: SnoozeModel = { ...V3, words: 'old' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clock = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';

// ───────────────────────── Picture ─────────────────────────

const PICTURE_CSS = `
.pic { max-width: 1180px; margin: 0 auto; }
.cap { margin: 0 0 14px; font-size: 15px; font-weight: 600; text-align: center; }
.grid { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(0, 530px) minmax(150px, 1fr); grid-template-rows: auto auto auto; align-items: center; }
.dlg { grid-column: 2; grid-row: 1 / span 3; display: grid; grid-template-rows: subgrid; background: var(--surface); border-radius: 18px; padding: 16px 16px 18px; box-shadow: 0 30px 60px -30px rgb(0 0 0 / .35), 0 0 0 1px var(--rule); }
.art { background: color-mix(in oklab, var(--sunk) 70%, var(--surface)); border-radius: 12px; padding: 14px 14px 16px; display: flex; gap: 12px; align-items: flex-end; justify-content: center; overflow: hidden; }
.menu { width: 218px; flex: none; background: var(--raise); border-radius: 10px; padding: 5px; box-shadow: 0 0 0 1px var(--rule); font-size: 13.5px; }
.mi { position: relative; display: flex; align-items: center; gap: 8px; height: 29px; padding: 0 9px; border-radius: 6px; }
.mi .when { margin-left: auto; color: var(--grey); font-size: 12.5px; }
.mi.head { color: var(--grey); font-size: 12.5px; }
.mi.lit { background: var(--sunk); }
.pointer { position: absolute; right: 26px; top: 12px; }
.msep { height: 1px; background: var(--rule); margin: 4px 6px; }
.toast { flex: none; margin-bottom: -4px; display: flex; align-items: center; gap: 7px; padding: 8px 10px; background: var(--raise); border-radius: 10px; box-shadow: 0 8px 24px -12px rgb(0 0 0 / .3), 0 0 0 1px var(--rule); font-size: 12.5px; white-space: nowrap; }
.toast .g { color: var(--grey); }
.toast .undo { font-weight: 600; margin-left: 6px; }
.text { padding: 14px 6px 2px; }
.new { color: var(--mark); font-weight: 600; font-size: 14px; display: inline-block; }
.h { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; margin: 6px 0 8px; }
.body { margin: 0; font-size: 15px; line-height: 1.55; color: var(--ink2); }
.hint { margin: 12px 0 0; display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--grey); }
.chip { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; background: var(--sunk); color: var(--ink); flex: none; }
.acts { display: flex; gap: 8px; justify-content: flex-end; padding: 14px 6px 0; }
.btn { display: inline-flex; align-items: center; height: 36px; padding: 0 16px; border-radius: 9px; font-weight: 600; font-size: 14px; }
.btn.ghost { box-shadow: inset 0 0 0 1px var(--rule); }
.btn.pri { background: var(--ink); color: var(--paper); }
.co { display: flex; align-items: center; font-size: 14.5px; line-height: 1.4; color: var(--ink2); }
.co i { flex: none; width: 30px; height: 1px; background: color-mix(in oklab, var(--ink) 45%, transparent); }
.co.l { grid-column: 1; justify-content: flex-end; text-align: right; }
.co.r { grid-column: 3; }
.co.l i { margin-left: 10px; } .co.r i { margin-right: 10px; }
.co .mk { padding: 2px 4px; max-width: 30ch; }
.r1 { grid-row: 1; } .r2 { grid-row: 2; } .r3 { grid-row: 3; }
.was { display: block; color: var(--grey); text-decoration: line-through; text-decoration-color: color-mix(in oklab, var(--grey) 60%, transparent); }
.now { color: var(--mark); font-weight: 500; }
@container board (max-width: 700px) {
  .cap { text-align: left; font-size: 14px; margin-bottom: 8px; }
  .grid { grid-template-columns: 1fr; grid-template-rows: none; row-gap: 8px; }
  .dlg { grid-column: 1; grid-row: 2; display: flex; flex-direction: column; }
  .co.l, .co.r { grid-column: 1; justify-content: flex-start; text-align: left; font-size: 14px; }
  .co i { display: none; }
  .co::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: color-mix(in oklab, var(--ink) 45%, transparent); margin-right: 8px; flex: none; }
  .r1 { grid-row: 1; } .r2 { grid-row: 3; } .l.r3 { grid-row: 4; } .r.r3 { grid-row: 5; }
  .was { display: inline; }
  .art { flex-direction: column; align-items: stretch; }
  .menu { width: 100%; max-width: 250px; }
  .toast { align-self: flex-end; margin-top: 10px; }
  .h { font-size: 20px; }
}`;

function picture(m: SnoozeModel): string {
  const menu = [['Later today', '1:00 PM'], ['Tomorrow', 'Wed 8:00 AM'], ['In 3 days', 'Fri 8:00 AM'], ['Next week', 'Mon 8:00 AM']]
    .map(([label, when]) => `<div class="mi${label === 'Tomorrow' ? ' lit' : ''}">${label}<span class="when">${when}</span>${label === 'Tomorrow' ? '<svg class="pointer" width="16" height="22" viewBox="0 0 16 22"><path d="M1 1 L1 17 L5 13.4 L7.8 20 L10.6 18.8 L7.9 12.4 L13 12.4 Z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>' : ''}</div>`)
    .join('');
  const words = m.words === 'new'
    ? `<span class="was">“Not now? Snooze it.”<span data-ref="2"></span></span>→ <span class="now">says it’s new</span><span data-ref="3"></span>`
    : `“Not now? Snooze it.”<span data-ref="2"></span>`;
  return `<div class="pic">
  <p class="cap" data-step="0">The Snooze announcement · in the Inbox, on your computer and your own phone<span data-ref="1"></span></p>
  <div class="grid">
    <div class="dlg" data-step="1">
      <div class="art" data-mark="p-art" aria-hidden="true">
        <div class="menu"><div class="mi head">‹ Snooze until</div>${menu}<div class="msep"></div><div class="mi">Pick a time…</div></div>
        <div class="toast">${clock}<b>Snoozed</b><span class="g">Wed 8:00 AM</span><span class="undo">Undo</span><span class="g">×</span></div>
      </div>
      <div class="text">
        <div class="new" data-mark="p-new">New</div>
        <div class="h" data-mark="p-title">Snooze a thread until later</div>
        <p class="body" data-mark="p-body">Pick later today, tomorrow, in 3 days, next week, or a time you choose. The thread waits in Snoozed and comes back on its own. Undo puts it back at once.</p>
        <p class="hint" data-mark="p-hint"><span class="chip">${clock}</span>Right-click a thread, or click the clock at the top of an open thread.</p>
      </div>
      <div class="acts"><span class="btn ghost" data-mark="p-gotit">Got it</span><span class="btn pri" data-mark="p-try" data-code="${P.tryIt}#L1">Try it</span></div>
    </div>
    <div class="co l r1" data-step="2"><span data-mark="p-who">Not before 2 days since you started, and never if you’ve snoozed</span><span data-ref="4"></span><i></i></div>
    <div class="co r r2" data-step="3"><i></i><span data-mark="p-words">${words}</span></div>
    <div class="co l r3" data-step="4"><span data-mark="p-once">${esc(m.onceLabel)}</span><span data-ref="5"></span><i></i></div>
    <div class="co r r3" data-step="4"><i></i><span data-mark="p-trylbl">Try it opens the real Snooze menu on the thread you just left</span></div>
  </div>
</div>`;
}

// ───────────────────────── How it works ─────────────────────────
// When (a ruler over the flow), how (the rules, inside "all must hold") and
// what (the dialog, then each way out). Wide: a 1180 × 520 canvas the board
// scales to fit. Narrow: the same parts stacked (`tall`).

const HOW_CSS = `
.c { position: relative; width: 1180px; height: 520px; }
.c > * { position: absolute; }
.svg { left: 0; top: 0; pointer-events: none; }
.ln { fill: none; stroke: color-mix(in oklab, var(--ink) 62%, transparent); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.ruler { fill: none; stroke: color-mix(in oklab, var(--mark) 70%, transparent); stroke-width: 1.6; stroke-linecap: round; }
.zone { font: 600 11.5px/1 var(--font-mono, ui-monospace, monospace); letter-spacing: .08em; text-transform: uppercase; color: var(--grey); white-space: nowrap; }
.zone.in { position: static; margin: 0 0 10px 2px; }
.rl { font-size: 14px; color: var(--grey); text-align: center; }
.rl.mid { color: var(--mark); font-weight: 600; font-size: 14.5px; }
.al { font-size: 14px; color: var(--grey); white-space: nowrap; line-height: 28px; height: 28px; text-align: center; }
.al.on { height: 60px; display: flex; align-items: center; justify-content: center; white-space: normal; line-height: 1.3; }
.al.on > span { background: var(--paper); padding: 3px 4px; max-width: 150px; }
.box { display: flex; }
.bi { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; gap: 3px; padding: 10px 14px; border-radius: 14px; background: var(--surface); box-shadow: 0 0 0 1.6px color-mix(in oklab, var(--ink) 78%, transparent); font-size: 15px; line-height: 1.35; }
.bi b { font-weight: 600; }
.bi span { color: var(--grey); font-size: 13.5px; }
.box.muted .bi, .box.quiet .bi { box-shadow: 0 0 0 1.4px color-mix(in oklab, var(--ink) 35%, transparent); background: transparent; }
.box.muted .bi b { color: var(--grey); }
.box.what .bi { box-shadow: 0 0 0 1.8px var(--mark); background: color-mix(in oklab, var(--mark) 8%, var(--surface)); align-items: flex-start; text-align: left; padding: 14px 18px; }
.bi .new { color: var(--mark); font-weight: 600; font-size: 12.5px; }
.mini { display: flex; gap: 6px; margin-top: 8px; align-self: flex-end; }
.mini span { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; font-size: 12px; border-radius: 7px; font-weight: 600; color: var(--ink); box-shadow: inset 0 0 0 1px var(--rule); }
.mini span.pri { background: var(--ink); color: var(--paper); box-shadow: none; }
.bound { border: 1.5px dashed color-mix(in oklab, var(--ink) 32%, transparent); border-radius: 22px; padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 12px; background: color-mix(in oklab, var(--paper) 60%, transparent); }
.rules { padding: 10px 14px 12px; background: var(--surface); border-radius: 12px; box-shadow: 0 0 0 1px var(--rule); }
.rt { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.rt .shp-rb { margin-left: 6px; }
.rules ul { margin: 0; padding: 0; list-style: none; font-size: 14.5px; line-height: 1.6; }
.rules li::before { content: ""; display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: color-mix(in oklab, var(--ink) 45%, transparent); margin: 0 9px 2px 1px; vertical-align: middle; }
.rules li.unknown { color: var(--grey); font-style: italic; }
.rules li.unknown::before { background: transparent; box-shadow: inset 0 0 0 1px var(--grey); }
.dim { color: var(--grey); }
/* tall */
.t { max-width: 460px; margin: 0 auto; display: flex; flex-direction: column; }
.t .zone { margin: 4px 0 8px; }
.t .bi { min-height: 56px; }
.down { display: flex; align-items: center; gap: 10px; padding-left: calc(50% - 8px); height: 40px; }
.down .al { line-height: 1.2; height: auto; white-space: normal; text-align: left; }
.split { margin: 10px 4px 0; font-size: 14px; color: var(--grey); line-height: 1.4; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
.pair .al { display: block; margin: 4px 0; }`;

function rules(m: SnoozeModel): string {
  const calm = m.calmKnown ? ['not typing a reply', ...CALM_AS_BUILT.slice(1)] : ['not typing a reply', '+ the calm-moment guards that remain'];
  return `<div class="rules" data-mark="how-who" data-code="${P.who}#L10">
    <div class="rt">Who · the Inbox decides<span data-ref="6"></span></div>
    <ul><li><span data-mark="who-days">at least 2 days since you started</span><span data-ref="4"></span></li><li>never snoozed <span class="dim">(once any snooze succeeds)</span></li><li>not shown before</li><li>you, not a guest on your tailnet</li></ul>
  </div>
  <div class="rules" data-mark="how-calm" data-code="${P.when}#L3">
    <div class="rt">When · the page decides<span data-ref="7"></span></div>
    <ul>${calm.map((l) => (l.startsWith('+') ? `<li class="unknown"><span data-mark="calm-more">${esc(l)}</span></li>` : `<li>${esc(l)}</li>`)).join('')}</ul>
  </div>`;
}

const W = 1180;
const A = { x: 0, y: 156, w: 196, h: 100 };
const BND = { x: 290, y: 92, w: 490 };
const D = { x: 860, y: 146, w: 320, h: 120 };
const T = { x: 860, y: 372, w: 152, h: 120 };
const N = { x: 1028, y: 372, w: 152, h: 120 };
const F = { x: 0, y: 392, w: 196, h: 80 };
const MID = 206;
const hr = (x: number, y: number) => `M${x - 9} ${y - 6} L${x} ${y} L${x - 9} ${y + 6}`;
const hl = (x: number, y: number) => `M${x + 9} ${y - 6} L${x} ${y} L${x + 9} ${y + 6}`;
const hd = (x: number, y: number) => `M${x - 6} ${y - 9} L${x} ${y} L${x + 6} ${y - 9}`;
const at = (b: { x: number; y: number; w?: number; h?: number }) => `left:${b.x}px;top:${b.y}px;${b.w ? `width:${b.w}px;` : ''}${b.h ? `height:${b.h}px;` : ''}`;

function howWide(m: SnoozeModel): string {
  const ax = A.x + A.w / 2, dx = D.x + D.w / 2;
  const path = (step: number, d: string, edge = '') => `<g data-step="${step}"${edge ? ` data-edge="${edge}"` : ''}><path class="ln draw" d="${d}" pathLength="1"/></g>`;
  const label = (step: number, x: number, y: number, text: string, edge = '') => `<div class="al" data-step="${step}"${edge ? ` data-edge="${edge}"` : ''} style="left:${x - 150}px;top:${y - 14}px;width:300px">${text}</div>`;
  const onLabel = (step: number, x: number, y: number, text: string, edge = '') => `<div class="al on" data-step="${step}"${edge ? ` data-edge="${edge}"` : ''} style="left:${x - 80}px;top:${y - 30}px;width:160px"><span>${text}</span></div>`;
  return `<div class="c">
  <div class="zone" data-step="0" style="left:0;top:0">When</div>
  <svg class="svg" width="${W}" height="520" viewBox="0 0 ${W} 520" aria-hidden="true">
    <g data-step="0"><path class="ruler draw" d="M${ax} 50 H${dx} M${ax} 42 V58 M${dx} 42 V58" pathLength="1"/></g>
    ${path(2, `M${A.x + A.w + 4} ${MID} H${BND.x - 4} ${hr(BND.x - 4, MID)}`, 'checks')}
    ${path(4, `M${BND.x + BND.w + 4} ${MID} H${D.x - 4} ${hr(D.x - 4, MID)}`, 'all-hold')}
    ${path(3, `M${BND.x - 4} ${F.y + F.h / 2} H${F.x + F.w + 4} ${hl(F.x + F.w + 4, F.y + F.h / 2)}`, 'any-fails')}
    ${path(5, `M${T.x + T.w / 2} ${D.y + D.h + 4} V${T.y - 4} ${hd(T.x + T.w / 2, T.y - 4)}`, 'try-it')}
    ${path(6, `M${N.x + N.w / 2} ${D.y + D.h + 4} V${N.y - 4} ${hd(N.x + N.w / 2, N.y - 4)}`, 'closes')}
  </svg>
  ${label(2, (A.x + A.w + BND.x) / 2, MID - 16, 'checks', 'checks')}
  ${label(4, (BND.x + BND.w + D.x) / 2, MID - 16, 'all hold', 'all-hold')}
  ${label(3, (F.x + F.w + BND.x) / 2, F.y + F.h / 2 - 16, 'any fails', 'any-fails')}
  ${onLabel(5, T.x + T.w / 2, (D.y + D.h + T.y) / 2, 'Try it', 'try-it')}
  ${onLabel(6, N.x + N.w / 2, (D.y + D.h + N.y) / 2, `<span data-mark="how-never">${esc(m.neverLabel)}</span>`, 'closes')}
  <div class="rl" data-step="0" style="left:${ax - 100}px;top:64px;width:200px">you leave the thread</div>
  <div class="rl mid" data-step="0" style="left:${(ax + dx) / 2 - 120}px;top:20px;width:240px">a calm moment</div>
  <div class="rl" data-step="0" style="left:${dx - 100}px;top:64px;width:200px">it opens, once</div>
  <div class="box" data-step="1" style="${at(A)}"><div class="bi" data-mark="how-leave"><b>A quiet moment after you leave a thread</b><span>that still waits on you</span></div></div>
  <div class="bound" data-step="2" style="${at(BND)}"><div class="zone in">How · all must hold</div>${rules(m)}</div>
  <div class="box muted" data-step="3" style="${at(F)}"><div class="bi" data-mark="how-nothing"><b>Nothing shows</b><span>the next leave is the next chance</span></div></div>
  <div class="zone" data-step="4" style="left:${D.x}px;top:${D.y - 32}px">What</div>
  <div class="box what" data-step="4" style="${at(D)}"><div class="bi" data-mark="how-dialog" data-code="${P.dialog}#L1"><span class="new">New</span><b>Snooze a thread until later</b><span class="mini"><span>Got it</span><span class="pri">Try it</span></span></div></div>
  <div class="box" data-step="5" style="${at(T)}"><div class="bi" data-mark="how-menu" data-code="${P.tryIt}#L1"><b>The real Snooze menu</b><span>on that thread; nothing snoozed until you pick</span></div></div>
  <div class="box quiet" data-step="6" style="${at(N)}"><div class="bi" data-mark="how-again"><b>Never shown again</b></div></div>
</div>`;
}

function howTall(m: SnoozeModel): string {
  const down = (step: number, label?: string, edge = '') => `<div class="down" data-step="${step}"${edge ? ` data-edge="${edge}"` : ''}><svg width="16" height="34" viewBox="0 0 16 34" aria-hidden="true"><path class="ln draw" pathLength="1" d="M8 2 V31 M2 24 L8 31 L14 24"/></svg>${label ? `<span class="al">${label}</span>` : ''}</div>`;
  return `<div class="t">
  <div class="zone" data-step="0">When</div>
  <div class="box" data-step="1"><div class="bi" data-mark="how-leave"><b>A quiet moment after you leave a thread</b><span>that still waits on you</span></div></div>
  ${down(2, 'checks', 'checks')}
  <div class="bound" data-step="3"><div class="zone in">How · all must hold</div>${rules(m)}</div>
  <div class="split" data-step="4" data-edge="any-fails" data-mark="how-nothing">any fails: <b>nothing shows</b>, the next leave is the next chance</div>
  ${down(5, 'all hold', 'all-hold')}
  <div class="zone" data-step="6">What</div>
  <div class="box what" data-step="7"><div class="bi" data-mark="how-dialog" data-code="${P.dialog}#L1"><span class="new">New</span><b>Snooze a thread until later</b><span class="mini"><span>Got it</span><span class="pri">Try it</span></span></div></div>
  <div class="pair" data-step="8">
    <div><span class="al" data-edge="try-it">Try it</span><div class="box"><div class="bi" data-mark="how-menu" data-code="${P.tryIt}#L1"><b>The real Snooze menu</b><span>nothing snoozed until you pick</span></div></div></div>
    <div><span class="al" data-edge="closes"><span data-mark="how-never">${esc(m.neverLabel)}</span></span><div class="box quiet"><div class="bi" data-mark="how-again"><b>Never shown again</b></div></div></div>
  </div>
</div>`;
}

// ───────────────────────── What to know ─────────────────────────

function know(m: SnoozeModel): string {
  return `It shows at a quiet moment, after you leave a thread that still waits on you, and never over a half-typed reply${m.calmReq ? ', and only when the page is calm' : ''}. You get it **2 days** after you started, unless you already snoozed.[^4][^9]\n\nTry it opens the real Snooze menu on the thread you just left. Nothing is snoozed until you pick. ${m.onceLabel}.[^5] It goes out with 0.28.48 ([#2547](${PR_URL})); no question waits on you.`;
}

// ───────────────────────── Code ─────────────────────────

export function code(stage: 'before' | 'after'): ShapeCodeView {
  const files = [P.who, P.when, P.rows, P.dialog, P.tryIt].map((path) => ({ path, line: path === P.who ? 14 : path === P.when ? 3 : 1 }));
  if (stage === 'before') {
    return {
      stage,
      patch: patch.split(/(?=^diff --git )/m).filter((p) => p.includes(`b/${P.tour}`)).join(''),
      source: 'Before implementation · nothing applied · 1 proposed diff',
      planned: [
        [{ path: P.who, kind: 'new' }, { path: P.server, kind: 'change' }, { path: P.config, kind: 'change' }],
        [{ path: P.when, kind: 'new' }, { path: P.app, kind: 'change' }],
        [{ path: P.dialog, kind: 'new' }],
        [],
      ],
      guide: {
        title: 'One-time Snooze announcement',
        intent: 'Not built yet. The four steps it will take, and where. Diffs show here once the change exists.',
        sections: [
          { title: 'Who gets it', overview: 'The server will decide: someone who first used the Inbox 2 days ago or more, never snoozed, not shown yet. The first page to claim it shows it; a tailnet guest never.', diffs: [] },
          { title: 'When it shows', overview: 'The page will decide, at a calm moment right after you leave a thread that still waits on you. Never at load, never over a half-typed reply.', diffs: [] },
          { title: 'What it shows', overview: 'Approved direction B: the real “Snooze until” menu, the pointer on Tomorrow, the Undo toast, in the one-time dialog shell.', diffs: [] },
          { title: 'Try it', overview: 'Try it will open the real Snooze menu on the thread you just left, and never snooze anything itself.\n\nOne change is proposed already: the tour names Snooze for new users, who never get the dialog.', diffs: [{ file: P.tour, summary: 'Proposed: the tour’s “Also in your Inbox” card gains Snooze.' }] },
        ],
      } as ShapeCodeView['guide'],
    };
  }
  return {
    stage,
    patch,
    files,
    source: `From [#2547](${PR_URL}) · merged · 12 of 24 files`,
    guide: {
      title: 'One-time Snooze announcement',
      intent: 'Snooze is new, so the Inbox tells you about it once, at a calm moment, with the real menu as its picture.',
      sections: [
        {
          title: 'Who gets it',
          overview: `The Inbox decides, on the server. A release build offers it to someone who first used the Inbox [2 days ago or more](code:${P.who}#L14), has never snoozed, and has not seen it.\n\nThe first page to claim it gets \`show: true\`: your computer or your own phone, never a tailnet guest.`,
          diffs: [
            { file: P.who, summary: 'The rules: first use from the event log, the 2-day tenure, never snoozed, not shown yet.' },
            { file: P.server, summary: 'The claim route `POST /api/inbox/snooze-intro`, the upgrade backfill, and the snooze mark.' },
            { file: P.config, summary: 'What config.json keeps: `inboxSnoozeIntro`.' },
          ],
        },
        {
          title: 'When it shows',
          overview: `The page decides. Never at load: right after you leave a thread that still waits on you, if you read it 5 s or more and left nothing typed.\n\nThe page must be calm too: open 60 s, 3+ rows, no tour, update or other one-time dialog this load, nothing over it ([the rules](code:${P.when}#L3)).`,
          diffs: [
            { file: P.when, summary: 'The calm-moment gate and its thresholds.' },
            { file: P.rows, summary: 'Which rows count as threads that wait on you.' },
            { file: P.app, summary: 'Wires the gate into the Inbox and stands the other one-time lines down while it is due.' },
            { file: P.board, summary: 'The Board’s own intro counts as a one-time dialog this load.' },
            { file: P.api, summary: 'The claim call.' },
          ],
        },
        {
          title: 'What it shows',
          overview: 'A one-time dialog in the shell the list options and voice intros use. Its picture is approved direction B: two of your own rows, the real “Snooze until” menu with the pointer on Tomorrow, and the Undo toast.\n\nGot it, Try it, Escape or a click outside close it. Every way out is final: the claim stamped it.',
          diffs: [
            { file: P.dialog, summary: 'The dialog and its static picture, in your own theme.' },
            { file: P.css, summary: 'The picture’s layout.' },
          ],
        },
        {
          title: 'Try it',
          overview: 'Try it opens the real Snooze menu on the thread you just left, as your own click would, and stops there. Nothing is snoozed until you pick.\n\nNew users never get the dialog, so the tour names Snooze for them.',
          diffs: [
            { file: P.tryIt, summary: 'Opens the header clock, the row’s menu, or the phone’s ⋯ sheet.' },
            { file: P.tour, summary: 'The tour’s “Also in your Inbox” card gains Snooze.' },
          ],
        },
      ],
    } as ShapeCodeView['guide'],
  };
}

// ───────────────────────── references and the board ─────────────────────────

export const REFS: ShapeRef[] = [
  { n: 1, kind: 'message', title: '“The picture is right.”', sub: 'You · 02:25 · in this thread', target: 'm-0225' },
  { n: 2, kind: 'image', title: 'Approved: B, “The real menu”', sub: 'approval shots · desktop and phone', target: 'files/B-desktop-light.png',
    images: [{ src: 'files/B-desktop-light.png', alt: 'B, desktop, light' }, { src: 'files/B-phone-light.png', alt: 'B, phone, light' }] },
  { n: 3, kind: 'image', title: 'The build, as the thread showed it', sub: 'screenshot · desktop, light', target: 'files/built-desktop-light.png' },
  { n: 4, kind: 'message', title: '“Make it 2 days”', sub: 'You · 22:05 · in this thread', target: 'm-2205' },
  { n: 5, kind: 'file', title: 'Every dismiss is final', sub: P.when, target: P.when, line: 16 },
  { n: 6, kind: 'file', title: 'Who gets it', sub: P.who, target: P.who, line: 10 },
  { n: 7, kind: 'file', title: 'When it may show', sub: P.when, target: P.when, line: 3 },
  { n: 8, kind: 'pr', title: '#2547 Inbox: one-time Snooze announcement', sub: 'merged · +1,899 −8 · 24 files', target: PR_URL },
  { n: 9, kind: 'diff', title: 'The tour names Snooze for new users', sub: `${P.tour} · +6 −2`, target: P.tour },
];

export function snoozeBoard(m: SnoozeModel, stage: 'before' | 'after' = 'after'): ShapeBoard {
  return {
    title: 'A one-time dialog that announces Snooze',
    claim: `Merged on main ([#2547](${PR_URL})[^8]) and goes out with 0.28.48. No question waits on you.`,
    asOf: '2026-11-03T05:39:00.000Z',
    views: {
      picture: { html: picture(m), css: PICTURE_CSS },
      how: { html: howWide(m), css: HOW_CSS, width: 1180, height: 520, tall: { html: howTall(m) }, examples: SNOOZE_EXAMPLES },
      know: know(m),
      code: code(stage),
    },
    refs: REFS,
  };
}

/** The harness Thread: invented messages, so a message reference has somewhere to land. */
export const THREAD = [
  { id: 'm-2205', who: 'You', at: '22:05', text: 'Make it 2 days before anyone sees it.' },
  { id: 'm-0225', who: 'You', at: '02:25', text: 'The picture is right. Ship B.' },
  { id: 'm-0539', who: 'Claude Code', at: '05:39', text: 'Merged on main (#2547). It goes out with 0.28.48, and you don’t need to publish core for it. No question waits on you.' },
];
