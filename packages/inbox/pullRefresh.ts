/**
 * Pull down to refresh the list on a phone (the owner: "it's a natural
 * behavior we should support, same way clicking title works"). The page sets
 * `overscroll-none` and the list scrolls in its own box (`.ib-lbody`), so the
 * browser's own gesture never fires there; this is the Inbox's own, and it
 * calls the same refresh the list's title does (App.tsx refreshInbox).
 *
 * One finger dragging down from the very top of the list moves the list down
 * at a damped rate and reveals a small ↻ under the header, which turns with the
 * pull and is ready past PULL_READY_PX of damped travel. Released ready, the
 * list holds at PULL_HOLD_PX and the ↻ spins until the read lands, then both
 * spring back; released short, they spring back. A sideways move, a second
 * finger, or a start while the list is not at its top is not a pull. Only a
 * pull's own touchmoves are cancelled, and the non-passive touchmove listener
 * exists only while the list is near its top or a gesture is tracked, so a
 * scroll anywhere else never waits for this script.
 *
 * Everything moves by writing styles (never a React render per frame): the
 * list's transform, and on the indicator `--ib-pull` (the travel in px) and
 * `--ib-pull-turn` (the ↻'s rotation), with `data-state` naming the phase
 * (`pull`, `ready`, `refreshing`, `settling`). Under reduced motion nothing
 * turns, spins or springs: the ↻ shows, then hides.
 *
 * The gesture is an extra: the title button stays the accessible way, the
 * indicator is aria-hidden, and the live region says "Inbox refreshed" as for
 * the title.
 */

/** Damped travel at which a release refreshes. */
export const PULL_READY_PX = 64;
/** Where the list holds while the read is in flight. */
export const PULL_HOLD_PX = 52;
/** Finger travel before a move counts as a pull (a tap's jitter never does). */
export const PULL_SLOP_PX = 4;
/** The spring back. */
export const PULL_SETTLE_MS = 320;
/** The rubber band's limit: travel approaches it and never reaches it. */
const PULL_LIMIT_PX = 240;
/**
 * The touchmove listener is there while the list is this close to its top: a fling that ends at the top and a pull
 * straight after it find it in place (an engine reads the listeners when the finger lands, and adding one takes a
 * frame or two to reach it). Further down no scroll waits for this script.
 */
const PULL_ARM_PX = 200;
/**
 * A pull whose row left the document hears nothing more of its finger (its touch events go to the detached
 * row, and iOS may send the lift's pointerup there too): after this long with no word of it, it is let go.
 */
export const PULL_LOST_MS = 4000;

/** The finger's travel, damped: about half at first, then less and less (Apple's rubber band). */
export function dampPull(raw: number): number {
  if (raw <= 0) return 0;
  return PULL_LIMIT_PX * (1 - 1 / ((raw * 0.55) / PULL_LIMIT_PX + 1));
}

export interface PullRefreshOptions {
  /** The refresh: the promise settles when the read has landed. */
  onRefresh: () => Promise<unknown> | unknown;
  /** Whether motion is reduced now (read at each phase, so a change applies at once). */
  reduced?: () => boolean;
}

type Phase = 'idle' | 'maybe' | 'pull' | 'refreshing' | 'settling';

/**
 * Attaches the gesture to the list's scroll box. `indicator` is the ↻'s
 * holder (drawn under the header, behind the list). Returns the cleanup.
 */
export function attachPullToRefresh(body: HTMLElement, indicator: HTMLElement, options: PullRefreshOptions): () => void {
  let phase: Phase = 'idle';
  let startX = 0;
  let startY = 0;
  let travel = 0;
  /** The element the finger landed on: touch events keep going to it, even once it has left the document. */
  let startTarget: EventTarget | null = null;
  /** The touch pointer that started the gesture (from its pointerdown), so another finger's lift never ends it. */
  let lastTouchPointer: number | null = null;
  let startPointer: number | null = null;
  let lostTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const reduced = () => options.reduced?.() ?? false;
  const doc = body.ownerDocument;
  /** At the very top (under 1 px: a browser can report 0.5 at rest there). */
  const atTop = () => body.scrollTop < 1;
  const tracking = () => phase === 'maybe' || phase === 'pull';

  const paint = (px: number, state: string | null, animate: boolean) => {
    const motion = animate && !reduced();
    body.style.transition = motion ? `transform ${PULL_SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : '';
    indicator.style.transition = motion ? `opacity ${PULL_SETTLE_MS}ms ease-out, --ib-pull ${PULL_SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : '';
    body.style.transform = px > 0 ? `translate3d(0, ${px}px, 0)` : '';
    indicator.style.setProperty('--ib-pull', `${px}px`);
    // The ↻ keeps the turn it had at the release while it spins and settles.
    if (state !== 'refreshing' && state !== 'settling') indicator.style.setProperty('--ib-pull-turn', reduced() ? '0deg' : `${Math.round(Math.min(1, px / PULL_READY_PX) * 270)}deg`);
    indicator.style.opacity = state ? String(state === 'pull' ? Math.min(1, px / 40) : 1) : '0';
    if (state) {
      indicator.dataset.state = state;
      body.dataset.pull = state;
    } else {
      delete indicator.dataset.state;
      delete body.dataset.pull;
    }
  };

  /*
   * The non-passive touchmove listener is there only while it can matter: while the list is near its top (a
   * touch that starts there may become a pull) or a gesture is tracked. It must already be there when the
   * finger lands: both engines decide at touchstart whether that touch's moves may be cancelled (WebKit
   * from the touchmove listeners present then), so one added from touchstart would leave the pull's moves
   * uncancellable. A passive scroll listener adds it back near the top (PULL_ARM_PX) and takes it away below.
   *
   * While a gesture is tracked its end is also heard on the document (capture), and the touch pointer's
   * end too: the row the finger landed on can leave the list mid-pull (it moves section, another tab
   * archives it), and then its own touchend never reaches the list. Any new touch anywhere lets a
   * leftover pull go, and PULL_LOST_MS bounds one that hears nothing at all.
   */
  let armed = false;
  let watching = false;
  const sync = () => {
    const arm = !disposed && (tracking() || body.scrollTop < PULL_ARM_PX);
    if (arm !== armed) {
      armed = arm;
      if (arm) body.addEventListener('touchmove', onMove, { passive: false });
      else body.removeEventListener('touchmove', onMove);
    }
    const watch = !disposed && tracking();
    if (watch !== watching) {
      watching = watch;
      if (watch) {
        doc.addEventListener('touchstart', onAnyStart, true);
        doc.addEventListener('touchend', onEnd, true);
        doc.addEventListener('touchcancel', onCancel, true);
        doc.addEventListener('pointerup', onPointerEnd, true);
        doc.addEventListener('pointercancel', onPointerCancel, true);
      } else {
        doc.removeEventListener('touchstart', onAnyStart, true);
        doc.removeEventListener('touchend', onEnd, true);
        doc.removeEventListener('touchcancel', onCancel, true);
        doc.removeEventListener('pointerup', onPointerEnd, true);
        doc.removeEventListener('pointercancel', onPointerCancel, true);
      }
    }
  };
  const setPhase = (next: Phase) => {
    phase = next;
    if (!tracking()) {
      startTarget = null;
      startPointer = null;
      if (lostTimer) clearTimeout(lostTimer);
      lostTimer = null;
    }
    sync();
  };

  const settle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    travel = 0;
    if (reduced()) {
      setPhase('idle');
      paint(0, null, false);
      return;
    }
    setPhase('settling');
    paint(0, 'settling', true);
    indicator.style.opacity = '0';
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (phase !== 'settling') return;
      setPhase('idle');
      paint(0, null, false);
    }, PULL_SETTLE_MS);
  };

  const release = () => {
    if (phase === 'maybe') {
      setPhase('idle');
      return;
    }
    if (phase !== 'pull') return;
    if (travel < PULL_READY_PX) {
      settle();
      return;
    }
    setPhase('refreshing');
    paint(PULL_HOLD_PX, 'refreshing', true);
    void Promise.resolve()
      .then(() => options.onRefresh())
      .catch(() => {})
      .then(() => {
        if (!disposed && phase === 'refreshing') settle();
      });
  };

  const cancel = () => {
    if (phase === 'pull') settle();
    else if (phase === 'maybe') setPhase('idle');
  };

  function onStart(event: TouchEvent) {
    // A pull whose end never came (the lift was lost with its row): let it go before anything else.
    // (A second finger on a pull lands here too: the pull is let go.)
    if (phase === 'pull') settle();
    if (phase === 'refreshing') return;
    if (event.touches.length !== 1 || !atTop()) {
      if (phase === 'maybe') setPhase('idle');
      return;
    }
    // A touch during the spring back takes the list at rest.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    if (phase === 'settling') paint(0, null, false);
    const touch = event.touches[0]!;
    startX = touch.clientX;
    startY = touch.clientY;
    travel = 0;
    setPhase('maybe');
    startTarget = event.target;
    startPointer = lastTouchPointer;
    watchdog();
  }

  /** Any new touch anywhere (the header, the sidebar) while a gesture is tracked: a pull left over is let go. */
  function onAnyStart(event: TouchEvent) {
    if (phase === 'pull') settle();
    else if (phase === 'maybe' && event.touches.length > 1) setPhase('idle');
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === 'touch' && event.isPrimary) lastTouchPointer = event.pointerId;
  }

  /** (Re)starts the wait for a pull whose row left the document; checked when it runs out. */
  function watchdog() {
    if (lostTimer) clearTimeout(lostTimer);
    lostTimer = setTimeout(() => {
      lostTimer = null;
      if (tracking() && lostTarget()) cancel();
    }, PULL_LOST_MS);
  }

  function onMove(event: TouchEvent) {
    if (!tracking()) return;
    if (event.touches.length !== 1) {
      cancel();
      return;
    }
    const touch = event.touches[0]!;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (phase === 'maybe') {
      // Upward (the list scrolls) or sideways: not a pull.
      if (dy < -PULL_SLOP_PX || (Math.abs(dx) > PULL_SLOP_PX && Math.abs(dx) > dy)) {
        setPhase('idle');
        return;
      }
      if (dy <= PULL_SLOP_PX) return;
      // The browser started scrolling already (it will not let this move be cancelled), or the list moved: let it go.
      if (!event.cancelable || !atTop()) {
        setPhase('idle');
        return;
      }
      setPhase('pull');
    }
    // A pull that turns sideways is let go.
    if (Math.abs(dx) > 30 && Math.abs(dx) > dy) {
      if (event.cancelable) event.preventDefault();
      settle();
      return;
    }
    if (event.cancelable) event.preventDefault();
    watchdog();
    travel = dampPull(dy - PULL_SLOP_PX);
    paint(travel, travel >= PULL_READY_PX ? 'ready' : 'pull', false);
  }

  function onEnd(event: TouchEvent) {
    if (!tracking()) return;
    // One finger of two lifted: what is left is not this pull.
    if (event.touches.length > 0) {
      cancel();
      return;
    }
    release();
  }

  function onCancel() {
    cancel();
  }

  // The element the finger landed on has left the document: its touch events reach neither the list nor the
  // document, but the touch pointer, no longer held by it, ends on whatever is under the finger.
  const lostTarget = () => startTarget instanceof Node && !startTarget.isConnected;
  // Only the finger that started the gesture: another finger's lift never ends it.
  const ours = (event: PointerEvent) => event.pointerType === 'touch' && event.isPrimary && (startPointer === null || event.pointerId === startPointer);
  function onPointerEnd(event: PointerEvent) {
    if (ours(event) && lostTarget()) release();
  }
  function onPointerCancel(event: PointerEvent) {
    if (ours(event) && lostTarget()) cancel();
  }

  const onScroll = () => sync();

  body.addEventListener('pointerdown', onPointerDown, { passive: true });
  body.addEventListener('touchstart', onStart, { passive: true });
  body.addEventListener('touchend', onEnd, { passive: true });
  body.addEventListener('touchcancel', onCancel, { passive: true });
  body.addEventListener('scroll', onScroll, { passive: true });
  sync();
  return () => {
    disposed = true;
    if (settleTimer) clearTimeout(settleTimer);
    body.removeEventListener('pointerdown', onPointerDown);
    body.removeEventListener('touchstart', onStart);
    body.removeEventListener('touchend', onEnd);
    body.removeEventListener('touchcancel', onCancel);
    body.removeEventListener('scroll', onScroll);
    phase = 'idle';
    startTarget = null;
    startPointer = null;
    if (lostTimer) clearTimeout(lostTimer);
    lostTimer = null;
    sync();
    paint(0, null, false);
  };
}
