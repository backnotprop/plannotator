import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Icon, type IconName } from '../icons';
import { hintText, ShortcutHint, useShortcutAria } from '../shortcuts/hint';
import { shortcutPrefs } from '../shortcuts/prefs';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';

/** `thumb`: 👍 Looks good (the emoji itself, as plan review's button draws it). */
export type InboxToastIcon = 'check' | 'warn' | 'archive' | 'mute' | 'thumb' | 'unpin';

export interface InboxToastModel {
  /** Bumped per toast, so a new one replays its entrance. */
  id: number;
  /** `warn`: the icon in the warning colour (an agent stopped or held up, an error). */
  icon: InboxToastIcon;
  /** The bold first words ("Marked read"). */
  lead: string;
  /** What a phone says instead ("Read"). */
  phoneLead?: string;
  /** The muted rest of the line; shown whole, wrapping to a second line when it does not fit. */
  detail?: string;
  /** An error: its message stays whole and may wrap. */
  wrap?: boolean;
  onUndo?: () => void;
  /** Desktop only (a phone's thread foot has Reply). */
  onReply?: () => void;
  /** One more action (compose: Open the thread just sent, or Drafts). */
  action?: { label: string; onPress: () => void };
  /**
   * What the live region says in place of lead and detail, when the line is
   * kept short for one line and a screen reader should still hear the whole
   * sentence (compose's Sent toast).
   */
  speech?: string;
}

const ICONS: Record<Exclude<InboxToastIcon, 'thumb'>, IconName> = { check: 'checkCircle', warn: 'warn', archive: 'archive', mute: 'mute', unpin: 'pinOff' };

/**
 * What the window's live region says for a toast, as sentences, and how to
 * undo it when it can be undone: "Marked read. Moves to Quiet. Press Z to
 * undo." (a phone has no Z: "Undo is available.").
 */
export function toastSpeech(toast: Pick<InboxToastModel, 'lead' | 'detail' | 'onUndo' | 'speech'>, phone = false, singleKeys = shortcutPrefs().singleKeys): string {
  const sentence = (text: string) => (/[.!?…”"]$/.test(text) ? text : `${text}.`);
  const said = toast.speech ? sentence(toast.speech) : toast.detail ? `${sentence(toast.lead)} ${sentence(toast.detail)}` : sentence(toast.lead);
  if (!toast.onUndo) return said;
  // With single keys off Z does nothing, so it is not offered.
  return `${said} ${phone || !singleKeys ? 'Undo is available.' : `Press ${hintText({ scope: inboxThreadShortcuts, action: 'undo' })} to undo.`}`;
}

/**
 * The window's one toast (Mark read, Archive, Unarchive, the sound): one
 * line in the look of Plannotator's other toasts (design record
 * "inbox-toast", approved 2026-10-14): an icon, a bold lead, a muted detail,
 * Undo (`Z` while it is up), and a × at its end (owner, 2026-10-20: a toast
 * can be closed or swiped away; it still leaves by itself after 7 s).
 * It never takes focus; the window's live region says it. Its words always
 * show whole: a detail that does not fit one line wraps to a second.
 *
 * `onDismiss` closes it early (the ×, a swipe): the window drops it and its
 * Undo with it, never performing the undo. `onHold(true)` while a swipe is
 * in progress pauses its timer; `onHold(false)` on a spring-back resumes it.
 */
export function InboxToast({ toast, phone = false, onDismiss, onHold }: { toast: InboxToastModel; phone?: boolean; onDismiss?: () => void; onHold?: (held: boolean) => void }) {
  return phone ? (
    <PhoneToast key={toast.id} toast={toast} onDismiss={onDismiss} onHold={onHold} />
  ) : (
    <DesktopToast key={toast.id} toast={toast} onDismiss={onDismiss} onHold={onHold} />
  );
}

function toastClass(toast: InboxToastModel, phone: boolean, closable: boolean): string {
  const actions = closable || !!toast.onUndo || !!toast.action || (!phone && !!toast.onReply);
  return [
    'ib-toast',
    phone ? 'ib-toast-phone' : '',
    toast.icon === 'warn' ? 'ib-toast-warn' : '',
    toast.wrap ? 'ib-toast-wrap' : '',
    actions ? '' : 'ib-toast-solo',
    closable ? 'ib-toast-closable' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function ToastBody({ toast, phone, onDismiss }: { toast: InboxToastModel; phone: boolean; onDismiss?: () => void }) {
  const reply = !phone && toast.onReply;
  const undoKeys = useShortcutAria({ scope: inboxThreadShortcuts, action: 'undo' });
  return (
    <>
      {toast.icon === 'thumb' ? (
        <span className="ib-temoji" aria-hidden="true">
          👍
        </span>
      ) : (
        <Icon name={ICONS[toast.icon]} size={16} />
      )}
      <span className="ib-tsay">
        <span className="ib-tlead">{phone ? (toast.phoneLead ?? toast.lead) : toast.lead}</span>
        {toast.detail && <span className="ib-tdetail">{toast.detail}</span>}
      </span>
      {(reply || toast.onUndo || toast.action || onDismiss) && (
        <span className="ib-tacts">
          {toast.action && (
            <button type="button" className="ib-tghost" onClick={toast.action.onPress} data-toast-action="">
              {toast.action.label}
            </button>
          )}
          {reply && (
            <button type="button" className="ib-tghost" onClick={toast.onReply} data-toast-reply="">
              Reply
            </button>
          )}
          {toast.onUndo && (
            <button type="button" className="ib-tundo" onClick={toast.onUndo} data-toast-undo="" aria-keyshortcuts={phone ? undefined : undoKeys}>
              Undo
              {!phone && <ShortcutHint scope={inboxThreadShortcuts} action="undo" className="" />}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="ib-tclose" onClick={onDismiss} aria-label="Dismiss" data-toast-dismiss="">
              <Icon name="x" size={14} />
            </button>
          )}
        </span>
      )}
    </>
  );
}

/**
 * A desktop toast: centered on the window, 16 px from its bottom edge, at
 * most 520 px wide and 16 px from each side (inbox.css), whatever is open
 * (owner, 2026-10-18: a toast is brief, so it may cover Reply or a file's
 * strip for a moment rather than move around them).
 */
function DesktopToast({ toast, onDismiss, onHold }: { toast: InboxToastModel; onDismiss?: () => void; onHold?: (held: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const swipe = useSwipeAway(ref, onDismiss, onHold);
  useRoomForClose(ref, !!onDismiss && !!toast.onUndo);
  return (
    <div ref={ref} className={toastClass(toast, false, !!onDismiss)} data-inbox-toast="" {...swipe}>
      <ToastBody toast={toast} phone={false} onDismiss={onDismiss} />
    </div>
  );
}

/**
 * The × must never make a toast's words wrap (a toast's copy is kept to one
 * line at 520 px). When the line would wrap with Undo's `Z` hint beside the
 * ×, the toast is marked `data-tight` and the hint is not drawn (`Z` still
 * undoes, and Undo still says its key). Decided before paint, again on each
 * window resize: the mark is taken off, the words measured, and put back only
 * when they would take a second line.
 */
function useRoomForClose(ref: RefObject<HTMLDivElement | null>, applies: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !applies) return;
    const fit = () => {
      el.removeAttribute('data-tight');
      const say = el.querySelector<HTMLElement>('.ib-tsay');
      if (!say) return;
      const line = parseFloat(getComputedStyle(say).lineHeight) || 20;
      if (say.getBoundingClientRect().height > line * 1.5) el.setAttribute('data-tight', '');
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [ref, applies]);
}

/**
 * The open thread's foot, measured while the toast is up: the toast sits above
 * it whatever its height (the reply box open, a wrapped row, the safe area).
 * Null when no thread's foot is on screen (the list, an open file).
 */
function useFootHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const foot = document.querySelector<HTMLElement>('section.ib-pane .ib-pfoot');
    if (!foot) return;
    const read = () => {
      const box = foot.getBoundingClientRect();
      setHeight(box.height > 0 ? box.height : null);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(foot);
    return () => observer.disconnect();
  }, []);
  return height;
}

/**
 * A phone's toast: across the window above the thread's foot, its words and
 * Undo (a 44 px target), never Reply (the foot has it) or the Z hint.
 */
function PhoneToast({ toast, onDismiss, onHold }: { toast: InboxToastModel; onDismiss?: () => void; onHold?: (held: boolean) => void }) {
  const foot = useFootHeight();
  const ref = useRef<HTMLDivElement>(null);
  const swipe = useSwipeAway(ref, onDismiss, onHold);
  return (
    <div
      ref={ref}
      className={toastClass(toast, true, !!onDismiss)}
      data-inbox-toast=""
      style={foot !== null ? { bottom: `${Math.round(foot) + 8}px` } : undefined}
      {...swipe}
    >
      <ToastBody toast={toast} phone onDismiss={onDismiss} />
    </div>
  );
}

/** How far a drag goes before it counts as a horizontal swipe rather than a tap or a scroll. */
const SWIPE_SLOP_PX = 6;
/** Past this share of the toast's width, letting go dismisses it. */
const SWIPE_DISMISS_SHARE = 0.4;
/** A flick this fast (px per ms) dismisses it from a shorter drag. */
const SWIPE_FLICK_SPEED = 0.5;
/** ...but never from less than this. */
const SWIPE_FLICK_MIN_PX = 16;
const SWIPE_OUT_MS = 180;
const SWIPE_BACK_MS = 260;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Swipe the toast away (touch, pen or mouse) and give focus back when it
 * goes. A horizontal drag moves it with the pointer (the CSS `translate`
 * property, so it composes with the desktop toast's centering transform);
 * let go past 40% of its width, or flick it, and it slides out that way and
 * is dismissed; short of that it springs back. A drag that starts vertical
 * is left to the page (`touch-action: pan-y`), and one that starts on a
 * button is the button's. Under reduced motion it follows the pointer but
 * nothing slides: it goes, or snaps back.
 *
 * The slide-out plays on an inert copy, so the window drops the toast (and
 * its Undo, `Z` included) the moment the person lets go. While a drag is in
 * progress its timer is paused (`onHold`), and resumed on a spring-back.
 * Once a drag starts, the entrance animation is turned off inline, so a
 * spring-back never replays it.
 *
 * Focus: the toast never takes it, but a person may Tab to Undo or the ×.
 * Whenever the toast leaves (the ×, a swipe, Undo, its timer) with focus
 * inside it, focus goes back where it came from, else to the open pane's
 * visible header, else the page's heading, never to the page body.
 */
function useSwipeAway(ref: RefObject<HTMLDivElement | null>, onDismiss?: () => void, onHold?: (held: boolean) => void) {
  const drag = useRef<{ id: number; x: number; y: number; dx: number; on: boolean; samples: { x: number; t: number }[] } | null>(null);
  const cameFrom = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onFocusIn = (event: FocusEvent) => {
      const from = event.relatedTarget;
      if (from instanceof HTMLElement && !el.contains(from)) cameFrom.current = from;
    };
    el.addEventListener('focusin', onFocusIn);
    return () => {
      el.removeEventListener('focusin', onFocusIn);
      // Runs before React takes the node out, so focus is still where it was.
      if (el.contains(document.activeElement)) returnFocus(cameFrom.current);
    };
  }, [ref]);

  if (!onDismiss) return {};

  const settle = (el: HTMLElement, dx: number) => {
    el.classList.remove('ib-toast-dragging');
    onHold?.(false);
    el.style.translate = '';
    el.style.opacity = '';
    if (dx === 0 || reducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [
        { translate: `${dx}px 0`, opacity: fadeAt(dx, el) },
        { translate: '0 0', opacity: 1 },
      ],
      { duration: SWIPE_BACK_MS, easing: 'cubic-bezier(0.34, 1.25, 0.64, 1)' },
    );
  };

  const leave = (el: HTMLElement, dx: number) => {
    if (!reducedMotion() && typeof el.animate === 'function' && el.parentElement) {
      // A copy slides out where the toast was; the toast itself goes at once.
      const ghost = el.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('data-inbox-toast');
      ghost.setAttribute('data-toast-ghost', '');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      ghost.style.pointerEvents = 'none';
      ghost.style.animation = 'none';
      el.parentElement.appendChild(ghost);
      const width = el.getBoundingClientRect().width || 320;
      const out = Math.sign(dx || 1) * (width + 24);
      const done = () => ghost.remove();
      const animation = ghost.animate(
        [
          { translate: `${dx}px 0`, opacity: fadeAt(dx, el) },
          { translate: `${out}px 0`, opacity: 0 },
        ],
        { duration: SWIPE_OUT_MS, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' },
      );
      animation.onfinish = done;
      animation.oncancel = done;
      setTimeout(done, SWIPE_OUT_MS + 200);
    }
    onDismiss();
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const state = drag.current;
    const el = ref.current;
    if (!state || state.id !== event.pointerId || !el) return;
    drag.current = null;
    if (!state.on) return;
    try {
      if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    const width = el.getBoundingClientRect().width || 1;
    const first = state.samples[0];
    const last = state.samples[state.samples.length - 1];
    const speed = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    const flick = Math.abs(speed) >= SWIPE_FLICK_SPEED && Math.abs(state.dx) >= SWIPE_FLICK_MIN_PX && Math.sign(speed) === Math.sign(state.dx);
    if (!cancelled && (Math.abs(state.dx) >= width * SWIPE_DISMISS_SHARE || flick)) leave(el, state.dx);
    else settle(el, state.dx);
  };

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if ((event.target as Element).closest('button, a, input, textarea')) return;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, on: false, samples: [{ x: event.clientX, t: event.timeStamp }] };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      const el = ref.current;
      if (!state || state.id !== event.pointerId || !el) return;
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      if (!state.on) {
        if (Math.abs(dy) > SWIPE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
          drag.current = null; // vertical: the page's
          return;
        }
        if (Math.abs(dx) <= SWIPE_SLOP_PX) return;
        state.on = true;
        try {
          el.setPointerCapture?.(event.pointerId);
        } catch {
          // A pointer the browser no longer tracks: the drag still works while it stays over the toast.
        }
        el.classList.add('ib-toast-dragging');
        // Inline, so removing the class on a spring-back never replays the entrance.
        el.style.animation = 'none';
        onHold?.(true);
        window.getSelection?.()?.removeAllRanges();
      }
      state.dx = dx;
      state.samples = [...state.samples.filter((s) => event.timeStamp - s.t < 100), { x: event.clientX, t: event.timeStamp }];
      el.style.translate = `${dx}px 0`;
      el.style.opacity = String(fadeAt(dx, el));
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => end(event, false),
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => end(event, true),
  };
}

/** The toast fades as it travels: half gone at its own width. */
function fadeAt(dx: number, el: HTMLElement): number {
  const width = el.getBoundingClientRect().width || 1;
  return Math.max(0.35, 1 - (Math.abs(dx) / width) * 0.5);
}

/**
 * Focus back where it was before the toast had it; else the open pane's
 * visible header (the thread's `‹ Inbox`, or its subject); else the page's
 * heading or the main content. Never the body: each candidate is tried in
 * turn until one actually takes focus (a hidden one cannot).
 */
function returnFocus(cameFrom: HTMLElement | null) {
  const usable = (node: HTMLElement | null): node is HTMLElement =>
    !!node && node.isConnected && !node.closest('[data-inbox-toast]') && !node.closest('[inert]') && !(node as HTMLButtonElement).disabled;
  const visible = (node: HTMLElement) => (typeof node.checkVisibility === 'function' ? node.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions) : true);
  const take = (node: HTMLElement | null, makeFocusable = false): boolean => {
    if (!usable(node) || !visible(node)) return false;
    if (makeFocusable && !node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
    node.focus({ preventScroll: true });
    return document.activeElement === node;
  };
  if (take(cameFrom)) return;
  const pane = [...document.querySelectorAll<HTMLElement>('section.ib-pane')].find(visible) ?? null;
  for (const back of pane?.querySelectorAll<HTMLElement>('.ib-phead .ib-pback') ?? []) if (take(back)) return;
  if (take(pane?.querySelector<HTMLElement>('.ib-subject') ?? null, true)) return;
  if (take(document.querySelector<HTMLElement>('.ib-main h1'), true)) return;
  take(document.querySelector<HTMLElement>('main.ib-main'), true);
}
