/** An archived thread's foot: what became of it, and Unarchive. */
import type { InboxMovedTo } from '@plannotator/core/inbox-types';

export function ArchivedFoot({ movedTo, asker, onUnarchive }: { movedTo: InboxMovedTo | null | undefined; asker: string; onUnarchive: () => void }) {
  return (
    <div className="ib-acts">
      {/* An agent moved this thread's questions to another thread and archived it (resolve_message's moved_to). */}
      {movedTo ? (
        <span className="ib-st" data-moved-to={movedTo.thread_id}>
          Archived. Its questions moved to{' '}
          {/* Its name now while it is open (served `open`), else the subject it had when they moved, unlinked. */}
          {movedTo.open ? (
            <a className="ib-lnk" href={`#thread=${encodeURIComponent(movedTo.thread_id)}`}>
              {movedTo.name || movedTo.subject || 'another thread'}
            </a>
          ) : (
            movedTo.subject || 'another thread'
          )}
          .
        </span>
      ) : (
        <span className="ib-st">Archived. The next message from {asker} starts a new thread.</span>
      )}
      <button type="button" className="ib-btn" onClick={onUnarchive}>
        Unarchive
      </button>
    </div>
  );
}
