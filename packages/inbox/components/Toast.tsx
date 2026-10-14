import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Icon, type IconName } from '../icons';

export type InboxToastIcon = 'check' | 'warn' | 'archive' | 'mute';

export interface InboxToastModel {
  /** Bumped per toast, so a new one replays its entrance. */
  id: number;
  /** `warn`: the icon in the warning colour (an agent stopped or held up, an error). */
  icon: InboxToastIcon;
  /** The bold first words ("Marked read"). */
  lead: string;
  /** What a phone says instead ("Read"). */
  phoneLead?: string;
  /** The muted rest of the line, cut with "…" (it never wraps). */
  detail?: string;
  /** An error: its message stays whole and may wrap. */
  wrap?: boolean;
  onUndo?: () => void;
  /** Desktop only (a phone's thread foot has Reply). */
  onReply?: () => void;
  /** One more action (compose: Open the thread just sent, or Drafts). */
  action?: { label: string; onPress: () => void };
}

const ICONS: Record<InboxToastIcon, IconName> = { check: 'checkCircle', warn: 'warn', archive: 'archive', mute: 'mute' };

/**
 * What the window's live region says for a toast, as sentences, and how to
 * undo it when it can be undone: "Marked read. Moves to Quiet. Press Z to
 * undo." (a phone has no Z: "Undo is available.").
 */
export function toastSpeech(toast: Pick<InboxToastModel, 'lead' | 'detail' | 'onUndo'>, phone = false): string {
  const sentence = (text: string) => (/[.!?…”"]$/.test(text) ? text : `${text}.`);
  const said = toast.detail ? `${sentence(toast.lead)} ${sentence(toast.detail)}` : sentence(toast.lead);
  if (!toast.onUndo) return said;
  return `${said} ${phone ? 'Undo is available.' : 'Press Z to undo.'}`;
}

/**
 * The window's one toast (Mark read, Archive, Unarchive, the sound): one
 * line in the look of Plannotator's other toasts (design record
 * "inbox-toast", approved 2026-10-14): an icon, a bold lead, a muted detail
 * cut with "…", and Undo (`Z` while it is up). No close: it leaves after 7 s.
 * It never takes focus; the window's live region says it. `threadRouted`: a
 * thread is open in the route, so a desktop toast waits for its pane (still
 * loading) rather than sitting over the list and then hopping.
 */
export function InboxToast({ toast, phone = false, threadRouted = false }: { toast: InboxToastModel; phone?: boolean; threadRouted?: boolean }) {
  return phone ? <PhoneToast key={toast.id} toast={toast} /> : <DesktopToast key={toast.id} toast={toast} threadRouted={threadRouted} />;
}

function toastClass(toast: InboxToastModel, phone: boolean): string {
  const actions = !!toast.onUndo || !!toast.action || (!phone && !!toast.onReply);
  return [
    'ib-toast',
    phone ? 'ib-toast-phone' : '',
    toast.icon === 'warn' ? 'ib-toast-warn' : '',
    toast.wrap ? 'ib-toast-wrap' : '',
    actions ? '' : 'ib-toast-solo',
  ]
    .filter(Boolean)
    .join(' ');
}

function ToastBody({ toast, phone }: { toast: InboxToastModel; phone: boolean }) {
  const reply = !phone && toast.onReply;
  return (
    <>
      <Icon name={ICONS[toast.icon]} size={16} />
      <span className="ib-tsay">
        <span className="ib-tlead">{phone ? (toast.phoneLead ?? toast.lead) : toast.lead}</span>
        {toast.detail && <span className="ib-tdetail">{toast.detail}</span>}
      </span>
      {(reply || toast.onUndo || toast.action) && (
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
            <button type="button" className="ib-tundo" onClick={toast.onUndo} data-toast-undo="" aria-keyshortcuts={phone ? undefined : 'Z'}>
              Undo
              {!phone && <kbd aria-hidden="true">Z</kbd>}
            </button>
          )}
        </span>
      )}
    </>
  );
}

interface Anchor {
  /** The center, from the left of the toast's containing block. */
  x: number;
  /** From the bottom of the toast's containing block. */
  bottom: number;
  /** The width of what it sits over. */
  width: number;
}

/** How far above an open pane's or file's foot the toast sits. */
export const TOAST_FOOT_GAP = 12;
/** How far above the list's bottom the toast sits when no pane is open. */
export const TOAST_LIST_GAP = 20;
/** How long a toast waits for the pane of a thread that is still loading before it sits where it can. */
export const TOAST_PANE_WAIT_MS = 1500;

function shown(el: Element | null): DOMRect | null {
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return getComputedStyle(el).visibility === 'hidden' ? null : box;
}

interface Placement {
  anchor: Anchor | null;
  /** What to follow: a foot that grows (the reply box), a pane that resizes. */
  watch: Element[];
  /** It sits over a file that covers the thread (full screen, or a stacked window). */
  overFile?: boolean;
  /** A thread is open but its pane is not there yet (still loading). */
  pending?: boolean;
}

/**
 * Where the desktop toast sits:
 * - a file covering the thread (full screen, or a window too narrow for
 *   both): centered over the file, 12 px above its foot strip;
 * - an open pane (a thread, a decision): centered over it, 12 px above its
 *   foot, so it never covers Reply or New message;
 * - a thread routed whose pane is still loading: pending;
 * - no pane: centered over the list near its bottom;
 * - elsewhere (Settings): null, the window's bottom center (inbox.css).
 */
function placeOver(host: HTMLElement, threadRouted: boolean): Placement {
  const box = host.getBoundingClientRect();
  const at = (over: DOMRect, edge: number, gap: number): Anchor => ({
    x: Math.round(over.left + over.width / 2 - box.left),
    bottom: Math.round(box.bottom - edge + gap),
    width: Math.round(over.width),
  });
  let pane: { el: Element; box: DOMRect; foot: Element; footBox: DOMRect } | null = null;
  for (const el of host.querySelectorAll('section.ib-pane')) {
    const foot = el.querySelector('.ib-pfoot');
    const paneBox = shown(el);
    const footBox = shown(foot);
    if (paneBox && footBox) {
      pane = { el, box: paneBox, foot: foot!, footBox };
      break;
    }
  }
  const view = host.querySelector('.ib-view');
  const viewBox = shown(view);
  if (view && viewBox && (view.classList.contains('ib-full') || !pane)) {
    const foot = view.querySelector('[data-view-foot]');
    const footBox = shown(foot);
    return { anchor: at(viewBox, footBox?.top ?? viewBox.bottom, footBox ? TOAST_FOOT_GAP : TOAST_LIST_GAP), watch: footBox ? [view, foot!] : [view], overFile: true };
  }
  if (pane) return { anchor: at(pane.box, pane.footBox.top, TOAST_FOOT_GAP), watch: [pane.el, pane.foot] };
  if (threadRouted) return { anchor: null, watch: [], pending: true };
  const list = host.querySelector('.ib-listcol');
  const listBox = shown(list);
  if (!listBox) return { anchor: null, watch: [] };
  return { anchor: at(listBox, listBox.bottom, TOAST_LIST_GAP), watch: [list!] };
}

interface Placed {
  anchor: Anchor | null;
  overFile: boolean;
  /** Not placed yet: waiting for a loading thread's pane. */
  hidden: boolean;
}

function useDesktopPlacement(ref: RefObject<HTMLElement | null>, threadRouted: boolean): Placed {
  const routed = useRef(threadRouted);
  routed.current = threadRouted;
  const [placed, setPlaced] = useState<Placed>({ anchor: null, overFile: false, hidden: false });
  useLayoutEffect(() => {
    const el = ref.current;
    // The toast's containing block (.pn-inbox is positioned).
    const host = el?.closest<HTMLElement>('.pn-inbox') ?? el?.parentElement;
    if (!el || !host) return;
    let frame = 0;
    let patient = true;
    let watched: Element[] = [];
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    const measure = () => {
      frame = 0;
      const next = placeOver(host, routed.current && patient);
      if (resize && (next.watch.length !== watched.length || next.watch.some((w, i) => w !== watched[i]))) {
        resize.disconnect();
        for (const w of next.watch) resize.observe(w);
        watched = next.watch;
      }
      setPlaced((current) => {
        // Waiting for a loading pane: stay where it is, or unseen until placed.
        if (next.pending) return current.anchor || current.hidden ? current : { ...current, hidden: true };
        const a = current.anchor;
        const b = next.anchor;
        const same = a === b || (!!a && !!b && a.x === b.x && a.bottom === b.bottom && a.width === b.width);
        return same && current.overFile === !!next.overFile && !current.hidden ? current : { anchor: b, overFile: !!next.overFile, hidden: false };
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // A pane opening or closing, a file going full screen, the reply box opening: the toast follows.
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', schedule);
    const giveUp = setTimeout(() => {
      patient = false;
      schedule();
    }, TOAST_PANE_WAIT_MS);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(giveUp);
      mutations.disconnect();
      resize?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [ref]);
  return placed;
}

function DesktopToast({ toast, threadRouted }: { toast: InboxToastModel; threadRouted: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { anchor, overFile, hidden } = useDesktopPlacement(ref, threadRouted);
  const style: CSSProperties = {
    ...(anchor ? { left: `${anchor.x}px`, bottom: `${anchor.bottom}px`, maxWidth: `min(520px, ${Math.max(anchor.width - 32, 160)}px)` } : {}),
    ...(hidden ? { visibility: 'hidden' } : {}),
  };
  return (
    <div ref={ref} className={`${toastClass(toast, false)}${overFile ? ' ib-toast-file' : ''}`} data-inbox-toast="" style={style}>
      <ToastBody toast={toast} phone={false} />
    </div>
  );
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
function PhoneToast({ toast }: { toast: InboxToastModel }) {
  const foot = useFootHeight();
  return (
    <div className={toastClass(toast, true)} data-inbox-toast="" style={foot !== null ? { bottom: `${Math.round(foot) + 8}px` } : undefined}>
      <ToastBody toast={toast} phone />
    </div>
  );
}
