/** Opening takes focus off the text field so the keyboard goes down; closing restores it in the commit of the press, so iOS raises the keyboard again. */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const BOTTOM_SHEET_MS = 260;

const FLICK = 0.5;

export function BottomSheet({
  open,
  onClose,
  title,
  host,
  children,
  attrs,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  host: HTMLElement | null;
  children: ReactNode;
  attrs?: Record<string, string | undefined>;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), BOTTOM_SHEET_MS);
    return () => clearTimeout(timer);
  }, [open]);

  const ref = useRef<HTMLDivElement>(null);
  const before = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const sheet = ref.current;
    if (open && mounted && sheet) {
      if (before.current === null) {
        before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        sheet.focus({ preventScroll: true });
      }
      return;
    }
    if (open) return;
    const back = before.current;
    before.current = null;
    const active = document.activeElement;
    if (back && back.isConnected && (!active || active === document.body || sheet?.contains(active))) back.focus({ preventScroll: true });
  }, [open, mounted]);

  const acting = useRef(false);
  const act = () => {
    acting.current = true;
    queueMicrotask(() => {
      acting.current = false;
    });
  };
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => {
    if (!open) return;
    const focusIn = (event: FocusEvent) => {
      const sheet = ref.current;
      const target = event.target;
      if (!openNow.current || acting.current || !sheet || !(target instanceof HTMLElement) || sheet.contains(target)) return;
      before.current = target;
      sheet.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', focusIn);
    return () => document.removeEventListener('focusin', focusIn);
  }, [open]);

  // Escape closes the sheet before anything else hears the key (the dialog under it, the thread).
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, onClose]);

  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const [pull, setPull] = useState(0);
  const onDown = (event: ReactPointerEvent) => {
    drag.current = { y: event.clientY, t: event.timeStamp, dy: 0 };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };
  const onMove = (event: ReactPointerEvent) => {
    if (!drag.current) return;
    drag.current.dy = Math.max(0, event.clientY - drag.current.y);
    setPull(drag.current.dy);
  };
  const onUp = (event: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    setPull(0);
    const speed = d.dy / Math.max(1, event.timeStamp - d.t);
    const height = ref.current?.offsetHeight || 400;
    if (d.dy > height / 3 || (d.dy > 24 && speed > FLICK)) onClose();
  };

  if (!mounted) return null;
  const sheet = (
    <>
      {/* Closed on the click, not the press: a touch's click then lands on the scrim, never on what is under it. */}
      <div className="ib-sheet-scrim" data-sheet-scrim="" data-shown={shown && open ? '' : undefined} aria-hidden="true" onClick={open ? onClose : undefined} />
      <div
        ref={ref}
        className="ib-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-sheet=""
        data-shown={shown && open ? '' : undefined}
        data-dragging={pull > 0 ? '' : undefined}
        style={pull > 0 ? { transform: `translateY(${pull}px)` } : undefined}
        onClickCapture={act}
        onKeyDownCapture={act}
        {...attrs}
      >
        <div className="ib-sheet-head" data-sheet-head="" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <span className="ib-sheet-grab" aria-hidden="true" />
          <span className="ib-sheet-title">{title}</span>
        </div>
        {children}
      </div>
    </>
  );
  return createPortal(sheet, host ?? document.body);
}
