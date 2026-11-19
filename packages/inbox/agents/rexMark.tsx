/**
 * The Rex status mark on an agent's icon (the owner's "jelly" marks, approved 2026-11-17: "Yes, build it"; design
 * and motion are the approved "Final: jelly"; drawing in rexMarkArt.tsx, motion in rexMark.css). For an agent in a
 * Rex pane the server puts its pane's fresh status record on the agent (`rex_mark`), drawn always. For every agent
 * (owner, 2026-11-18), while the person's "Agent status" setting is on (agentStatus.ts), the same marks from what the
 * Inbox knows (`status_mark`: working, or waiting on you in the Inbox or in the agent); a fresh Rex record wins. With
 * neither the icon is exactly today's.
 *
 * One component for every icon of an agent: `HostMark` (icons.tsx) draws it inside the icon's own box, and the
 * sidebar's animated mark (AgentMark.tsx) beside its face. No words are shown: the state's words are the mark's
 * `aria-label` and `title` only.
 *
 * Motion is CSS, transform and opacity only; each agent has its own tempo and phase (`rexMarkSeed`). The mark is
 * drawn at rest at first (everything has long arrived when a page loads); a change while shown arrives with its own
 * motion, and a waiting mark that is answered pops with a check and goes as the next one fades in. A tap, the pointer
 * resting on its row or the window coming back pops a waiting mark once more (at most every 1.5 s). Off screen, its
 * animations pause. Reduced motion: still marks, a change simply swaps them.
 *
 * Piles (a row's overlapping tiles, a thread's session pile): while any agent in it waits, the tiles spread 2 px each
 * and every waiting mark moves to the pile's outer corner, the first at the last tile's, each next one a step to its
 * left, clear of a "+N" chip. Done, idle and error marks stay on their own tile. Status never changes layout.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { InboxAgent, InboxAgentsGroup, InboxRexMark } from '@plannotator/core/inbox-types';
import { inboxAgentsNow } from '../agentsList';
import { agentStatusOn, subscribeAgentStatus } from './agentStatus';
import { RexMarkArc, RexMarkGlyph, RexMarkShape, rexMarkDiameter, rexMarkKey, rexMarkOffsets, rexMarkSeed, rexMarkWaits, type RexMarkKey, type RexMarkSize } from './rexMarkArt';

/** The state's words, for the mark's text alternative only (never shown). */
export const REX_MARK_WORDS: Record<Exclude<RexMarkKey, 'answered'>, string> = {
  working: 'Working',
  question: 'Asking a question',
  permission: 'Asking for permission',
  signin: 'Needs sign-in',
  blocked: 'Waiting on you',
  done: 'Done',
  idle: 'Idle',
  error: 'Stopped on an error',
};

/**
 * A mark as an icon draws it: Rex's pane record (`rex_mark`), or the mark the Inbox worked out for any agent
 * (`status_mark`, owner 2026-11-18), whose `where` says where a waiting agent waits: here, or in its own terminal.
 */
export type ShownMark = InboxRexMark & { where?: 'inbox' | 'terminal' };

/** A mark of an agent that waits on the person in its own terminal (its connection said so): words that say where. */
export const TERMINAL_MARK_WORDS: Record<'permission' | 'question', string> = {
  permission: 'Waiting for your permission in the agent',
  question: 'Waiting for your answer in the agent',
};

/**
 * What a mark draws. A thread waiting on the person in the Inbox (`where: 'inbox'`, no kind) draws Rex's question
 * jelly (the "?"), never the bare waiting disc; its words stay "Waiting on you".
 */
export const shownMarkKey = (mark: ShownMark): ReturnType<typeof rexMarkKey> => (mark.where === 'inbox' ? 'question' : rexMarkKey(mark));

/** The state's words for a mark (a row's spoken name carries them too: the icon's own label is not always reached). */
export const rexMarkWords = (mark: ShownMark): string =>
  mark.where === 'terminal' && (mark.kind === 'permission' || mark.kind === 'question') ? TERMINAL_MARK_WORDS[mark.kind] : REX_MARK_WORDS[rexMarkKey(mark)];

/**
 * The mark an agent's icon carries: a fresh Rex record always (shipped 2026-11-17, whatever the setting says), else,
 * while "Agent status" is on (`statusOn`), the one the Inbox worked out; null: today's icon.
 */
export function shownMarkOf(agent: InboxAgent, statusOn: boolean): ShownMark | null {
  return agent.rex_mark ?? (statusOn ? (agent.status_mark ?? null) : null);
}

const marksOf = new WeakMap<readonly InboxAgentsGroup[], { on: boolean; marks: Map<string, ShownMark> }>();

/** Every listed agent's mark, by its id, its session and the sessions it goes on from. */
function marksNow(groups: readonly InboxAgentsGroup[] | null, on: boolean): Map<string, ShownMark> | null {
  if (!groups) return null;
  const kept = marksOf.get(groups);
  if (kept && kept.on === on) return kept.marks;
  const out = new Map<string, ShownMark>();
  for (const group of groups) {
    for (const agent of group.agents) {
      const mark = shownMarkOf(agent, on);
      if (!mark) continue;
      out.set(agent.id, mark);
      out.set(agent.session, mark);
      for (const old of agent.continues ?? []) if (!out.has(old)) out.set(old, mark);
    }
  }
  marksOf.set(groups, { on, marks: out });
  return out;
}

/** One shared mark per state, kind and place: an icon re-renders only when its own agent's mark changes, not on every list. */
const sharedMarks = new Map<string, ShownMark>();
const markKey = (mark: ShownMark | null | undefined) => (mark ? `${mark.state}|${mark.kind ?? ''}|${mark.where ?? ''}` : '');
function sharedMark(key: string): ShownMark | null {
  if (!key) return null;
  let mark = sharedMarks.get(key);
  if (!mark) {
    const [state, kind, where] = key.split('|') as [InboxRexMark['state'], InboxRexMark['kind'] | '', ShownMark['where'] | ''];
    mark = { state, ...(kind ? { kind } : {}), ...(where ? { where } : {}) };
    sharedMarks.set(key, mark);
  }
  return mark;
}

/**
 * The mark an agent's icon carries now (an agent's id or one of its sessions), or null: today's icon. `statusMarks`:
 * this icon shows an agent as an agent (the sidebar's Agents list), so it carries the "Agent status" marks too while
 * the setting is on. Every other icon of an agent (a thread row, the Board, a thread's header, the sender line) carries
 * Rex's marks only: a per-agent mark there would speak for threads it is not true of (owner ruling, 2026-11-18).
 */
export function useRexMarkOf(agent: string | null | undefined, statusMarks = false): ShownMark | null {
  const read = () => (agent ? markKey(marksNow(inboxAgentsNow(), statusMarks && agentStatusOn())?.get(agent)) : '');
  return sharedMark(useSyncExternalStore(subscribeAgentStatus, read, read));
}

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The tile size a mark is drawn for, from its icon's box (as laid out; `fallback` before layout). */
function sizeOf(width: number, fallback: RexMarkSize): RexMarkSize {
  if (!width) return fallback;
  return width <= 17 ? 16 : width <= 21 ? 20 : width <= 26 ? 24 : 30;
}

/* Off screen, a mark's animations pause (one observer for all of them). */
let offscreen: IntersectionObserver | null = null;
function watchOnScreen(el: HTMLElement): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  offscreen ??= new IntersectionObserver((entries) => {
    for (const entry of entries) (entry.target as HTMLElement).toggleAttribute('data-rx-off', !entry.isIntersecting);
  });
  offscreen.observe(el);
  return () => offscreen?.unobserve(el);
}

const PILES = '.ib-atiles, .ib-ss-pile';
/** A row tile's glyph box sits this far inside the 20 px tile ((20 - 13) / 2: --ib-mark-20 and --ib-mark-20-g). */
const TILE_GLYPH_INSET = 3.5;
const PILE_FAN = 2;

/**
 * Lay out the marks of one pile: while any of its agents waits, its tiles spread 2 px each and the waiting marks
 * gather on its outer corner, side by side, clear of its "+N" chip. Read from layout boxes (never the moving marks'),
 * so a frame of motion never moves the layout; no tile changes size.
 */
export function layoutRexPile(pile: Element): void {
  const tiles = [...pile.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains('ib-atmore') && (c.classList.contains('ib-atile') || c.classList.contains('ib-mk')));
  const markOf = (tile: HTMLElement) => tile.querySelector<HTMLElement>('.ib-rxm');
  const waiting = tiles.filter((tile) => markOf(tile)?.hasAttribute('data-rx-wait'));
  const fan = waiting.length > 0 && tiles.length > 1 && !reducedMotion() ? PILE_FAN : 0;
  tiles.forEach((tile, i) => {
    tile.style.position = fan ? 'relative' : '';
    tile.style.left = fan ? `${i * fan}px` : '';
  });
  const last = tiles[tiles.length - 1];
  const chip = pile.querySelector<HTMLElement>(':scope > .ib-atmore') ?? pile.parentElement?.querySelector<HTMLElement>(':scope > .ib-agplus') ?? null;
  const gathered: HTMLElement[] = [];
  tiles.forEach((tile, i) => {
    const mark = markOf(tile);
    if (!mark) return;
    const wi = waiting.indexOf(tile);
    if (wi < 0 || tiles.length < 2 || !last) {
      mark.style.removeProperty('--rx-dx');
      return;
    }
    const step = Number(mark.dataset.rxSize) <= 16 ? 12 : 15;
    const toEnd = last.offsetLeft + last.offsetWidth + (tiles.length - 1) * fan - (tile.offsetLeft + tile.offsetWidth + i * fan);
    mark.style.setProperty('--rx-dx', `${toEnd - wi * step}px`);
    gathered.push(mark);
  });
  // A "+N" chip after the pile: no mark covers it (both read). A chip inside the pile spreads with its tiles; the
  // gathered marks move left together (keeping their steps), any other mark that reaches it on its own.
  if (!chip) return;
  const inPile = chip.parentElement === pile;
  chip.style.position = fan && inPile ? 'relative' : '';
  chip.style.left = fan && inPile ? `${tiles.length * fan}px` : '';
  const left = chip.getBoundingClientRect().left;
  const dxOf = (mark: HTMLElement) => parseFloat(mark.style.getPropertyValue('--rx-dx')) || 0;
  const overOf = (mark: HTMLElement) => {
    const right = mark.getBoundingClientRect().right;
    return right > 0 ? right + 1 - left : 0;
  };
  const over = Math.max(0, ...gathered.map(overOf));
  if (over > 0) for (const mark of gathered) mark.style.setProperty('--rx-dx', `${dxOf(mark) - over}px`);
  for (const tile of tiles) {
    const mark = markOf(tile);
    if (!mark || gathered.includes(mark)) continue;
    const own = overOf(mark);
    if (own > 0) mark.style.setProperty('--rx-dx', `${dxOf(mark) - own}px`);
  }
}

/** Piles watched for tiles coming and going (one observer each, for as long as the pile is there). */
const watchedPiles = new WeakSet<Element>();
function watchPile(pile: Element): void {
  if (watchedPiles.has(pile) || typeof MutationObserver === 'undefined') return;
  watchedPiles.add(pile);
  new MutationObserver(() => layoutRexPile(pile)).observe(pile, { childList: true });
}

type Shown = { key: RexMarkKey; arrive: '' | 'now' | 'late'; out: RexMarkKey | null; outHow: 'answered' | 'fade' | null; n: number };

/**
 * The mark. `seed`: the agent's id (its tempo and phase). `size`: its icon's box before layout (then measured).
 * `side`: the sidebar's mark (its own offsets and halo).
 */
export function RexMark({ mark, seed, size = 16, side = false }: { mark: ShownMark; seed: string; size?: RexMarkSize; side?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const key = shownMarkKey(mark);
  const [shown, setShown] = useState<Shown>({ key, arrive: '', out: null, outHow: null, n: 0 });
  const [measured, setMeasured] = useState<RexMarkSize>(size);
  // In a row's 20 px tile the icon is its 13 px glyph, centred: the mark is placed from the tile's corner.
  const [inTile, setInTile] = useState(false);
  const [pop, setPop] = useState<'' | 'a' | 'b'>('');
  const lastPop = useRef(0);
  const pileRef = useRef<Element | null>(null);

  // A change of state while shown: the new one arrives; a waiting one answered pops with a check and goes first.
  if (shown.key !== key) {
    const still = reducedMotion();
    const answered = rexMarkWaits(shown.key) && !rexMarkWaits(key);
    setShown({ key, arrive: still ? '' : answered ? 'late' : 'now', out: still ? null : shown.key, outHow: still ? null : answered ? 'answered' : 'fade', n: shown.n + 1 });
  }

  // Its icon's box, as laid out (the 20 px tile around a row's mark, else the icon itself).
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const tiled = !side && !!box.parentElement?.classList.contains('ib-atile');
    if (tiled !== inTile) setInTile(tiled);
    const next = side ? 24 : tiled ? 20 : sizeOf(box.offsetWidth, size);
    if (next !== measured) setMeasured(next);
  });

  // Its pile: laid out again whenever this mark changes, a tile comes or goes, and once it goes.
  useLayoutEffect(() => {
    const pile = ref.current?.closest(PILES) ?? null;
    pileRef.current = pile;
    if (pile) {
      watchPile(pile);
      layoutRexPile(pile);
    }
  }, [key, measured]);
  useEffect(
    () => () => {
      const pile = pileRef.current;
      if (pile) queueMicrotask(() => layoutRexPile(pile));
    },
    [],
  );

  // The outgoing mark leaves the DOM once its motion is over.
  useEffect(() => {
    if (!shown.out) return;
    const n = shown.n;
    const timer = setTimeout(() => setShown((s) => (s.n === n ? { ...s, out: null, outHow: null } : s)), shown.outHow === 'answered' ? 800 : 200);
    return () => clearTimeout(timer);
  }, [shown.n, shown.out, shown.outHow]);

  // An arrival is over: the mark is at rest (and a pop may play).
  useEffect(() => {
    if (!shown.arrive) return;
    const n = shown.n;
    const timer = setTimeout(() => setShown((s) => (s.n === n ? { ...s, arrive: '' } : s)), shown.arrive === 'late' ? 1700 : 1000);
    return () => clearTimeout(timer);
  }, [shown.n, shown.arrive]);

  // Off screen: paused.
  useEffect(() => {
    const el = ref.current;
    return el ? watchOnScreen(el) : undefined;
  }, []);

  // A tap, the pointer resting on its row or the window coming back: one more pop for a waiting mark.
  const waits = rexMarkWaits(key);
  useEffect(() => {
    const el = ref.current;
    if (!el || !waits) return;
    const nudge = () => {
      const t = Date.now();
      if (t - lastPop.current < 1500 || reducedMotion()) return;
      lastPop.current = t;
      setPop((p) => (p === 'a' ? 'b' : 'a'));
    };
    const row = el.closest('.ib-row, .ib-nrow, .ib-mrow, .ib-sbagent, .ib-ss, .ib-fline, [role="option"], button') ?? el.parentElement;
    row?.addEventListener('pointerenter', nudge);
    row?.addEventListener('pointerdown', nudge);
    window.addEventListener('focus', nudge);
    return () => {
      row?.removeEventListener('pointerenter', nudge);
      row?.removeEventListener('pointerdown', nudge);
      window.removeEventListener('focus', nudge);
    };
  }, [waits]);

  const { tempo, phase } = rexMarkSeed(seed);
  const d = rexMarkDiameter(measured, key);
  const corner = rexMarkOffsets(measured, side);
  // The sidebar's mark is 24 px in its 28 px button: placed from the mark's corner, 2 px inside the button's.
  const inset = inTile ? TILE_GLYPH_INSET : side ? -2 : 0;
  const bottom = corner.bottom - inset;
  const right = corner.right - inset;
  const words = rexMarkWords(mark);
  const layer = (layerKey: RexMarkKey, how: { arrive?: Shown['arrive']; out?: Shown['outHow'] }) => {
    const ld = rexMarkDiameter(measured, layerKey);
    const glyph = how.out === 'answered' ? 'answered' : layerKey;
    return (
      <span
        key={how.out ? `out-${shown.n}` : `in-${shown.n}`}
        className="ib-rxm-l"
        data-rx={layerKey}
        data-rx-arrive={how.arrive || undefined}
        data-rx-out={how.out ?? undefined}
        data-rx-pop={!how.out && pop ? pop : undefined}
        style={{ width: ld, height: ld, left: (d - ld) / 2, top: (d - ld) / 2 }}
      >
        <span className="ib-rxm-jump">
          <span className="ib-rxm-a">
            <span className="ib-rxm-b">
              <RexMarkShape markKey={layerKey} d={ld} />
              {layerKey === 'working' && !how.out && (
                <span className="ib-rxm-arc">
                  <RexMarkArc d={ld} />
                </span>
              )}
              <span className="ib-rxm-ga">
                <span className="ib-rxm-gb">
                  <span className="ib-rxm-g">
                    <RexMarkGlyph markKey={glyph} d={ld} />
                  </span>
                </span>
              </span>
            </span>
          </span>
        </span>
      </span>
    );
  };
  return (
    <span
      ref={ref}
      className="ib-rxm"
      role="img"
      aria-label={words}
      title={words}
      data-rx-state={key}
      data-rx-where={mark.where}
      data-rx-wait={waits ? '' : undefined}
      data-rx-size={measured}
      data-rx-side={side ? '' : undefined}
      style={{ width: d, height: d, bottom, ['--rx-r' as string]: `${right}px`, ['--rx-t' as string]: tempo.toFixed(3), ['--rx-p' as string]: phase.toFixed(3) }}
    >
      {shown.out && layer(shown.out, { out: shown.outHow })}
      {layer(key, { arrive: shown.arrive })}
    </span>
  );
}
