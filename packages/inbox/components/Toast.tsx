import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Icon, type IconName } from '../icons';
import { hintText, ShortcutHint, useShortcutAria } from '../shortcuts/hint';
import { shortcutPrefs } from '../shortcuts/prefs';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import { useTouchPhone } from '../phone';
import { Tip } from './Tip';

export type InboxToastIcon = 'check' | 'warn' | 'archive' | 'mute' | 'thumb' | 'unpin' | 'clock' | 'unread';

export interface InboxToastModel {
  id: number;
  icon: InboxToastIcon;
  /**
   * Kept but never drawn (a reaction from the 👍's tray, approval "inbox-reaction-tray": the emoji flying to the
   * message is the confirmation, no toast): `Z` still undoes it and the live region still says it.
   */
  hidden?: boolean;
  lead: string;
  phoneLead?: string;
  detail?: string;
  phoneDetail?: string;
  wrap?: boolean;
  onUndo?: () => void;
  noKey?: boolean;
  onReply?: () => void;
  action?: { label: string; onPress: () => void };
  speech?: string;
}

const ICONS: Record<Exclude<InboxToastIcon, 'thumb'>, IconName> = { check: 'checkCircle', warn: 'warn', archive: 'archive', mute: 'mute', unpin: 'star', clock: 'clock', unread: 'envelope' };

export function toastSpeech(toast: Pick<InboxToastModel, 'lead' | 'detail' | 'onUndo' | 'speech'>, phone = false, singleKeys = shortcutPrefs().singleKeys): string {
  const sentence = (text: string) => (/[.!?…”"]$/.test(text) ? text : `${text}.`);
  const said = toast.speech ? sentence(toast.speech) : toast.detail ? `${sentence(toast.lead)} ${sentence(toast.detail)}` : sentence(toast.lead);
  if (!toast.onUndo) return said;
  return `${said} ${phone || !singleKeys ? 'Undo is available.' : `Press ${hintText({ scope: inboxThreadShortcuts, action: 'undo' })} to undo.`}`;
}

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

export function splitErrorAction(message: string): { head: string; action: string } {
  const starts = [...message.matchAll(/[.!?]\s+(?=\S)/g)].map((m) => m.index! + m[0].length);
  const cut = starts.at(-1);
  return cut === undefined ? { head: message, action: '' } : { head: message.slice(0, cut), action: message.slice(cut) };
}

function cutWithin(el: Element): boolean {
  return [el, ...el.querySelectorAll('*')].some((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
}

function ToastBody({ toast, phone, onDismiss }: { toast: InboxToastModel; phone: boolean; onDismiss?: () => void }) {
  const touchPhone = useTouchPhone();
  const reply = !(phone && touchPhone) && toast.onReply;
  const undoKeys = useShortcutAria({ scope: inboxThreadShortcuts, action: 'undo' });
  const lead = phone ? (toast.phoneLead ?? toast.lead) : toast.lead;
  const detail = phone ? (toast.phoneDetail ?? toast.detail) : toast.detail;
  const error = toast.wrap && !detail ? splitErrorAction(lead) : null;
  return (
    <>
      {toast.icon === 'thumb' ? (
        <span className="ib-temoji" aria-hidden="true">
          👍
        </span>
      ) : (
        <Icon name={ICONS[toast.icon]} size={16} />
      )}
      <Tip content={toast.speech ?? [lead, toast.detail].filter(Boolean).join(' · ')} when={(trigger) => cutWithin(trigger)}>
        <span className="ib-tsay">
          <span className="ib-tlead">
            {error?.action ? (
              <>
                <span className="ib-thead">{error.head}</span>
                <span className="ib-taction">{error.action}</span>
              </>
            ) : (
              lead
            )}
          </span>
          {detail && <span className="ib-tdetail">{detail}</span>}
        </span>
      </Tip>
      {(reply || toast.onUndo || toast.action || onDismiss) && (
        <span className="ib-tacts">
          {toast.action && (
            <Tip content={toast.action.label} when={(trigger) => cutWithin(trigger)}>
              <button type="button" className="ib-tghost" onClick={toast.action.onPress} data-toast-action="">
                <span className="ib-tlabel">{toast.action.label}</span>
              </button>
            </Tip>
          )}
          {reply && (
            <button type="button" className="ib-tghost" onClick={toast.onReply} data-toast-reply="">
              Reply
            </button>
          )}
          {toast.onUndo && (
            <button type="button" className="ib-tundo" onClick={toast.onUndo} data-toast-undo="" aria-keyshortcuts={toast.noKey || (phone && touchPhone) ? undefined : undoKeys}>
              Undo
              {!toast.noKey && !(phone && touchPhone) && <ShortcutHint scope={inboxThreadShortcuts} action="undo" className="" touchOnly />}
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

function DesktopToast({ toast, onDismiss, onHold }: { toast: InboxToastModel; onDismiss?: () => void; onHold?: (held: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const swipe = useSwipeAway(ref, onDismiss, onHold);
  useFit(ref, toast, false, !!onDismiss && !!toast.onUndo);
  return (
    <div ref={ref} className={toastClass(toast, false, !!onDismiss)} data-inbox-toast="" {...swipe}>
      <ToastBody toast={toast} phone={false} onDismiss={onDismiss} />
    </div>
  );
}

const MOST_LINES = { desktop: { error: 3, other: 2 }, phone: { error: 4, other: 1 } } as const;

function useFit(ref: RefObject<HTMLDivElement | null>, toast: InboxToastModel, phone: boolean, closableUndo: boolean) {
  const wrap = !!toast.wrap;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.removeAttribute('data-tight');
      el.removeAttribute('data-stack');
      el.removeAttribute('data-wrapped');
      const say = el.querySelector<HTMLElement>('.ib-tsay');
      if (!say) return;
      const style = getComputedStyle(say);
      const line = parseFloat(style.lineHeight) || 20;
      const lines = () => (say.getBoundingClientRect().height - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)) / line;
      if (!phone && !wrap && closableUndo && lines() > 1.5) el.setAttribute('data-tight', '');
      if (!phone && lines() > 1.5) el.setAttribute('data-wrapped', '');
      const most = MOST_LINES[phone ? 'phone' : 'desktop'][wrap ? 'error' : 'other'];
      if (lines() > most + 0.5) el.setAttribute('data-stack', '');
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [ref, phone, wrap, closableUndo, toast.lead, toast.phoneLead, toast.detail, toast.phoneDetail]);
}

const PHONE_FLOOR = [
  'section.ib-pane .ib-pfoot',
  '.ib-fvdock-phone .ib-fvbar',
  '.ib-fvdock-phone .ib-fvhandle',
  '.ib-view.ib-phone .ib-fvchip',
  '.ib-view.ib-phone .ib-optcap',
  '.ib-view.ib-phone .ib-linknote',
].join(', ');
const PHONE_FLOOR_OWN = '.ib-imgcompose, .ib-fcomp';

function usePhoneFloor(ref: RefObject<HTMLDivElement | null>): number | null {
  const [floor, setFloor] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let watched: HTMLElement[] = [];
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    const measure = () => {
      if (document.querySelector(PHONE_FLOOR_OWN)) {
        setFloor(null);
        return;
      }
      const found = [...document.querySelectorAll<HTMLElement>(PHONE_FLOOR)].filter((node) => !el.contains(node));
      const container = el.offsetParent instanceof HTMLElement ? el.offsetParent.getBoundingClientRect().bottom : window.innerHeight;
      let top = Infinity;
      for (const node of found) {
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) top = Math.min(top, box.top);
      }
      setFloor(top === Infinity ? null : Math.max(0, Math.round(container - top)) + 8);
      if (resize) {
        for (const node of watched) if (!found.includes(node)) resize.unobserve(node);
        for (const node of found) if (!watched.includes(node)) resize.observe(node);
      }
      watched = found;
    };
    measure();
    // Many mutations come at once (a thread rendering): measured once, at the next frame.
    let frame = 0;
    const soon = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(soon);
    mutations?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      mutations?.disconnect();
      resize?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref]);
  return floor;
}

function PhoneToast({ toast, onDismiss, onHold }: { toast: InboxToastModel; onDismiss?: () => void; onHold?: (held: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const floor = usePhoneFloor(ref);
  const swipe = useSwipeAway(ref, onDismiss, onHold);
  useFit(ref, toast, true, !!onDismiss && !!toast.onUndo);
  return (
    <div ref={ref} className={toastClass(toast, true, !!onDismiss)} data-inbox-toast="" style={floor !== null ? { bottom: `${floor}px` } : undefined} {...swipe}>
      <ToastBody toast={toast} phone onDismiss={onDismiss} />
    </div>
  );
}

const SWIPE_SLOP_PX = 6;
const SWIPE_DISMISS_SHARE = 0.4;
/** A flick this fast (px per ms) dismisses it from a shorter drag. */
const SWIPE_FLICK_SPEED = 0.5;
const SWIPE_FLICK_MIN_PX = 16;
const SWIPE_OUT_MS = 180;
const SWIPE_BACK_MS = 260;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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

function fadeAt(dx: number, el: HTMLElement): number {
  const width = el.getBoundingClientRect().width || 1;
  return Math.max(0.35, 1 - (Math.abs(dx) / width) * 0.5);
}

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
