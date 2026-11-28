import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { InboxApiError, InboxHeldError, type MachineView, type OutboxView } from '../api';
import { outboxLine, outboxPending, outboxReadAskedAt } from '../machines';
import { OutboxStateLine } from './HeldWrites';

type Machine = Pick<MachineView, 'name' | 'state'> | null;

/**
 * A write held for the linked computer the thread lives on ("Sending to Laptop: this applies once Laptop confirms."),
 * drawn as the thread draws its own held writes (OutboxStateLine: the send icon while that computer is online, the
 * clock while it is away). `at`: above the foot's buttons, below them, or under full screen's composer.
 */
export function HeldLine({ text, machine, at }: { text: string; machine: Machine; at: 'above' | 'below' | 'card' }) {
  return <OutboxStateLine line={{ tone: 'waiting', text }} machine={machine} foot={at} />;
}

/**
 * The line under a thread's reply box. A failure is an error: red, `role="alert"`. A held write did not fail: it is a
 * status (HeldLine), announced by the pane's polite region (`useFootHeld().live`), not by this line. A refusal that
 * takes the status's place is a new element, so it is a new alert, as any failure is.
 */
export function FootLine(props: { line: ReactNode; held: boolean; machine: Machine; above: boolean; updateFor: string | null; onUpdate?: (machine: string) => void; details: string | null; extra: ReactNode }) {
  if (props.held && typeof props.line === 'string') return <HeldLine text={props.line} machine={props.machine} at={props.above ? 'above' : 'below'} />;
  const updateFor = props.updateFor;
  return (
    <div className="ib-error" role="alert" data-foot-error={props.above ? 'above' : undefined}>
      {props.line}
      {updateFor !== null && (
        <>
          {' · '}
          <button type="button" className="ib-errup" data-error-update={updateFor} onClick={() => props.onUpdate?.(updateFor)}>
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
 * a held one is remembered by its outbox key, beside its words, so the line reads as a status while it is those words.
 * The window's outbox (`entries`, every entry by key) settles it: taken there, the line goes; refused there or never
 * sent, the line goes too when the thread shows that write's own "Not delivered … · Dismiss" (`shown`, the pane's
 * outbox), and otherwise (a file's or a guide's comment: the thread shows nothing for those) the outbox's own words
 * for it take its place, as an error. One thread at a time: another thread drops it, and a held write of the last
 * one answered late never shows on this one.
 */
export function useFootHeld(input: { entries: ReadonlyMap<string, OutboxView> | undefined; shown: readonly OutboxView[]; machine: Machine; thread: string; setLine: Dispatch<SetStateAction<string | null>> }) {
  const { entries, machine, thread, setLine } = input;
  const [held, setHeld] = useState<{ for: string; key: string; at: number } | null>(null);
  /** The held write was seen waiting in the outbox: gone from it later, it settled (a re-read keeps only what waits or failed). */
  const seen = useRef(false);
  const now = useRef({ thread, shown: input.shown });
  now.current = { thread, shown: input.shown };
  useEffect(() => setHeld(null), [thread]);
  useEffect(() => {
    if (!held || !entries) return;
    const entry = entries.get(held.key);
    if (entry && outboxPending(entry)) {
      seen.current = true;
      return;
    }
    // Never seen waiting: gone only once a whole read of the outbox asked after the write leaves it out (it waits
    // there from before the 202, so missing from that read it landed, or was dropped with nothing to say).
    if (!entry && !seen.current && (outboxReadAskedAt(entries) ?? -1) <= held.at) return;
    const failed = entry && entry.state !== 'delivered' ? outboxLine(entry, machine) : null;
    const after = failed && !now.current.shown.some((own) => own.key === held.key) ? failed.text : null;
    setLine((current) => (current === held.for ? after : current));
    setHeld(null);
  }, [entries, held, machine, setLine]);
  const say = (cause: unknown, fallback: string) => {
    if (cause instanceof InboxHeldError) {
      // Answered after the pane moved to another thread: that thread's write, not this one's.
      if (now.current.thread !== thread) return;
      seen.current = false;
      setHeld({ for: cause.message, key: cause.outbox.key, at: performance.now() });
    }
    setLine(cause instanceof InboxApiError ? cause.message : fallback);
  };
  const isHeld = (line: string | null) => line !== null && held?.for === line;
  /** The pane's polite region, always there (only its words change), so a screen reader says the status when it comes. */
  const live = (line: string | null) => <div className="ib-sr" role="status" data-foot-held-live="">{isHeld(line) ? line : null}</div>;
  return { say, isHeld, live };
}
