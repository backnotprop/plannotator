import { useLayoutEffect, useRef } from 'react';
import type { MachineView, OutboxView } from '../api';
import { HeldWrites } from './HeldWrites';

export function ThreadWait(props: {
  load: { state: 'failed' | 'missing' | 'refused'; error: string; waiting?: string | null } | null;
  onRetry: () => void;
  onClose: () => void;
  onFocusLeaving: () => void;
  away?: string | null;
  held?: { entries: readonly OutboxView[]; machine: Pick<MachineView, 'name' | 'state'> | null; onDismiss?: (key: string) => void };
}) {
  const { load } = props;
  const ref = useRef<HTMLDivElement>(null);
  const leaving = useRef(props.onFocusLeaving);
  leaving.current = props.onFocusLeaving;
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el && typeof document !== 'undefined' && el.contains(document.activeElement)) leaving.current();
    };
  }, []);
  return (
    <div ref={ref} className="ib-pane ib-pwait" data-thread-wait={load?.state ?? 'loading'} aria-busy={load === null}>
      <div className="ib-pwait-line" role="status">
        {load?.state === 'missing' ? (
          <>
            <span>This thread is not in the Inbox. It may have been deleted.</span>
            <button type="button" className="ib-btn" onClick={props.onClose} data-thread-wait-close="">
              Close
            </button>
          </>
        ) : load?.state === 'refused' ? (
          <>
            <span data-thread-wait-refused="">{load.error}</span>
            <button type="button" className="ib-btn" onClick={props.onClose} data-thread-wait-close="">
              Close
            </button>
          </>
        ) : load?.state === 'failed' && (props.away || load.waiting) ? (
          <>
            <span data-thread-wait-away={props.away ? '' : undefined} data-thread-wait-unlisted={props.away ? undefined : ''}>
              {props.away || load.waiting}
            </span>
            <button type="button" className="ib-btn" onClick={props.onClose} data-thread-wait-close="">
              Close
            </button>
          </>
        ) : load?.state === 'failed' ? (
          <>
            <span>Couldn't load this thread ({load.error}). Trying again…</span>
            <button type="button" className="ib-btn" onClick={props.onRetry} data-thread-wait-retry="">
              Try again
            </button>
          </>
        ) : (
          <span>Opening the thread…</span>
        )}
      </div>
      {props.held && props.held.entries.length > 0 && (
        <div className="ib-pwait-held" data-thread-wait-held="">
          <HeldWrites entries={props.held.entries} machine={props.held.machine} onDismiss={props.held.onDismiss} />
        </div>
      )}
    </div>
  );
}
