/**
 * The view choice's Agents picture folds and opens its agents by itself (the owner, 2026-11-20: "animate that where
 * they open and close just to show that part of the agents view is you get organized agents"): a calm loop, one agent
 * at a time, through the Agents view's own fold (AgentsList `folded`: the same folded head with its count, its threads
 * gone). The motion is the picture's own: its few rows slide away while the agent's height closes, so the agents under
 * it ride up and the frame never jumps. The real Agents view does not animate its folds.
 *
 * It runs only while the picture is mounted (the dialog open) and on screen, pauses while the tab is hidden, and never
 * moves under reduced motion (all open, still). Nothing is kept: the folds are this picture's state, never the
 * person's (agentsView/folds.ts is not touched).
 */
import { useEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/** The loop's timing, ms (tests make it short). */
export const FOLD_LOOP_MS = {
  /** Everything open, before the first agent folds. */
  holdOpen: 2200,
  /** Between the first agent's fold (or opening) and the second's. */
  between: 1400,
  /** Both folded, before they open again. */
  holdFolded: 1600,
  fold: 220,
  open: 260,
};

/** One step of the loop: after `wait`, fold or open `agent` (its id, `data-agent`). */
export interface FoldStep {
  agent: string;
  fold: boolean;
  wait: number;
}

/** The loop for two agents: fold the first, then the second; hold; open the first, then the second; hold; again. */
export function foldLoopSteps([first, second]: readonly [string, string]): FoldStep[] {
  return [
    { agent: first, fold: true, wait: FOLD_LOOP_MS.holdOpen },
    { agent: second, fold: true, wait: FOLD_LOOP_MS.between },
    { agent: first, fold: false, wait: FOLD_LOOP_MS.holdFolded },
    { agent: second, fold: false, wait: FOLD_LOOP_MS.between },
  ];
}

const reducedQuery = () => (typeof window !== 'undefined' ? (window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null) : null);
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_IN_OUT = 'cubic-bezier(0.4, 0, 0.2, 1)';

/** The agent's threads (and its "N more"): what folds away. */
const rowsOf = (group: Element) => [...group.children].filter((el): el is HTMLElement => el instanceof HTMLElement && (el.classList.contains('ib-rw') || el.classList.contains('ib-agmore')));

/**
 * The agents folded now, for `AgentsList`'s `folded`. `agents`: the two the loop folds, in order (never one that waits
 * on the person: the real view keeps those open). `root`: the picture, where the agents' groups are.
 */
export function useFoldLoop(root: RefObject<HTMLElement | null>, agents: readonly [string, string]): ReadonlySet<string> {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [first, second] = agents;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const steps = foldLoopSteps([first, second]);
    const reduced = reducedQuery();
    let at = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Animation[] = [];
    let onScreen = true;
    let stopped = false;
    // A fold or an opening in motion: the next step waits for it.
    let busy = false;
    const settle = () => {
      for (const animation of running) animation.cancel();
      running = [];
      for (const group of el.querySelectorAll<HTMLElement>('.ib-ag[data-folding]')) {
        group.removeAttribute('data-folding');
        group.style.removeProperty('overflow');
      }
    };
    const commit = (agent: string, fold: boolean) =>
      flushSync(() =>
        setFolded((was) => {
          const next = new Set(was);
          if (fold) next.add(agent);
          else next.delete(agent);
          return next;
        }),
      );
    const run = ({ agent, fold }: FoldStep, done: () => void) => {
      const group = el.querySelector<HTMLElement>(`.ib-ag[data-agent="${CSS.escape(agent)}"]`);
      // No group, or no Web Animations: the fold as the view does it, at once.
      if (!group || typeof group.animate !== 'function') {
        commit(agent, fold);
        done();
        return;
      }
      group.setAttribute('data-folding', '');
      group.style.overflow = 'hidden';
      if (fold) {
        const rows = rowsOf(group);
        const from = group.offsetHeight;
        const to = from - rows.reduce((sum, row) => sum + row.offsetHeight, 0);
        const height = group.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: FOLD_LOOP_MS.fold, easing: EASE_IN_OUT });
        running = [height, ...rows.map((row) => row.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: FOLD_LOOP_MS.fold * 0.7, easing: 'ease-in', fill: 'forwards' }))];
        height.finished.then(
          () => {
            if (stopped) return;
            commit(agent, true);
            settle();
            done();
          },
          () => {},
        );
        return;
      }
      const from = group.offsetHeight;
      commit(agent, false);
      const to = group.offsetHeight;
      const rows = rowsOf(group);
      const height = group.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: FOLD_LOOP_MS.open, easing: EASE_OUT });
      running = [height, ...rows.map((row, i) => row.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: FOLD_LOOP_MS.open, delay: 40 + i * 30, easing: EASE_OUT, fill: 'backwards' }))];
      height.finished.then(
        () => {
          if (stopped) return;
          settle();
          done();
        },
        () => {},
      );
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      if (stopped || busy || !onScreen || reduced?.matches || document.visibilityState === 'hidden') return;
      const step = steps[at]!;
      timer = setTimeout(() => {
        timer = undefined;
        busy = true;
        run(step, () => {
          busy = false;
          at = (at + 1) % steps.length;
          schedule();
        });
      }, step.wait);
    };
    // Reduced motion turned on: still, every agent open.
    const onReduced = () => {
      if (!reduced?.matches) return schedule();
      clearTimeout(timer);
      timer = undefined;
      settle();
      busy = false;
      at = 0;
      flushSync(() => setFolded(new Set()));
    };
    const onVisibility = () => schedule();
    reduced?.addEventListener?.('change', onReduced);
    document.addEventListener('visibilitychange', onVisibility);
    const seen =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            const now = entries.some((entry) => entry.isIntersecting);
            if (now === onScreen) return;
            onScreen = now;
            schedule();
          })
        : null;
    seen?.observe(el);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      settle();
      seen?.disconnect();
      reduced?.removeEventListener?.('change', onReduced);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [root, first, second]);
  return folded;
}
