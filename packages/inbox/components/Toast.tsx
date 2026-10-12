import { useLayoutEffect, useState } from 'react';
import { Icon } from '../icons';

export interface InboxToastModel {
  /** Bumped per toast, so a new one replays its entrance. */
  id: number;
  text: string;
  /** What a phone says instead, on one line beside Undo: the details are in the thread's own banner. */
  short?: string;
  sub?: string;
  /** An agent was stopped or held up on the thread: the warning icon, and Reply. */
  warn?: boolean;
  onUndo?: () => void;
  onReply?: () => void;
}

/**
 * The window's one toast (Mark read, Archive): what happened, and Undo (`Z`
 * while it is up). It sits over the bottom of the window and never takes focus.
 */
export function InboxToast({ toast, onDismiss, phone = false }: { toast: InboxToastModel; onDismiss: () => void; phone?: boolean }) {
  if (phone) return <PhoneToast key={toast.id} toast={toast} onDismiss={onDismiss} />;
  return (
    <div className="ib-toast" role="status" key={toast.id} data-inbox-toast="">
      <Icon name={toast.warn ? 'warn' : 'checkCircle'} size={16} />
      <div className="ib-tmsg">
        <span>{toast.text}</span>
        {toast.sub && <small>{toast.sub}</small>}
      </div>
      <div className="ib-tacts">
        {toast.onReply && (
          <button type="button" className="ib-tb" onClick={toast.onReply} data-toast-reply="">
            Reply
          </button>
        )}
        {toast.onUndo && (
          <button type="button" className="ib-tb" onClick={toast.onUndo} data-toast-undo="">
            Undo <kbd className="ib-kbd ib-wide">Z</kbd>
          </button>
        )}
        <button type="button" className="ib-tb ib-tx" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="x" size={14} />
        </button>
      </div>
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
 * A phone's toast: its words and Undo, never Reply (the thread's foot has
 * it). A short note (`short`: "Read. Will move to Quiet.") is one line, and the
 * thread's banner says the rest; anything else, an error, wraps.
 */
function PhoneToast({ toast, onDismiss }: { toast: InboxToastModel; onDismiss: () => void }) {
  const foot = useFootHeight();
  return (
    <div
      className="ib-toast ib-toast-phone"
      role="status"
      key={toast.id}
      data-inbox-toast=""
      style={foot !== null ? { bottom: `${Math.round(foot) + 8}px` } : undefined}
    >
      <Icon name={toast.warn ? 'warn' : 'checkCircle'} size={16} />
      <span className={toast.short ? 'ib-tline ib-tone' : 'ib-tline'}>{toast.short ?? toast.text}</span>
      {toast.onUndo ? (
        <button type="button" className="ib-tb" onClick={toast.onUndo} data-toast-undo="">
          Undo
        </button>
      ) : (
        <button type="button" className="ib-tb ib-tx" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}
