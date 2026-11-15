/**
 * A scheduled thread's lines in its thread (CONTRACT.md section 1), drawn from the messages alone so a thread that
 * lives on another linked machine reads the same: the run divider ("Run 8 · due 9:00 AM, ran 11:14 AM · 1 earlier
 * time missed", a click shows its prompt), the quieter skip line, and "Didn't finish" under a run that ended with no
 * reply.
 */
import { useState, type ReactNode } from 'react';
import type { InboxMessageWire, InboxRun } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { dividerWords, earlierRunsWords, skipWords } from './words';

/** A run line that has not ended yet: no "Didn't finish" under it. */
const LIVE = new Set<InboxRun['state']>(['starting', 'working', 'cloning', 'waiting_answer', 'waiting_terminal']);

const isRun = (m: InboxMessageWire) => m.scheduled_run !== undefined && m.scheduled_run.run !== undefined;

/** How the run this divider opens went, from the messages after it (up to the next run) and the thread's run line. */
export function runEnded(message: InboxMessageWire, messages: readonly InboxMessageWire[], run: InboxRun | null | undefined): { replied: boolean; didntFinish: boolean } {
  const at = messages.indexOf(message);
  const next = messages.findIndex((m, i) => i > at && isRun(m));
  const after = messages.slice(at + 1, next < 0 ? undefined : next);
  const replied = after.some((m) => m.author.kind === 'agent');
  const latest = next < 0;
  const going = latest && !!run && (LIVE.has(run.state) || run.state === 'failed');
  return { replied, didntFinish: !replied && !going };
}

/** The fold over earlier runs: "6 earlier runs, Nov 2 to Nov 9", or null when it hides no run. */
export function earlierRunsLabel(ids: readonly string[], messages: readonly InboxMessageWire[]): string | null {
  const hidden = new Set(ids);
  const due = messages.filter((m) => hidden.has(m.id) && isRun(m)).map((m) => m.scheduled_run!.due_at);
  return due.length > 0 ? earlierRunsWords(due) : null;
}

export function RunDivider({ message, messages, run, tail }: { message: InboxMessageWire; messages: readonly InboxMessageWire[]; run: InboxRun | null | undefined; tail?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const scheduled = message.scheduled_run!;
  if (scheduled.run === undefined) {
    const words = skipWords(scheduled);
    return (
      <div className="st-line st-skip" role="separator" aria-label={words.replace(/ · /g, ', ')} data-scheduled-skip="" data-message-id={message.id}>
        <span>{words}</span>
      </div>
    );
  }
  const ended = runEnded(message, messages, run);
  const words = dividerWords(scheduled, message.created_at, !ended.replied);
  const promptId = `st-prompt-${message.id}`;
  return (
    <div className="st-run-at" data-scheduled-divider={scheduled.run} data-late={scheduled.late ? '' : undefined} data-message-id={message.id}>
      <button type="button" className="st-line" aria-expanded={open} aria-controls={open ? promptId : undefined} aria-label={`${words.replace(/ · /g, ', ')}. ${open ? 'Hide' : 'Show'} the prompt`} onClick={() => setOpen((was) => !was)}>
        <Icon name="scheduled" size={14} />
        <span>{words}</span>
      </button>
      {open && (
        <div className="st-prompt-shown" id={promptId} dir="auto">
          {message.body}
        </div>
      )}
      {ended.didntFinish && (
        <p className="st-note st-unfinished" data-scheduled-unfinished="">
          <span className="st-bad">Didn't finish.</span> The session ended without a reply.
        </p>
      )}
      {tail}
    </div>
  );
}
