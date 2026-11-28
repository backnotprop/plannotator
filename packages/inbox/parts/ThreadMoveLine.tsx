/**
 * One line in a thread's run of messages that says who the thread is with now (thread/threadMoves.ts): "You handed
 * this thread to [mark] Pi · 4:20 PM · Undo", "You added [mark] Pi to this thread · 4:20 PM" (approval
 * "inbox-tag-handoff"), and "You removed [mark] webhooks from this thread · 3:04 PM" (approval
 * "inbox-remove-agent-from-thread"). In a thread of several agents an add and a removal take the quiet form: no icon
 * and no mark ("You added Retry worker · 4:20 PM", the header's names).
 */
import { HostMark, Icon } from '../icons';
import type { ThreadMove } from '../thread/threadMoves';

export function ThreadMoveLine({
  move,
  time,
  quiet,
  held,
  undo,
}: {
  move: ThreadMove;
  /** The line's time, as the thread shows times. */
  time: string;
  /** A thread of several agents: an add or a removal without icon or mark. */
  quiet: boolean;
  /** A hand-off still inside its Undo window. */
  held?: boolean;
  /** A held hand-off's Undo: busy while it goes, and why it failed. */
  undo?: { busy: boolean; error: string | null; onUndo: () => void } | null;
}) {
  const plain = quiet && move.kind !== 'handoff';
  return (
    <div className="ib-tmove" data-thread-move={move.kind} data-held={held ? '' : undefined} data-quiet={plain ? '' : undefined}>
      {!plain && <Icon name={move.kind === 'handoff' ? 'forward' : move.kind === 'removed' ? 'minus' : 'plus'} size={14} />}
      <span className="ib-tmove-t">
        {move.kind === 'handoff' ? 'You handed this thread to ' : move.kind === 'removed' ? 'You removed ' : 'You added '}
        {!plain && <HostMark host={move.host} />}
        <b>{move.names}</b>
        {move.kind === 'removed' ? ' from this thread' : move.kind === 'added' && !plain ? ' to this thread' : ''}
        <span className="ib-tmove-tm"> · {time}</span>
      </span>
      {held && undo && (
        <>
          <span className="ib-tmove-sep" aria-hidden="true">
            ·
          </span>
          <button type="button" className="ib-tmove-undo" data-handoff-undo="" disabled={undo.busy} onClick={undo.onUndo}>
            Undo
          </button>
        </>
      )}
      {undo?.error && (
        <span className="ib-error" role="alert">
          {undo.error}
        </span>
      )}
    </div>
  );
}
