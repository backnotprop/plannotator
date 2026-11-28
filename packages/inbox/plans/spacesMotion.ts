/**
 * The Spaces home's one shared-element move (approval "plans-home": "the card opens into the space"; home-5.html's
 * openPlan and back): opening a card grows its face into the plan page's document, and going back from the plan
 * (its "Spaces" crumb) shrinks the document into its card again, on the home as it was left (the same scope, scrolled
 * where it was). A View Transition where there is one, 280 ms; else, and with reduced motion, a cut.
 */
import { writeRoute } from '../app/writeRoute';
import { reducedMotion } from './dither';

type HomeRoute = { page: 'plans'; project: string | null; thread: null; planAll?: boolean };

/** The class on the root while a card opens: the plan page's document takes the face's name (plans.css). */
const OPENING = 'ib-space-opening';
const NAME = 'ib-space-open';

/** The home a plan was opened from, and how far it was scrolled: going back returns there. */
let left: { route: HomeRoute; top: number } | null = null;

const homeKey = (route: HomeRoute) => `${route.project ?? ''}:${route.planAll ? 'all' : ''}`;

/** The home on screen: where a plan opened from it goes back to. Called by the home as it draws. */
let shown: { route: HomeRoute; scroller: HTMLElement | null } | null = null;
export function spacesHomeShown(route: HomeRoute, scroller: HTMLElement | null): void {
  shown = { route, scroller };
}

/** How far the home of `route` was scrolled when a plan was opened from it (once; null: none to restore). */
export function takeHomeScroll(route: HomeRoute): number | null {
  if (!left || homeKey(left.route) !== homeKey(route)) return null;
  const top = left.top;
  left = { ...left, top: 0 };
  return top;
}

const faceOf = (id: string) => document.querySelector<HTMLElement>(`[data-spaces-home] [data-card-key="${CSS.escape(id)}"] [data-frame-card-well]`);
const viewTransition = () => (typeof document.startViewTransition === 'function' && !reducedMotion() ? document.startViewTransition.bind(document) : null);

/** Open a plan; where View Transitions are, its face grows into the page's document; else a cut. */
export function openSpace(id: string, face: HTMLElement | null): void {
  if (shown) left = { route: shown.route, top: shown.scroller?.scrollTop ?? 0 };
  const go = () => writeRoute({ page: 'plans', project: null, thread: null, plan: id });
  const start = viewTransition();
  if (!start || !face) return go();
  face.style.viewTransitionName = NAME;
  const root = document.documentElement;
  const move = start(async () => {
    face.style.viewTransitionName = '';
    root.classList.add(OPENING);
    go();
    await until(() => !!document.querySelector('[data-plan-document]'), 360);
  });
  void move.finished.finally(() => root.classList.remove(OPENING));
}

/** Back from plan `id` to the home it was opened from (else Home); its document shrinks into its card there. */
export function closeSpace(id: string): void {
  const go = () => writeRoute(left?.route ?? { page: 'plans', project: null, thread: null });
  const start = viewTransition();
  const page = document.querySelector<HTMLElement>('[data-plan-document]');
  if (!start || !page) return go();
  page.style.viewTransitionName = NAME;
  const move = start(async () => {
    page.style.viewTransitionName = '';
    go();
    await until(() => !!faceOf(id), 360);
    const face = faceOf(id);
    if (face) face.style.viewTransitionName = NAME;
  });
  void move.finished.finally(() => {
    const face = faceOf(id);
    if (face) face.style.viewTransitionName = '';
  });
}

/** Ready, or `ms` passed. Timers, not frames: a View Transition holds rendering while its update runs. */
function until(ready: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  return new Promise((resolve) => {
    const tick = () => (ready() || performance.now() > end ? resolve() : setTimeout(tick, 16));
    tick();
  });
}

/** Tests: forget the home left. */
export function resetSpacesMotionForTests(): void {
  left = null;
  shown = null;
}
