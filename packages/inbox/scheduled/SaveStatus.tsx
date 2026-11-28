/**
 * The routine editor's quiet save status in its header: "Not saved yet", "Saving…", "Saved", "Couldn't save ·
 * retrying" (approval "inbox-routine-editor-autosave"), and for a saved one whose name or prompt was emptied, which one
 * it needs. The words shown are not a live region (a screen reader would hear every keystroke's save); a polite one
 * beside them says only a failure or what is missing.
 */
import { Icon } from '../icons';
import type { SaveStatus as Status } from './useAutosave';

export const STATUS_WORDS: Record<Exclude<Status['kind'], 'needs'>, string> = {
  new: 'Not saved yet',
  /** An on routine's typed name or prompt: saved when the field is left. */
  held: 'Not saved yet',
  saving: 'Saving…',
  saved: 'Saved',
  failed: "Couldn't save · retrying",
  refused: "Couldn't save",
};

export const statusWords = (status: Status): string => (status.kind === 'needs' ? `Not saved · needs a ${status.field}` : STATUS_WORDS[status.kind]);

/** What the live region says: a failure, or what is missing; nothing for the ordinary saves. A refusal's reason is the
 * editor's alert line, so it is not said twice. */
const spoken = (status: Status): string =>
  status.kind === 'failed' ? "Couldn't save the routine. Trying again." : status.kind === 'needs' ? `Not saved: the routine needs a ${status.field}.` : '';

export function SaveStatus({ status }: { status: Status }) {
  const bad = status.kind === 'failed' || status.kind === 'refused';
  return (
    <>
      <span className="st-saved" data-scheduled-status={status.kind} data-bad={bad ? '' : undefined}>
        {status.kind === 'saved' && <Icon name="check" size={13} />}
        {bad && <Icon name="excl" size={13} />}
        {statusWords(status)}
      </span>
      <span className="sr-only" role="status" aria-live="polite" data-scheduled-status-said="">
        {spoken(status)}
      </span>
    </>
  );
}
