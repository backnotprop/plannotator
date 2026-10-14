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
}

const ICONS: Record<InboxToastIcon, IconName> = { check: 'checkCircle', warn: 'warn', archive: 'archive', mute: 'mute' };

/** What the window's live region says for a toast: "Marked read. Moves to Quiet." */
export function toastSpeech(toast: Pick<InboxToastModel, 'lead' | 'detail'>): string {
  const sentence = (text: string) => (/[.!?…”"]$/.test(text) ? text : `${text}.`);
  return toast.detail ? `${sentence(toast.lead)} ${sentence(toast.detail)}` : sentence(toast.lead);
}

/**
 * The window's one toast (Mark read, Archive, Unarchive, the sound): one
 * line in the look of Plannotator's other toasts (design record
 * "inbox-toast", approved 2026-10-14): an icon, a bold lead, a muted detail
 * cut with "…", and Undo (`Z` while it is up). No close: it leaves after 7 s.
 * It never takes focus; the window's live region says it.
 */
export function InboxToast({ toast, phone = false }: { toast: InboxToastModel; phone?: boolean }) {
  return phone ? <PhoneToast key={toast.id} toast={toast} /> : <DesktopToast key={toast.id} toast={toast} />;
}

function toastClass(toast: InboxToastModel, phone: boolean): string {
  const actions = !!toast.onUndo || (!phone && !!toast.onReply);
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
      {(reply || toast.onUndo) && (
        <span className="ib-tacts">
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

/** How far above an open pane's foot the toast sits. */
export const TOAST_FOOT_GAP = 12;
/** How far above the list's bottom the toast sits when no pane is open. */
export const TOAST_LIST_GAP = 20;

function shown(el: Element): DOMRect | null {
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return getComputedStyle(el).visibility === 'hidden' ? null : box;
}

/**
 * Where the desktop toast sits: centered over the open pane (a thread, a
 * decision) 12 px above its foot, so it never covers Reply or New message;
 * with no pane, centered over the list near its bottom. Null elsewhere
 * (Settings): the window's bottom center (inbox.css). Also what it watches,
 * so it follows a foot that grows (the reply box) and a pane that opens or
 * closes while it is up.
 */
function placeOver(host: HTMLElement): { anchor: Anchor | null; watch: Element[] } {
  const box = host.getBoundingClientRect();
  for (const pane of host.querySelectorAll('section.ib-pane')) {
    const foot = pane.querySelector('.ib-pfoot');
    const paneBox = shown(pane);
    const footBox = foot && shown(foot);
    if (!paneBox || !footBox) continue;
    return {
      anchor: { x: Math.round(paneBox.left + paneBox.width / 2 - box.left), bottom: Math.round(box.bottom - footBox.top + TOAST_FOOT_GAP), width: Math.round(paneBox.width) },
      watch: [pane, foot!],
    };
  }
  const list = host.querySelector('.ib-listcol');
  const listBox = list && shown(list);
  if (!listBox) return { anchor: null, watch: [] };
  return {
    anchor: { x: Math.round(listBox.left + listBox.width / 2 - box.left), bottom: Math.round(box.bottom - listBox.bottom + TOAST_LIST_GAP), width: Math.round(listBox.width) },
    watch: [list!],
  };
}

function useDesktopAnchor(ref: RefObject<HTMLElement | null>): Anchor | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    // The toast's containing block (.pn-inbox is positioned).
    const host = el?.closest<HTMLElement>('.pn-inbox') ?? el?.parentElement;
    if (!el || !host) return;
    let frame = 0;
    let watched: Element[] = [];
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    const measure = () => {
      frame = 0;
      const { anchor: next, watch } = placeOver(host);
      if (resize && (watch.length !== watched.length || watch.some((w, i) => w !== watched[i]))) {
        resize.disconnect();
        for (const w of watch) resize.observe(w);
        watched = watch;
      }
      setAnchor((current) =>
        current && next && current.x === next.x && current.bottom === next.bottom && current.width === next.width ? current : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // A pane opening or closing, the reply box opening: the toast follows.
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      mutations.disconnect();
      resize?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [ref]);
  return anchor;
}

function DesktopToast({ toast }: { toast: InboxToastModel }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useDesktopAnchor(ref);
  const style: CSSProperties | undefined = anchor
    ? { left: `${anchor.x}px`, bottom: `${anchor.bottom}px`, maxWidth: `min(520px, ${Math.max(anchor.width - 32, 160)}px)` }
    : undefined;
  return (
    <div ref={ref} className={toastClass(toast, false)} data-inbox-toast="" style={style}>
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
