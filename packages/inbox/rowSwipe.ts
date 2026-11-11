/**
 * Swipe a thread row on a touch screen (the owner's answer: "Right marks read,
 * left archives; a long swipe or flick acts at once (like Mail)"). A phone's
 * row, and an iPad's rows: only a finger, never a mouse or a trackpad.
 *
 * While the finger is down the row follows it 1:1 (its transform, written
 * here: no React render per move), and the action shows under it: Quiet (Mark
 * read; Mark unread on a read row, as the row's hover action offers) on the
 * left as the row moves right, Archive on the right as it moves left. Past the
 * commit distance the row resists (a rubber band). On release a spring seeded
 * with the finger's speed takes it:
 * - released past `commitDistance`, or flicked (`SWIPE_ROW_FLICK_SPEED`): the
 *   action runs at once. Quiet springs the row back into place; Archive slides
 *   it off and it comes back faded in place, "Archived", as the held list
 *   shows an archived row (held.ts) until the list settles;
 * - released past most of `SWIPE_ROW_REVEAL_PX`: the row rests open on the
 *   action's button, a real button to tap; a tap anywhere else, a scroll, or
 *   another row's swipe closes it (one row open at a time);
 * - short of that: it springs back.
 * Every action goes through the list's `onRowAction`, the row menu's: the
 * same toasts and Undo, the Mark read warning ("Set aside N open
 * questions?"), whose Cancel leaves the row where it was.
 *
 * Never against the page: the row takes `touch-action: pan-y` (inbox.css), so
 * a vertical drag scrolls natively. The direction is decided once the finger
 * has moved `SWIPE_DECIDE_PX`, and only a mostly sideways move is a swipe; a
 * scroll of the list at any point lets the row go. A touch within
 * `SWIPE_ROW_EDGE_PX` of the screen's side is Safari's (Back, Forward). A hold
 * that does not move is left alone, and so is a tap: it opens the thread with
 * no delay. A pull to refresh in progress (pullRefresh.ts) is never a swipe.
 *
 * One set of listeners on the list's scroll box: nothing per row, and the move
 * listeners exist only while a finger is on a row. Under reduced motion the
 * row still follows the finger; the release settles with a short ease, no
 * spring and no slide.
 *
 * Nothing is gesture-only: Mark read, Mark unread and Archive are in the open
 * thread's ⋯ sheet on a phone, and the row menu and hover action elsewhere.
 */

import { canMarkUnread, offersRowMarkRead } from './markRead';
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';

/** The right swipe's label (the owner: "Call it 'Quiet': that's where a read thread goes in the list"). */
export const SWIPE_QUIET_LABEL = 'Quiet';
/** What a screen reader hears for it: the visible word alone does not say what it does. */
export const SWIPE_QUIET_NAME = 'Mark read, move to Quiet';
/** On a read row, the hover action's own word. */
export const SWIPE_UNREAD_LABEL = 'Mark unread';
export const SWIPE_ARCHIVE_LABEL = 'Archive';

/** The finger moves this far before the swipe is decided either way. */
export const SWIPE_DECIDE_PX = 10;
/** And must move this many times more sideways than up or down to be a swipe. */
export const SWIPE_LOCK_RATIO = 1.5;
/** A touch this close to the screen's left or right side is the browser's (Safari's Back and Forward). */
export const SWIPE_ROW_EDGE_PX = 24;
/** Open on its button, the row rests this far over. */
export const SWIPE_ROW_REVEAL_PX = 96;
/** Released past this share of the reveal, it rests open (short of the commit distance). */
export const SWIPE_ROW_REVEAL_SHARE = 0.6;
/** Released past this share of the row's width, the action runs... */
export const SWIPE_ROW_COMMIT_SHARE = 0.5;
/** ...a share kept between these (a wide row on an iPad commits at 240 px, not at half its width). */
export const SWIPE_ROW_COMMIT_MIN_PX = 140;
export const SWIPE_ROW_COMMIT_MAX_PX = 240;
/** A flick: this fast (px/ms) toward the action and at least `SWIPE_ROW_FLICK_MIN_PX` across runs it too. */
export const SWIPE_ROW_FLICK_SPEED = 0.6;
export const SWIPE_ROW_FLICK_MIN_PX = 40;
/** Released moving back toward rest this fast (px/ms) or more, it closes instead of resting open. */
const SWIPE_ROW_BACK_SPEED = 0.3;
/** A side with no action moves at most this far (resisting all the way). */
const SWIPE_ROW_NONE_PX = 40;
/** The finger's speed is read over its last this many ms. */
const VELOCITY_WINDOW_MS = 80;
/** A touch this soon after the list scrolled stops a moving list: never a swipe. */
const SCROLL_REST_MS = 100;
/** Under reduced motion, the release's short ease. */
const REDUCED_MS = 140;
/** The archived row coming back in place. */
const FADE_IN_MS = 200;

export type SwipeLead = 'read' | 'mark-unread';
export type SwipeAction = SwipeLead | 'archive';

export interface RowSwipeActions {
  /** The right swipe (under the row's left edge): Mark read (Quiet), Mark unread, or none. */
  lead: SwipeLead | null;
  /** The left swipe: Archive, or none. */
  trail: 'archive' | null;
}

/**
 * What a row's swipes do: the right swipe is the row's hover action (InboxList.tsx `RowWithAction`): Mark unread on
 * a read row (`canMarkUnread`), else Mark read where it is offered (`offersRowMarkRead`); the left swipe is the row
 * menu's Archive, on a row not archived already (rowMenu.ts). An archived row shown in place has neither.
 */
export function rowSwipeActions(
  row: InboxListRow,
  drawn: InboxListGroupId | null,
  can: { markRead: boolean; markUnread: boolean },
): RowSwipeActions {
  const unread = can.markUnread && canMarkUnread(row);
  const read = !unread && can.markRead && offersRowMarkRead(row, drawn);
  return { lead: unread ? 'mark-unread' : read ? 'read' : null, trail: row.resolved_at === null ? 'archive' : null };
}

/** Once the finger has moved (`dx`, `dy` from where it went down): wait, a swipe, or the page's (a scroll). */
export function lockSwipe(dx: number, dy: number): 'wait' | 'swipe' | 'scroll' {
  if (Math.abs(dx) < SWIPE_DECIDE_PX && Math.abs(dy) < SWIPE_DECIDE_PX) return 'wait';
  return Math.abs(dx) > SWIPE_LOCK_RATIO * Math.abs(dy) ? 'swipe' : 'scroll';
}

/** A touch that starts at the screen's side is the browser's own swipe. */
export function startsAtEdge(x: number, viewportWidth: number): boolean {
  return x < SWIPE_ROW_EDGE_PX || x > viewportWidth - SWIPE_ROW_EDGE_PX;
}

/** How far a row `width` wide must go for its action to run on release. */
export function commitDistance(width: number): number {
  return Math.min(SWIPE_ROW_COMMIT_MAX_PX, Math.max(SWIPE_ROW_COMMIT_MIN_PX, width * SWIPE_ROW_COMMIT_SHARE));
}

/** Apple's rubber band: `over` px of travel past a limit move the thing this far, approaching `dim` and never reaching it. */
export function rubberBand(over: number, dim: number): number {
  if (over <= 0 || dim <= 0) return 0;
  return (over * dim * 0.55) / (dim + 0.55 * over);
}

/** Where the row is drawn for `raw` px of finger travel (from rest): 1:1 up to the commit distance, then resisting. */
export function swipeOffset(raw: number, width: number, actions: RowSwipeActions): number {
  const side = raw > 0 ? actions.lead : raw < 0 ? actions.trail : null;
  const sign = Math.sign(raw);
  const travel = Math.abs(raw);
  if (!side) return sign * rubberBand(travel, SWIPE_ROW_NONE_PX);
  const commit = commitDistance(width);
  if (travel <= commit) return raw;
  return sign * (commit + rubberBand(travel - commit, Math.max(1, width - commit)));
}

export type SwipeOutcome = 'commit-lead' | 'commit-trail' | 'reveal-lead' | 'reveal-trail' | 'close';

/**
 * What a release does, from the finger's travel `raw` (px from rest, right positive) and its speed `v` (px/ms, right
 * positive): past the commit distance, or a flick toward the action, runs it; most of the way to the button rests open
 * (unless moving back toward rest); else it closes.
 */
export function releaseOutcome(raw: number, v: number, width: number, actions: RowSwipeActions): SwipeOutcome {
  const lead = raw > 0;
  if (raw === 0 || !(lead ? actions.lead : actions.trail)) return 'close';
  const travel = Math.abs(raw);
  const toward = lead ? v : -v;
  if (travel >= commitDistance(width)) return lead ? 'commit-lead' : 'commit-trail';
  if (toward >= SWIPE_ROW_FLICK_SPEED && travel >= SWIPE_ROW_FLICK_MIN_PX) return lead ? 'commit-lead' : 'commit-trail';
  if (travel >= SWIPE_ROW_REVEAL_PX * SWIPE_ROW_REVEAL_SHARE && toward > -SWIPE_ROW_BACK_SPEED) return lead ? 'reveal-lead' : 'reveal-trail';
  return 'close';
}

/** The finger's speed over its last few samples (px/ms), not the whole drag's average. */
export class VelocityTracker {
  private samples: [number, number][] = [];
  reset(x: number, t: number) {
    this.samples = [[x, t]];
  }
  add(x: number, t: number) {
    this.samples.push([x, t]);
    while (this.samples.length > 2 && t - this.samples[0]![1] > VELOCITY_WINDOW_MS) this.samples.shift();
  }
  velocity(now?: number): number {
    if (this.samples.length < 2) return 0;
    const [x0, t0] = this.samples[0]!;
    const [x1, t1] = this.samples[this.samples.length - 1]!;
    // The finger stopped before it lifted: no flick.
    if (now !== undefined && now - t1 > VELOCITY_WINDOW_MS) return 0;
    return t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;
  }
}

/**
 * A spring on one number, interruptible: `to` on a new target keeps the speed it has, `stop` catches it where it is.
 * With `bounce` (the end of a drag: force was applied) it settles with a slight overshoot; without (a tap closed it),
 * none. Reduced motion: a short ease, no speed carried.
 */
class Spring {
  x = 0;
  private v = 0;
  private target = 0;
  private raf = 0;
  private last = 0;
  private stiffness = 450;
  private damping = 34;
  private done: (() => void) | null = null;
  private exit = false;
  private tween: { from: number; start: number } | null = null;
  constructor(
    private readonly apply: (x: number) => void,
    private readonly reduced: () => boolean,
  ) {}
  set(x: number) {
    this.cancel();
    this.x = x;
    this.v = 0;
    this.apply(x);
  }
  stop(): number {
    this.cancel();
    this.v = 0;
    return this.x;
  }
  get moving() {
    return this.raf !== 0;
  }
  /**
   * `exit`: the thing leaves (a row sliding off after Archive): a stiffer spring, done the moment it reaches or passes
   * the target, since past it nothing shows.
   */
  to(target: number, velocity: number, options: { bounce?: boolean; exit?: boolean; done?: () => void } = {}) {
    this.target = target;
    this.done = options.done ?? null;
    this.exit = options.exit === true;
    this.stiffness = this.exit ? 700 : 450;
    this.damping = this.exit ? 37 : options.bounce === false ? 2 * Math.sqrt(450) : 34;
    if (this.reduced()) {
      this.v = 0;
      this.tween = { from: this.x, start: -1 };
    } else {
      this.tween = null;
      this.v = velocity * 1000;
    }
    if (this.raf === 0) {
      this.last = -1;
      this.raf = requestAnimationFrame(this.step);
    }
  }
  private cancel() {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.done = null;
    this.tween = null;
  }
  private finish() {
    this.x = this.target;
    this.v = 0;
    this.raf = 0;
    this.tween = null;
    this.apply(this.x);
    const done = this.done;
    this.done = null;
    done?.();
  }
  private step = (now: number) => {
    if (this.tween) {
      if (this.tween.start < 0) this.tween.start = now;
      const t = Math.min(1, (now - this.tween.start) / REDUCED_MS);
      if (t >= 1) return this.finish();
      this.x = this.tween.from + (this.target - this.tween.from) * (1 - (1 - t) ** 3);
      this.apply(this.x);
      this.raf = requestAnimationFrame(this.step);
      return;
    }
    const dt = this.last < 0 ? 1 / 60 : Math.max(0, Math.min(32, now - this.last)) / 1000;
    this.last = now;
    const before = this.x - this.target;
    const a = -this.stiffness * before - this.damping * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    const after = this.x - this.target;
    if (this.exit ? Math.abs(after) < 2 || before * after <= 0 : Math.abs(this.v) < 4 && Math.abs(after) < 0.4) return this.finish();
    this.apply(this.x);
    this.raf = requestAnimationFrame(this.step);
  };
}

export interface RowSwipeOptions {
  /** What the row's swipes do now (null: not a row the list knows). Read when the swipe starts. */
  actionsOf: (threadId: string) => (RowSwipeActions & { title: string }) | null;
  /** Runs the action (the list's `onRowAction`); Archive's promise settles once the write has landed. */
  onAction: (threadId: string, action: SwipeAction) => unknown;
  /** Whether motion is reduced now (read at each release). */
  reduced?: () => boolean;
}

/** The row a swipe moves: a phone's row, or a wider list's row wrapper (it holds the hover action), in a group of the list. */
const FACE = '.ib-mrow[data-thread-id], .ib-rw[data-row]';

function faceOf(target: EventTarget | null, body: HTMLElement): HTMLElement | null {
  const face = target instanceof Element ? target.closest<HTMLElement>(FACE) : null;
  const group = face?.parentElement;
  return face && group?.classList.contains('ib-group') && group.parentElement === body ? face : null;
}

const idOf = (face: HTMLElement) => face.getAttribute('data-thread-id') ?? face.getAttribute('data-row') ?? '';

interface Current {
  face: HTMLElement;
  id: string;
  actions: RowSwipeActions;
  width: number;
  spring: Spring;
  /** Resting open on a button. */
  open: boolean;
  /** Sliding off after Archive: finishes the slide at once (another row wants the layer). */
  leaving?: () => void;
}

/**
 * Attaches the swipe to the list's scroll box. `layer` is the action layer (RowSwipeLayer.tsx): one for the list,
 * placed under the row being swiped. Returns the cleanup.
 */
export function attachRowSwipe(body: HTMLElement, layer: HTMLElement, options: RowSwipeOptions): () => void {
  const doc = body.ownerDocument;
  const view = doc.defaultView ?? window;
  const reduced = () => options.reduced?.() ?? false;
  const lead = layer.querySelector<HTMLElement>('[data-row-swipe="lead"]');
  const trail = layer.querySelector<HTMLElement>('[data-row-swipe="trail"]');
  const leadIn = lead?.querySelector<HTMLElement>('.ib-swa-in') ?? null;
  const trailIn = trail?.querySelector<HTMLElement>('.ib-swa-in') ?? null;

  /** The row using the layer: being swiped, springing, or open. */
  let current: Current | null = null;
  /** The finger on a row, before and during a swipe. */
  let touch: {
    id: number;
    face: HTMLElement;
    target: EventTarget;
    x0: number;
    y0: number;
    phase: 'maybe' | 'swipe';
    base: number;
    lockDx: number;
    tracker: VelocityTracker;
    raw: number;
  } | null = null;
  let lastScroll = -Infinity;
  /** A click that lands on a row before this time ends a swipe or a tap that closed an open row: not a tap. */
  let swallowUntil = 0;
  let disposed = false;
  let side: 'lead' | 'trail' | null = null;
  let armed = false;

  const paint = (c: Current, x: number) => {
    c.face.style.transform = x === 0 ? '' : `translate3d(${x}px, 0, 0)`;
    // A side with no action shows nothing under the row (it only resists).
    const nextSide = x > 0 && c.actions.lead ? 'lead' : x < 0 && c.actions.trail ? 'trail' : null;
    if (nextSide !== side) {
      side = nextSide;
      if (side) layer.dataset.side = side;
      else delete layer.dataset.side;
    }
    const nextArmed = Math.abs(x) >= commitDistance(c.width) - 0.5;
    if (nextArmed !== armed) {
      armed = nextArmed;
      if (armed) layer.dataset.armed = '';
      else delete layer.dataset.armed;
    }
    // Past the button's width, the label keeps beside the row's edge.
    if (leadIn) leadIn.style.transform = x > SWIPE_ROW_REVEAL_PX ? `translate3d(${x - SWIPE_ROW_REVEAL_PX}px, 0, 0)` : '';
    if (trailIn) trailIn.style.transform = x < -SWIPE_ROW_REVEAL_PX ? `translate3d(${x + SWIPE_ROW_REVEAL_PX}px, 0, 0)` : '';
  };

  /** The row is at rest: the layer goes, and the row is as it was. */
  const rest = (c: Current) => {
    c.spring.stop();
    paint(c, 0);
    delete c.face.dataset.swipe;
    if (current === c) {
      current = null;
      setOpen(false);
      delete layer.dataset.lead;
      layer.style.height = '0px';
    }
  };

  const place = (c: Current, title: string) => {
    const box = c.face.getBoundingClientRect();
    const frame = body.getBoundingClientRect();
    // Inside the row's whole pixels and above its bottom hairline: a row at a fractional height, moved on its own
    // layer, would otherwise leave a 1 px seam of the action's colour under it.
    const top = box.top - frame.top - body.clientTop + body.scrollTop;
    const snapped = Math.ceil(top);
    layer.style.top = `${snapped}px`;
    layer.style.left = `${box.left - frame.left - body.clientLeft + body.scrollLeft}px`;
    layer.style.width = `${box.width}px`;
    layer.style.height = `${Math.max(0, Math.floor(top + box.height) - snapped - 1)}px`;
    if (c.actions.lead) layer.dataset.lead = c.actions.lead;
    else delete layer.dataset.lead;
    lead?.setAttribute('aria-label', `${c.actions.lead === 'mark-unread' ? SWIPE_UNREAD_LABEL : SWIPE_QUIET_NAME}: ${title}`);
    trail?.setAttribute('aria-label', `${SWIPE_ARCHIVE_LABEL}: ${title}`);
  };

  /** Takes the layer for a row (another row holding it goes to rest at once). */
  const take = (face: HTMLElement): Current | null => {
    // A row sliding off after Archive is not caught: its action has run.
    if (current?.face === face) return current.leaving ? null : current;
    const actions = options.actionsOf(idOf(face));
    if (!actions || (!actions.lead && !actions.trail)) return null;
    if (current?.leaving) current.leaving();
    else if (current) rest(current);
    // An archived row still fading back in shows whole at once.
    face.style.opacity = '';
    face.style.transition = '';
    const width = face.getBoundingClientRect().width;
    const c: Current = { face, id: idOf(face), actions, width, open: false, spring: null as unknown as Spring };
    c.spring = new Spring((x) => paint(c, x), reduced);
    current = c;
    place(c, actions.title);
    face.dataset.swipe = '';
    return c;
  };

  /** Closes the open (or springing) row. `bounce`: a drag closed it. */
  const close = (velocity = 0, bounce = false) => {
    const c = current;
    if (!c) return;
    setOpen(false);
    if (!c.face.isConnected) return rest(c);
    c.spring.to(0, velocity, { bounce, done: () => rest(c) });
  };

  /** While a row rests open: a touch anywhere else closes it (and a scroll of the list, `onScroll`). */
  let watching = false;
  const setOpen = (open: boolean) => {
    if (current) current.open = open;
    if (open === watching) return;
    watching = open;
    if (open) doc.addEventListener('touchstart', onAnyTouch, true);
    else doc.removeEventListener('touchstart', onAnyTouch, true);
  };
  function onAnyTouch(event: TouchEvent) {
    if (!current?.open) return;
    if (event.target instanceof Node && layer.contains(event.target)) return;
    // A tap that closes an open row is not a tap on a row (as Mail does); a swipe from it starts as usual.
    if (faceOf(event.target, body)) swallowUntil = performance.now() + 800;
    close();
  }

  /** `tap`: its button was tapped (no force: no bounce). */
  const runLead = (c: Current, velocity: number, tap = false) => {
    const action = c.actions.lead;
    if (!action) return close(velocity, !tap);
    // Quiet (or Mark unread) leaves the row where it is: it springs back into place, and the list shows its new
    // state there. A warning's Cancel changes nothing, so the row is already back where it was.
    setOpen(false);
    c.spring.to(0, velocity, { bounce: !tap, done: () => rest(c) });
    options.onAction(c.id, action);
  };

  const runTrail = (c: Current, velocity: number, tap = false) => {
    if (!c.actions.trail) return close(velocity, !tap);
    setOpen(false);
    const face = c.face;
    const written = Promise.resolve()
      .then(() => options.onAction(c.id, 'archive'))
      .catch(() => {});
    const back = () => {
      // The row comes back where it was, faded in, once the write has landed: the held list shows it Archived there.
      void written.then(() => {
        if (disposed || !face.isConnected || current?.face === face) return;
        if (reduced()) {
          face.style.opacity = '';
          return;
        }
        // A frame after the row went to 0, so the change is drawn as a fade.
        requestAnimationFrame(() => {
          if (face.style.opacity !== '0') return;
          face.style.transition = `opacity ${FADE_IN_MS}ms ease-out`;
          face.style.opacity = '1';
        });
        setTimeout(() => {
          if (face.style.opacity === '1') {
            face.style.opacity = '';
            face.style.transition = '';
          }
        }, FADE_IN_MS + 80);
      });
    };
    if (reduced() || !face.isConnected) {
      // No slide: the row stays and shows its new state once the write lands.
      rest(c);
      return;
    }
    const left = () => {
      if (!c.leaving) return;
      c.leaving = undefined;
      face.style.opacity = '0';
      rest(c);
      back();
    };
    c.leaving = left;
    c.spring.to(-c.width, Math.min(velocity, -1.2), { exit: true, done: left });
  };

  const release = () => {
    const t = touch;
    const c = current;
    touch = null;
    if (!t || t.phase !== 'swipe' || !c || c.face !== t.face) return;
    swallowUntil = performance.now() + 400;
    const v = t.tracker.velocity(performance.now());
    const outcome = releaseOutcome(t.raw, v, c.width, c.actions);
    if (outcome === 'commit-lead') return runLead(c, v);
    if (outcome === 'commit-trail') return runTrail(c, v);
    if (outcome === 'reveal-lead' || outcome === 'reveal-trail') {
      setOpen(true);
      c.spring.to(outcome === 'reveal-lead' ? SWIPE_ROW_REVEAL_PX : -SWIPE_ROW_REVEAL_PX, v, { bounce: true });
      return;
    }
    close(v, true);
  };

  /** The finger is no longer a swipe's (a scroll took it, a second finger, the browser cancelled it). */
  const letGo = () => {
    const t = touch;
    touch = null;
    unlisten(t);
    if (t?.phase === 'swipe' && current?.face === t.face) close(0, false);
  };

  const listen = (target: EventTarget) => {
    target.addEventListener('touchmove', onMove as EventListener, { passive: true });
    target.addEventListener('touchend', onEnd as EventListener, { passive: true });
    target.addEventListener('touchcancel', onCancel as EventListener, { passive: true });
  };
  const unlisten = (t: { target: EventTarget } | null) => {
    if (!t) return;
    t.target.removeEventListener('touchmove', onMove as EventListener);
    t.target.removeEventListener('touchend', onEnd as EventListener);
    t.target.removeEventListener('touchcancel', onCancel as EventListener);
  };

  function onStart(event: TouchEvent) {
    if (touch) {
      // A second finger: not a swipe.
      letGo();
      return;
    }
    if (event.touches.length !== 1) return;
    // A pull to refresh owns the list while it shows; a list still moving is stopped by this touch, not swiped.
    if (body.dataset.pull !== undefined || performance.now() - lastScroll < SCROLL_REST_MS) return;
    const face = faceOf(event.target, body);
    if (!face) return;
    const finger = event.touches[0]!;
    if (startsAtEdge(finger.clientX, view.innerWidth)) return;
    const tracker = new VelocityTracker();
    tracker.reset(finger.clientX, performance.now());
    touch = { id: finger.identifier, face, target: event.target!, x0: finger.clientX, y0: finger.clientY, phase: 'maybe', base: 0, lockDx: 0, tracker, raw: 0 };
    listen(event.target!);
  }

  const fingerOf = (event: TouchEvent) => {
    if (!touch) return null;
    for (const t of Array.from(event.touches)) if (t.identifier === touch.id) return t;
    return null;
  };

  function onMove(event: TouchEvent) {
    const t = touch;
    if (!t) return;
    if (event.touches.length !== 1) return letGo();
    const finger = fingerOf(event);
    if (!finger) return;
    const dx = finger.clientX - t.x0;
    const dy = finger.clientY - t.y0;
    const now = performance.now();
    if (t.phase === 'maybe') {
      const lock = lockSwipe(dx, dy);
      if (lock === 'wait') return;
      if (lock === 'scroll') {
        touch = null;
        unlisten(t);
        return;
      }
      const c = take(t.face);
      if (!c) {
        touch = null;
        unlisten(t);
        return;
      }
      // Caught mid-spring or open: the swipe goes on from where the row is.
      t.base = c.spring.stop();
      setOpen(false);
      t.lockDx = dx;
      t.phase = 'swipe';
      t.tracker.reset(finger.clientX, now);
    }
    const c = current;
    if (!c || c.face !== t.face) return letGo();
    t.tracker.add(finger.clientX, now);
    t.raw = t.base + dx - t.lockDx;
    c.spring.set(swipeOffset(t.raw, c.width, c.actions));
  }

  function onEnd(event: TouchEvent) {
    const t = touch;
    if (!t) return;
    if (event.touches.length > 0) return letGo();
    unlisten(t);
    release();
  }

  function onCancel() {
    letGo();
  }

  function onScroll() {
    lastScroll = performance.now();
    // The list scrolled: a finger on it is the page's, and an open row closes.
    if (touch) letGo();
    if (current?.open) close();
  }

  /** A click that ends a swipe, or the tap that closed an open row, opens nothing. */
  function onClick(event: MouseEvent) {
    if (performance.now() > swallowUntil) return;
    if (!faceOf(event.target, body)) return;
    swallowUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }

  /** The open row's buttons: a tap runs the action, as a full swipe does. */
  const onLeadClick = (event: Event) => {
    event.stopPropagation();
    if (current) runLead(current, 0, true);
  };
  const onTrailClick = (event: Event) => {
    event.stopPropagation();
    if (current) runTrail(current, 0, true);
  };

  body.addEventListener('touchstart', onStart, { passive: true });
  body.addEventListener('scroll', onScroll, { passive: true });
  body.addEventListener('click', onClick, true);
  lead?.addEventListener('click', onLeadClick);
  trail?.addEventListener('click', onTrailClick);
  return () => {
    disposed = true;
    body.removeEventListener('touchstart', onStart);
    body.removeEventListener('scroll', onScroll);
    body.removeEventListener('click', onClick, true);
    lead?.removeEventListener('click', onLeadClick);
    trail?.removeEventListener('click', onTrailClick);
    unlisten(touch);
    touch = null;
    if (current) rest(current);
    setOpen(false);
  };
}
