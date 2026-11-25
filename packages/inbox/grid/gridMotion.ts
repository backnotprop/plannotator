/**
 * Grid's motion, Glint (approval "inbox-agent-grid", the life round, take "glint"; owner-approved 2026-11-25). Something
 * moves only because work moves: Not moving, Stale and Dropped lines stay completely still.
 *
 * - Glint: Ship's light crosses one Moving bar toward now, a new line every 1.7 s, walking down the list; no line twice
 *   within 7 s. The line's agent mark bobs while it crosses.
 * - A line that changes group slides there (0.4 to 0.8 s by distance) instead of jumping.
 * - A line going Stale lets its tail's old grey go to the stale colour (1.8 s); a merge settles with a soft light, once.
 * - Needs you breathes in amber on its waiting tip, all in step (the CSS; this file keeps them in step).
 * - A nudge sends a warmer light along the stale bar, then a soft light at its end.
 *
 * Cost: the motion is CSS keyframes on transform and opacity, started by an attribute on the line; this file only
 * picks the line. One timer every 1.7 s while the tab shows; none while it is hidden or with prefers-reduced-motion
 * (then nothing moves and lines change group in place). Lines off screen are skipped (the page's IntersectionObserver,
 * gridSeen.ts, marks the ones on screen `data-vis`; no layout read). The slide reads the place of only the lines that
 * changed group, once.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { GridGroup, GridModel } from '../../shared/inbox/grid';

const GLINT_EVERY_MS = 1700;
const GLINT_AGAIN_MS = 7000;
const GLINT_MS = 1500;
const COOL_MS = 1800;
const LAND_MS = 1000;
const NUDGE_MS = 2000;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const lineSel = (id: string) => `[data-grid-line="${CSS.escape(id)}"]`;

/** Set an attribute on a line for `ms`, so its CSS animation runs once. */
function flag(el: Element, name: string, ms: number): void {
  el.removeAttribute(name);
  // A new start for an animation the same attribute ran before: the attribute comes back on the next frame.
  requestAnimationFrame(() => {
    el.setAttribute(name, '');
    setTimeout(() => el.removeAttribute(name), ms);
  });
}

export function useGridMotion(list: RefObject<HTMLElement | null>, model: GridModel | null): { nudged: (id: string) => void; capture: () => void } {
  const groups = useRef(new Map<string, GridGroup>());
  const before = useRef(new Map<string, { top: number; group: GridGroup }>());
  const glinted = useRef(new Map<string, number>());
  const lastGlint = useRef<string | null>(null);

  // The glint's walk: one timer while the tab shows, none while hidden or with reduced motion. Only lines on screen
  // (`data-vis`, set by the page's one IntersectionObserver in gridSeen.ts) glint or breathe.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      timer = null;
      const root = list.current;
      if (root && !reducedMotion()) {
        // A waiting tip that came on screen started its breath late: back in step with the others.
        if (root.querySelector('[data-group="you"][data-vis]')) breatheInStep();
        const moving = [...root.querySelectorAll<HTMLElement>('[data-grid-line][data-group="move"][data-vis]')];
        const now = Date.now();
        const after = moving.findIndex((el) => el.dataset.gridLine === lastGlint.current) + 1;
        for (let k = 0; k < moving.length; k++) {
          const el = moving[(after + k) % moving.length]!;
          const id = el.dataset.gridLine!;
          if (now - (glinted.current.get(id) ?? -Infinity) < GLINT_AGAIN_MS) continue;
          glinted.current.set(id, now);
          lastGlint.current = id;
          flag(el, 'data-glint', GLINT_MS);
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

  /** Before the page draws a new model: where each line that changes group is now (read once, only those lines). */
  const capture = useCallback(() => {
    const root = list.current;
    before.current.clear();
    if (!root || !model || reducedMotion()) return;
    for (const { id, lines } of model.groups) {
      for (const line of lines) {
        const was = groups.current.get(line.id);
        if (!was || was === id) continue;
        const el = root.querySelector(lineSel(line.id));
        if (el) before.current.set(line.id, { top: el.getBoundingClientRect().top, group: was });
      }
    }
  }, [list, model]);

  // After it drew: each line that changed group slides from where it was; going Stale cools, landing settles.
  useLayoutEffect(() => {
    const root = list.current;
    if (!root || !model) return;
    const moved = before.current;
    before.current = new Map();
    const next = new Map<string, GridGroup>();
    for (const { id, lines } of model.groups) for (const line of lines) next.set(line.id, id);
    if (!reducedMotion()) {
      for (const [lineId, was] of moved) {
        const el = root.querySelector<HTMLElement>(lineSel(lineId));
        const group = next.get(lineId);
        if (!el || !group) continue;
        const dy = was.top - el.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) {
          // A longer way takes longer: 0.4 s to 0.8 s.
          const ms = Math.min(800, 400 + Math.abs(dy) * 0.8);
          el.setAttribute('data-far', '');
          const travel = el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ms, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' });
          travel.onfinish = travel.oncancel = () => el.removeAttribute('data-far');
        }
        if (group === 'stale' && (was.group === 'move' || was.group === 'quiet')) flag(el, 'data-cool', COOL_MS);
        if (group === 'land') flag(el, 'data-landing', LAND_MS);
      }
    }
    groups.current = next;
    breatheInStep();
  }, [list, model]);

  const nudged = useCallback(
    (id: string) => {
      const el = list.current?.querySelector(lineSel(id));
      if (el && !reducedMotion()) flag(el, 'data-nudging', NUDGE_MS);
    },
    [list],
  );
  return { nudged, capture };
}

/** Every Needs you breath in step, so they read as one thing: their animations share the page's start. */
function breatheInStep(): void {
  if (typeof document.getAnimations !== 'function') return;
  for (const motion of document.getAnimations()) {
    if ((motion as CSSAnimation).animationName === 'ib-grid-breath' && motion.startTime !== 0) motion.startTime = 0;
  }
}
