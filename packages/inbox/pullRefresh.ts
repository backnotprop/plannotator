export const PULL_READY_PX = 64;
export const PULL_HOLD_PX = 52;
export const PULL_SLOP_PX = 4;
export const PULL_SETTLE_MS = 320;
const PULL_LIMIT_PX = 240;
const PULL_ARM_PX = 200;
export const PULL_LOST_MS = 4000;

export function dampPull(raw: number): number {
  if (raw <= 0) return 0;
  return PULL_LIMIT_PX * (1 - 1 / ((raw * 0.55) / PULL_LIMIT_PX + 1));
}

export interface PullRefreshOptions {
  onRefresh: () => Promise<unknown> | unknown;
  reduced?: () => boolean;
}

type Phase = 'idle' | 'maybe' | 'pull' | 'refreshing' | 'settling';

export function attachPullToRefresh(body: HTMLElement, indicator: HTMLElement, options: PullRefreshOptions): () => void {
  let phase: Phase = 'idle';
  let startX = 0;
  let startY = 0;
  let travel = 0;
  let startTarget: EventTarget | null = null;
  let lastTouchPointer: number | null = null;
  let startPointer: number | null = null;
  let lostTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const reduced = () => options.reduced?.() ?? false;
  const doc = body.ownerDocument;
  const atTop = () => body.scrollTop < 1;
  const tracking = () => phase === 'maybe' || phase === 'pull';

  const paint = (px: number, state: string | null, animate: boolean) => {
    const motion = animate && !reduced();
    body.style.transition = motion ? `transform ${PULL_SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : '';
    indicator.style.transition = motion ? `opacity ${PULL_SETTLE_MS}ms ease-out, --ib-pull ${PULL_SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : '';
    body.style.transform = px > 0 ? `translate3d(0, ${px}px, 0)` : '';
    indicator.style.setProperty('--ib-pull', `${px}px`);
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
    if (phase === 'pull') settle();
    if (phase === 'refreshing') return;
    if (event.touches.length !== 1 || !atTop()) {
      if (phase === 'maybe') setPhase('idle');
      return;
    }
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

  function onAnyStart(event: TouchEvent) {
    if (phase === 'pull') settle();
    else if (phase === 'maybe' && event.touches.length > 1) setPhase('idle');
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === 'touch' && event.isPrimary) lastTouchPointer = event.pointerId;
  }

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
      if (dy < -PULL_SLOP_PX || (Math.abs(dx) > PULL_SLOP_PX && Math.abs(dx) > dy)) {
        setPhase('idle');
        return;
      }
      if (dy <= PULL_SLOP_PX) return;
      if (!event.cancelable || !atTop()) {
        setPhase('idle');
        return;
      }
      setPhase('pull');
    }
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
    if (event.touches.length > 0) {
      cancel();
      return;
    }
    release();
  }

  function onCancel() {
    cancel();
  }

  const lostTarget = () => startTarget instanceof Node && !startTarget.isConnected;
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
