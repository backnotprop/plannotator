/**
 * PROTOTYPE ONLY (branch proto/composer-picker; never merged): the one picker of the composer redesign. A pill in the
 * composer's bottom row opens one list: a bottom sheet on a phone, a 360 px popover on a computer. The reply box and
 * New message both use it, so who gets the words is chosen the same way in both.
 *
 * - The sheet rises from the bottom (260 ms, ease-out) over a scrim; a drag down on its head, a tap on the scrim or
 *   Escape closes it. The popover fades in at the pill (140 ms). Both honour reduced motion (px.css).
 * - Keys are the list's own, as the To picker had them: type to filter (where it has a filter), ↓ ↑, Enter, Escape.
 *   No new shortcut.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { HostMark, Icon } from '../icons';

const SHEET_MS = 260;
const POP_MS = 140;

/** The pill in the composer's row: the agent's mark, a title that gives way with "…", a quiet detail and a chevron. */
export function PxPill({
  hosts,
  label,
  detail,
  ask = false,
  open,
  onClick,
  buttonRef,
  ariaLabel,
  disabled,
  attrs,
}: {
  /** The marks before the words: one agent, or the first few of several. None: no mark ("Choose an agent"). */
  hosts: readonly (string | null)[];
  label: string;
  /** A quiet word after the label ("High", "ended"). */
  detail?: string | null;
  /** Nobody is chosen yet: the pill asks, in the primary colour. */
  ask?: boolean;
  open: boolean;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  ariaLabel: string;
  disabled?: boolean;
  /** `data-*` attributes for the page's own lookups. */
  attrs?: Record<string, string | undefined>;
}) {
  return (
    <button
      type="button"
      ref={buttonRef as RefObject<HTMLButtonElement>}
      className="ib-px-pill"
      data-px-pill=""
      data-ask={ask ? '' : undefined}
      data-open={open ? '' : undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      {...attrs}
    >
      {hosts.length > 0 && (
        <span className="ib-px-pill-marks">
          {hosts.slice(0, 3).map((host, i) => (
            <span key={i} className="ib-atile">
              <HostMark host={host} />
            </span>
          ))}
        </span>
      )}
      <span className="ib-px-pill-n" dir="auto">
        {label}
      </span>
      {detail && <span className="ib-px-pill-d">{detail}</span>}
      <svg className="ib-px-pill-c" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m19.5 8.25-7.5 7.5-7.5-7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/**
 * The picker's surface. `open` false plays the way out, then unmounts. On a phone it is drawn in `host` (the dialog,
 * or the thread's pane) so it sits over the composer and above the keyboard; on a computer at `anchor`, above it when
 * there is more room there.
 */
export function PxSurface({
  open,
  phone,
  title,
  back,
  onClose,
  anchor,
  host,
  children,
  label,
  attrs,
}: {
  open: boolean;
  phone: boolean;
  /** The sheet's visible title ("To", "Who gets this reply", "Model"). */
  title: string;
  /** A way back to the list before (the Model page): its word and what it does. */
  back?: { label: string; onBack: () => void } | null;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  host: HTMLElement | null;
  children: ReactNode;
  label: string;
  attrs?: Record<string, string | undefined>;
}) {
  // Mounted through the way out.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // One frame at the start position, then the way in.
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), phone ? SHEET_MS : POP_MS);
    return () => clearTimeout(timer);
  }, [open, phone]);

  const ref = useRef<HTMLDivElement>(null);
  // A press outside closes it (the pill toggles it itself); Escape closes it before anything else hears the key.
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', press, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, onClose, anchor]);

  // A computer: at the pill. Below it when it fits, else above; never off the window.
  const [spot, setSpot] = useState<CSSProperties | undefined>(undefined);
  const place = useCallback(() => {
    const at = anchor.current?.getBoundingClientRect();
    const box = ref.current;
    if (!at || !box) return;
    const width = 360;
    const gap = 6;
    const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
    const below = window.innerHeight - at.bottom - gap - 8;
    const above = at.top - gap - 8;
    const wanted = Math.min(520, box.scrollHeight);
    const up = below < wanted && above > below;
    const room = Math.max(160, up ? above : below);
    const next: CSSProperties = up ? { left, bottom: window.innerHeight - at.top + gap, maxHeight: Math.min(520, room), transformOrigin: 'bottom left' } : { left, top: at.bottom + gap, maxHeight: Math.min(520, room), transformOrigin: 'top left' };
    setSpot((was) => (was && was.left === next.left && was.top === next.top && was.bottom === next.bottom && was.maxHeight === next.maxHeight ? was : next));
  }, [anchor]);
  useLayoutEffect(() => {
    if (phone || !mounted) return;
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [phone, mounted, place, title]);
  // The pill can move while the list is open (a context line comes in over the row): follow it.
  useLayoutEffect(() => {
    if (!phone && mounted) place();
  });

  // A phone: a drag down on the head moves the sheet with the finger; let go past a third of it (or with a flick) and
  // it closes, else it settles back.
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const [pull, setPull] = useState(0);
  const onDown = (event: React.PointerEvent) => {
    if (!phone || (event.target as Element).closest('button')) return;
    drag.current = { y: event.clientY, t: event.timeStamp, dy: 0 };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };
  const onMove = (event: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current.dy = Math.max(0, event.clientY - drag.current.y);
    setPull(drag.current.dy);
  };
  const onUp = (event: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const speed = d.dy / Math.max(1, event.timeStamp - d.t);
    const height = ref.current?.offsetHeight ?? 400;
    setPull(0);
    if (d.dy > height / 3 || (d.dy > 24 && speed > 0.5)) onClose();
  };

  if (!mounted) return null;
  const surface = (
    <>
      {phone && <div className="ib-px-scrim" data-px-scrim="" data-shown={shown ? '' : undefined} aria-hidden="true" />}
      <div
        ref={ref}
        className={`ib-px-pk ${phone ? 'ib-px-sheet' : 'ib-px-pop'}`}
        role="dialog"
        aria-label={label}
        data-px-picker=""
        data-shown={shown ? '' : undefined}
        data-dragging={pull > 0 ? '' : undefined}
        style={phone ? (pull > 0 ? { transform: `translateY(${pull}px)` } : undefined) : spot}
        // A press on the list must not take focus from the words (the caret stays where it was).
        onMouseDown={(event) => {
          if (!(event.target as Element).closest('input')) event.preventDefault();
        }}
        {...attrs}
      >
        {(phone || back) && (
          <div className="ib-px-head" data-drill={back ? '' : undefined} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            {phone && <span className="ib-px-grab" aria-hidden="true" />}
            {back && (
              <button type="button" className="ib-px-back" data-px-back="" onClick={back.onBack}>
                <Icon name="chevL" size={phone ? 18 : 14} />
                {back.label}
              </button>
            )}
            <span className="ib-px-title">{title}</span>
          </div>
        )}
        {children}
      </div>
    </>
  );
  return host ? createPortal(surface, host) : surface;
}

/** One row of the list: a mark, a title, a quiet line under it, and what is at its end (a check, a circle). */
export function PxRow({
  id,
  host,
  lead,
  title,
  detail,
  end,
  highlighted,
  plain,
  disabled,
  onClick,
  onHover,
  ariaLabel,
  selected,
  attrs,
  phone,
}: {
  id?: string;
  host?: string | null;
  /** In the mark's place (an icon), for a row that is not an agent. */
  lead?: ReactNode;
  title: string;
  detail?: string | null;
  end?: ReactNode;
  highlighted?: boolean;
  /** A quieter row ("Tag another agent"). */
  plain?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onHover?: () => void;
  ariaLabel?: string;
  selected?: boolean;
  attrs?: Record<string, string | undefined>;
  phone: boolean;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected ?? false}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      className={`ib-px-opt${highlighted ? ' ib-hl' : ''}${plain ? ' ib-px-plain' : ''}`}
      data-on={selected ? '' : undefined}
      onPointerMove={onHover}
      onClick={disabled ? undefined : onClick}
      {...attrs}
    >
      {lead !== undefined ? <span className="ib-px-lead">{lead}</span> : <span className={`ib-px-mark${phone ? ' ib-px-mark-30' : ''}`}>{host !== undefined && <HostMark host={host} />}</span>}
      <span className="ib-px-words">
        <span className="ib-px-t" dir="auto">
          {title}
        </span>
        {detail && <span className="ib-px-d">{detail}</span>}
      </span>
      <span className="ib-px-end">{end}</span>
    </div>
  );
}

export function PxCheck({ on }: { on: boolean }) {
  return <>{on && <Icon name="check" size={18} className="ib-px-ck" />}</>;
}

/** The time a session was last heard from, as the row's last quiet word ("10:31 AM"); a day name once it is older than today. */
export function pxTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : at.toLocaleDateString([], { weekday: 'short' });
}
