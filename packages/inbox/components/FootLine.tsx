import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { InboxApiError, InboxHeldError, type MachineView, type OutboxView } from '../api';
import { Icon } from '../icons';
import { outboxLine, outboxPending } from '../machines';

/**
 * The line under a thread's reply box. A failure is an error: red, `role="alert"`. A write held for the linked
 * computer the thread lives on ("Sending to Laptop: this applies once Laptop confirms.") did not fail: it is a
 * status, drawn as decision mode draws the same words (the clock and the quiet look of the thread's held writes).
 */
export function FootLine(props: { line: ReactNode; held: boolean; above: boolean; update: { machine: string; onPress: () => void } | null; details: string | null; extra: ReactNode }) {
  if (props.held) {
    return (
      <div className="ib-delivered" data-delivery="queued" role="status" data-foot-held={props.above ? 'above' : ''}>
        <span className="ib-dl-main">
          <Icon name="clock" size={14} />
          <span className="ib-dl-text">{props.line}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="ib-error" role="alert" data-foot-error={props.above ? 'above' : undefined}>
      {props.line}
      {props.update && (
        <>
          {' · '}
          <button type="button" className="ib-errup" data-error-update={props.update.machine} onClick={props.update.onPress}>
            Update
          </button>
        </>
      )}
      {/* A failed Send's own words (a path, the Inbox's message), one press away (decision D3). */}
      {props.details && (
        <details className="ib-errd" data-error-details="">
          <summary>Details</summary>
          <span className="ib-errd-t">{props.details}</span>
        </details>
      )}
      {props.extra}
    </div>
  );
}

/**
 * The foot's line for a write that may be held for a linked computer. `say` sets the line from a write's failure;
 * a held one is remembered by its outbox key, beside its words (as the line's Details and Update are), so the line
 * reads as a status while it is those words. The window's outbox (`entries`, every entry by key) settles it: taken
 * there, the line goes; refused there or never sent, the outbox's own words for that replace it, as an error.
 */
export function useFootHeld(entries: ReadonlyMap<string, OutboxView> | undefined, machine: Pick<MachineView, 'name' | 'state'> | null, setLine: Dispatch<SetStateAction<string | null>>) {
  const [held, setHeld] = useState<{ for: string; key: string } | null>(null);
  /** The held write was seen waiting in the outbox: gone from it later, it settled (a re-read keeps only what waits or failed). */
  const seen = useRef(false);
  useEffect(() => {
    if (!held || !entries) return;
    const entry = entries.get(held.key);
    if (entry && outboxPending(entry)) {
      seen.current = true;
      return;
    }
    if (!entry && !seen.current) return;
    const after = entry && entry.state !== 'delivered' ? (outboxLine(entry, machine)?.text ?? null) : null;
    setLine((current) => (current === held.for ? after : current));
    setHeld(null);
  }, [entries, held, machine, setLine]);
  const say = (cause: unknown, fallback: string) => {
    if (cause instanceof InboxHeldError) {
      seen.current = false;
      setHeld({ for: cause.message, key: cause.outbox.key });
    }
    setLine(cause instanceof InboxApiError ? cause.message : fallback);
  };
  return { say, isHeld: (line: string | null) => line !== null && held?.for === line };
}
