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
  // A phone: one line and Undo, so it never covers the reply foot (it auto-dismisses; the thread's banner says the rest).
  if (phone) {
    return (
      <div className="ib-toast ib-toast-phone" role="status" key={toast.id} data-inbox-toast="">
        <Icon name={toast.warn ? 'warn' : 'checkCircle'} size={16} />
        <span className="ib-tline">{toast.short ?? toast.text}</span>
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
