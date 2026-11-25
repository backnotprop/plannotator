/**
 * Grid's motion, Glint (approval "inbox-agent-grid", the life round, take "glint"; owner-approved 2026-11-25). Something
 * moves only because work moves: Not moving, Stale and Dropped lines stay completely still.
 *
 * - Glint: Ship's light crosses one Moving bar toward now, a new line every 1.7 s, walking down the list; no line twice
 *   within 7 s. The line's agent mark bobs while it crosses.
 * - A line that changes group slides there (0.38 to 0.8 s by distance) instead of jumping, and the lines it passes
 *   slide up or down to their new places with it, the group headings and "N more" too; a new heading fades in.
 * - A line going Stale lets its tail's old grey go to the stale colour (1.8 s); a merge settles with a soft light, once.
 * - Needs you breathes in amber on its waiting tip, all in step (the CSS; this file keeps them in step).
 * - A nudge sends a warmer light along the stale bar, then a soft light at its end.
 *
 * Cost (measured with 30 lines over CDP, grid-motion notes in docs/agent-guides/inbox-grid.md): every motion is
 * transform and opacity only, so it runs on the compositor. The glint is a Web Animation on the light and on the mark
 * themselves, started by the walk's one timer: nothing is set on the line, so no style is worked out again for the
 * line and nothing is laid out, as an attribute on the line would make Chrome do for all of it. The breath is a CSS
 * animation on lines on screen; it is put back in step only when the lines breathing change, never on every turn of
 * the walk (`document.getAnimations()` works out the page's style). One timer every 1.7 s while the tab shows; none
 * while it is hidden or with prefers-reduced-motion (then nothing moves and lines change group in place). Lines off
 * screen are skipped (the page's IntersectionObserver, gridSeen.ts, marks the ones on screen `data-vis`; no layout
 * read). The slide reads the lines' places in a layout effect after each draw of the page (never during render), when
 * the browser lays the page out anyway, and slides from the places the draw before left.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { GridGroup, GridModel } from '../../shared/inbox/grid';

const GLINT_EVERY_MS = 1700;
const GLINT_AGAIN_MS = 7000;
const COOL_MS = 1800;
const LAND_MS = 1000;
const NUDGE_MS = 2000;

/** The approved curve, per keyframe as the CSS had it, so the light speeds up and slows down along the bar. */
const IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';
/** Ship's light: from before the bar's start to past its end, fading in and out at the ends. */
const GLINT: Keyframe[] = [
  { offset: 0, transform: 'translateX(calc(-50% - 17px))', opacity: 0, easing: IN_OUT },
  { offset: 0.18, opacity: 0.95, easing: IN_OUT },
  { offset: 0.82, opacity: 0.95, easing: IN_OUT },
  { offset: 1, transform: 'translateX(calc(50% + 17px))', opacity: 0 },
];
/** A bar too short to cross: a brief brighter tip. */
const FLASH: Keyframe[] = [
  { offset: 0, opacity: 0, easing: 'ease-out' },
  { offset: 0.4, opacity: 0.85, easing: 'ease-out' },
  { offset: 1, opacity: 0 },
];
/** Ship's bob: 0.9 px and 4 degrees, in and out. */
const BOB: Keyframe[] = [
  { offset: 0, transform: 'none', easing: 'ease-in-out' },
  { offset: 0.22, transform: 'translateY(-0.6px) rotate(2.5deg)', easing: 'ease-in-out' },
  { offset: 0.48, transform: 'translateY(0.9px) rotate(-4deg)', easing: 'ease-in-out' },
  { offset: 0.74, transform: 'translateY(-0.5px) rotate(2deg)', easing: 'ease-in-out' },
  { offset: 1, transform: 'none' },
];
const GLINT_MS = 1350;
const FLASH_MS = 700;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const lineSel = (id: string) => `[data-grid-line="${CSS.escape(id)}"]`;

/** Set an attribute on a line for `ms`, so its CSS animation runs once (the rare ones: going stale, a merge, a nudge). */
function flag(el: Element, name: string, ms: number): void {
  el.removeAttribute(name);
  // A new start for an animation the same attribute ran before: the attribute comes back on the next frame.
  requestAnimationFrame(() => {
    el.setAttribute(name, '');
    setTimeout(() => el.removeAttribute(name), ms);
  });
}

/** Ship's light across one line's bar, and its agent's mark bobbing: Web Animations on those two elements only. */
function glint(line: HTMLElement): boolean {
  const light = line.querySelector<HTMLElement>('.ib-grid-glc > i');
  if (!light || typeof light.animate !== 'function') return false;
  const short = light.parentElement!.hasAttribute('data-short');
  light.animate(short ? FLASH : GLINT, { duration: short ? FLASH_MS : GLINT_MS });
  line.querySelector<HTMLElement>('.ib-grid-mk')?.animate(BOB, { duration: GLINT_MS });
  return true;
}

export function useGridMotion(list: RefObject<HTMLElement | null>, model: GridModel | null): { nudged: (id: string) => void } {
  const groups = useRef(new Map<string, GridGroup>());
  /** Where each line, group heading (`h:<group>`) and "N more" (`d:<group>`) was; a heading's or a door's group is null. */
  const before = useRef(new Map<string, { top: number; group: GridGroup | null }>());
  const glinted = useRef(new Map<string, number>());
  const lastGlint = useRef<string | null>(null);
  const breathing = useRef('');

  // The glint's walk: one timer while the tab shows, none while hidden or with reduced motion. Only lines on screen
  // (`data-vis`, set by the page's one IntersectionObserver in gridSeen.ts) glint or breathe.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      timer = null;
      const root = list.current;
      if (root && !reducedMotion()) {
        // A waiting tip that came on screen started its breath late: back in step with the others, once.
        const you = [...root.querySelectorAll<HTMLElement>('[data-grid-line][data-group="you"][data-vis]')].map((el) => el.dataset.gridLine).join(' ');
        if (you !== breathing.current) {
          breathing.current = you;
          if (you) breatheInStep();
        }
        const moving = [...root.querySelectorAll<HTMLElement>('[data-grid-line][data-group="move"][data-vis]')];
        const now = Date.now();
        const after = moving.findIndex((el) => el.dataset.gridLine === lastGlint.current) + 1;
        for (let k = 0; k < moving.length; k++) {
          const el = moving[(after + k) % moving.length]!;
          const id = el.dataset.gridLine!;
          if (now - (glinted.current.get(id) ?? -Infinity) < GLINT_AGAIN_MS) continue;
          glinted.current.set(id, now);
          lastGlint.current = id;
          glint(el);
          break;
        }
      }
      schedule();
    };
    const schedule = () => {
      if (timer === null && document.visibilityState !== 'hidden') timer = setTimeout(tick, GLINT_EVERY_MS);
    };
    const shown = () => {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      } else schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', shown);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [list]);

  /**
   * After each draw of the page (a layout effect, never during render): when the model changed and a line changed
   * group, each line the change moves (the line itself and the lines it passes) slides from where the draw before left
   * it, as the approved take does; going Stale cools, landing settles. Then where everything is now is kept, on the
   * page's own coordinates (a scroll between draws moves nothing), for the next draw. The places are read once per
   * draw, after the draw's own changes, when the browser lays the page out anyway; with reduced motion, never.
   */
  const drawn = useRef<GridModel | null>(null);
  useLayoutEffect(() => {
    const root = list.current;
    if (!root || !model) return;
    const changed = drawn.current !== model;
    drawn.current = model;
    const next = new Map<string, GridGroup>();
    for (const { id, lines } of model.groups) for (const line of lines) next.set(line.id, id);
    const was = groups.current;
    groups.current = next;
    if (reducedMotion()) {
      before.current.clear();
      return;
    }
    const top0 = root.getBoundingClientRect().top;
    const now = new Map<string, { el: HTMLElement; top: number }>();
    for (const [key, el] of sliders(root)) now.set(key, { el, top: el.getBoundingClientRect().top - top0 });
    const moving = changed && [...next].some(([id, group]) => was.has(id) && was.get(id) !== group);
    if (moving) {
      for (const [key, { el, top }] of now) {
        const at = before.current.get(key);
        // A group heading that was not there comes in softly, as the approved take does.
        if (!at) {
          if (key.startsWith('h:') && typeof el.animate === 'function') el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
          continue;
        }
        const from = at.group;
        const group = from === null ? null : next.get(key);
        if (group === undefined) continue;
        const dy = at.top - top;
        if (Math.abs(dy) > 1 && typeof el.animate === 'function') {
          // A longer way takes longer: 0.38 s to 0.8 s. A line going further than a row rides over the others.
          const ms = 380 + Math.min(420, Math.abs(dy) * 0.9);
          const far = group !== null && Math.abs(dy) > 40;
          if (far) el.setAttribute('data-far', '');
          const travel = el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ms, easing: IN_OUT });
          if (far) travel.onfinish = travel.oncancel = () => el.removeAttribute('data-far');
        }
        if (group === null || from === group) continue;
        if (group === 'stale' && (from === 'move' || from === 'quiet')) flag(el, 'data-cool', COOL_MS);
        if (group === 'land') flag(el, 'data-landing', LAND_MS);
      }
      // Lines that changed: the breath is put back in step on the walk's next turn.
      breathing.current = '';
    }
    // Where everything is now, for the next draw: a line by its group now; a heading's or a door's group is null.
    before.current = new Map([...now].map(([key, { top }]) => [key, { top, group: key.startsWith('h:') || key.startsWith('d:') ? null : (next.get(key) ?? null) }]));
  });

  const nudged = useCallback(
    (id: string) => {
      const el = list.current?.querySelector(lineSel(id));
      if (el && !reducedMotion()) flag(el, 'data-nudging', NUDGE_MS);
    },
    [list],
  );
  return { nudged };
}

/** What slides when a line changes group: every line, and each group's heading and "N more", by a key that outlives the draw. */
function sliders(root: HTMLElement): Map<string, HTMLElement> {
  const all = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-grid-line], [data-grid-group] > .ib-grid-gh, [data-grid-group] > .ib-grid-door')) {
    const line = el.dataset.gridLine;
    const group = (el.parentElement as HTMLElement).dataset.gridGroup;
    all.set(line ?? `${el.classList.contains('ib-grid-gh') ? 'h' : 'd'}:${group}`, el);
  }
  return all;
}

/** Every Needs you breath in step, so they read as one thing: their animations share the page's start. */
function breatheInStep(): void {
  if (typeof document.getAnimations !== 'function') return;
  for (const motion of document.getAnimations()) {
    if ((motion as CSSAnimation).animationName === 'ib-grid-breath' && motion.startTime !== 0) motion.startTime = 0;
  }
}
