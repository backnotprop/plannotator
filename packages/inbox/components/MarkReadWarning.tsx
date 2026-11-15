/**
 * The warning before a Mark read that sets questions aside (the owner's ask, 2026-11-10: "warn the user if it will
 * close out questions with a set-aside message to the agent, and ask if they want to continue. Option to never show
 * the warning again."). Shown only when the Mark read (single, or the project menu's Mark all as read) would close
 * open questions or action items; markRead.ts `confirmSetAside` decides. The Inbox's own modal (`Modal`, Updates.tsx):
 * focus starts on the Mark read button, Enter goes on (from the checkbox too), Escape and Cancel change nothing. No
 * new key. "Don't show this again" turns the warning off for this person (config.json `inboxMarkReadWarning`), and
 * Settings → General → When an agent asks you turns it back on.
 */
import { useId, useState } from 'react';
import { setAsideWarning, type SetAsideAnswer, type SetAsideCount } from '../markRead';
import { Modal } from './Updates';

export interface MarkReadWarningProps {
  count: SetAsideCount;
  /** Mark all as read on a project, not one thread. */
  bulk: boolean;
  onAnswer: (answer: SetAsideAnswer) => void;
}

export function MarkReadWarning({ count, bulk, onAnswer }: MarkReadWarningProps) {
  const id = useId();
  const [never, setNever] = useState(false);
  const words = setAsideWarning(count, bulk);
  const go = () => onAnswer({ go: true, never });
  return (
    <Modal labelledBy={`${id}-t`} describedBy={`${id}-d`} onClose={() => onAnswer({ go: false })} testId="mark-read-warning" ownKeys className="ib-readwarn">
      <div
        onKeyDown={(event) => {
          // Enter on the checkbox goes on too (a button takes its own Enter).
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
          if ((event.target as HTMLElement).closest('button')) return;
          event.preventDefault();
          go();
        }}
      >
        <h2 id={`${id}-t`}>{words.title}</h2>
        <p className="ib-sum" id={`${id}-d`}>
          {words.body}
        </p>
        <label className="ib-opt ib-readwarn-never" data-mark-read-warning-never="">
          <input type="checkbox" checked={never} onChange={(event) => setNever(event.target.checked)} />
          <span>
            Don&apos;t show this again
            <small>You can turn it back on in Settings.</small>
          </span>
        </label>
        <div className="ib-acts-row">
          <button type="button" className="ib-btn" onClick={() => onAnswer({ go: false })} data-mark-read-warning-cancel="">
            Cancel
          </button>
          <button type="button" className="ib-btn ib-pri" onClick={go} data-mark-read-warning-go="">
            {words.go}
          </button>
        </div>
      </div>
    </Modal>
  );
}
