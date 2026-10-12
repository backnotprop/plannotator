import { Icon } from '../icons';

export interface InboxToastModel {
  /** Bumped per toast, so a new one replays its entrance. */
  id: number;
  text: string;
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
export function InboxToast({ toast, onDismiss }: { toast: InboxToastModel; onDismiss: () => void }) {
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
