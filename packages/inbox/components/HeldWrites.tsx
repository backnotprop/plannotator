import type { MachineView, OutboxView } from '../api';
import { Icon } from '../icons';
import { outboxLine } from '../machines';

/**
 * Linked machines: what the person sent to another machine's thread that its Inbox has not taken yet, drawn as
 * their own reply is, with the outbox's state in place of the delivery line: "Sending…" until the other machine's
 * Inbox answers, never "Delivered" before (rule 12). Delivered, it is the thread's own and is not drawn here.
 * Shown in the thread, and in its place while the thread cannot open (that machine asleep), so a held answer is
 * never out of sight.
 */
export function HeldWrites({ entries, machine, onDismiss }: { entries: readonly OutboxView[]; machine: Pick<MachineView, 'name' | 'state'> | null; onDismiss?: (key: string) => void }) {
  return (
    <>
      {entries.map((entry) => {
        const line = outboxLine(entry, machine);
        if (!line) return null;
        const state = (
          <div className="ib-delivered" data-delivery={line.tone === 'failed' ? 'undelivered' : 'queued'} data-outbox-line="">
            <span className="ib-dl-main">
              <Icon name={line.tone === 'failed' ? 'warn' : machine?.state === 'online' ? 'send' : 'clock'} size={14} />
              <span className="ib-dl-text">{line.text}</span>
            </span>
            {line.tone === 'failed' && onDismiss && (
              <button type="button" className="ib-sendnow" data-outbox-dismiss="" onClick={() => onDismiss(entry.key)}>
                Dismiss
              </button>
            )}
          </div>
        );
        if (!entry.words) return <div key={entry.key} data-outbox={entry.key} data-outbox-state={entry.state}>{state}</div>;
        return (
          <article key={entry.key} className="ib-message" data-author="person" data-outbox={entry.key} data-outbox-state={entry.state}>
            <div className="ib-fline ib-is-open">
              <span className="ib-mk ib-big" aria-hidden="true">
                <Icon name="reply" />
              </span>
              <span className="ib-fl-nm ib-who">You</span>
            </div>
            <div className="ib-msg">
              <p className="ib-held-words" dir="auto">
                {entry.words}
              </p>
              {state}
            </div>
          </article>
        );
      })}
    </>
  );
}
