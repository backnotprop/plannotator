/**
 * A routine's lines in its thread (CONTRACT.md section 1), drawn from the messages alone so a thread that
 * lives on another linked machine reads the same: the run divider ("Run 8 · due 9:00 AM, ran 11:14 AM · 1 earlier
 * time missed", a click shows its prompt), the quieter skip line, "The run didn't start" under a run that never started (its
 * `failed`, no launch), and "Didn't finish" under a run that ended with no reply.
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
  // An agent's change line (`scheduled_change`) is a note between runs, not the run's reply.
  const replied = after.some((m) => m.author.kind === 'agent' && !m.scheduled_change);
  const latest = next < 0;
  const going = latest && !!run && (LIVE.has(run.state) || run.state === 'failed');
  return { replied, didntFinish: !replied && !going };
}

/** The thread header's start: "You started Claude Code in acme-api", or "Routine · Claude Code in acme-api". */
export const startedWords = (root: InboxMessageWire | undefined) => (root?.scheduled_run || root?.scheduled_change ? 'Routine · ' : 'You started ');

/** The fold over earlier runs: "6 earlier runs, Nov 2 to Nov 9", or null when it hides no run. */
export function earlierRunsLabel(ids: readonly string[], messages: readonly InboxMessageWire[]): string | null {
  const hidden = new Set(ids);
  const due = messages.filter((m) => hidden.has(m.id) && isRun(m)).map((m) => m.scheduled_run!.due_at);
  return due.length > 0 ? earlierRunsWords(due) : null;
}

/**
 * The thread's middle folds (planFolds) lined up with its runs: a fold that hides a run line starts at a run line and
 * ends just above one, so no reply shows under the wrong run. Only folded messages join a fold; an open one stays open.
 */
export function runFolds<P extends { folded: ReadonlySet<string>; hidden: string[][] }>(plan: P, messages: readonly InboxMessageWire[]): P {
  const line = (i: number) => messages[i]?.scheduled_run !== undefined;
  if (!messages.some((m) => m.scheduled_run !== undefined)) return plan;
  const folded = (i: number) => i >= 0 && i < messages.length && plan.folded.has(messages[i]!.id);
  const hidden = plan.hidden.map((ids) => {
    let s = messages.findIndex((m) => m.id === ids[0]);
    let e = messages.findIndex((m) => m.id === ids[ids.length - 1]);
    const lines = s < 0 || e < s ? [] : messages.map((_, i) => i).filter((i) => i >= s && i <= e && line(i));
    if (lines.length === 0) return ids;
    let b = s;
    while (!line(b) && folded(b - 1)) b--;
    s = line(b) ? b : lines[0]!;
    let a = e + 1;
    while (a < messages.length && !line(a) && folded(a)) a++;
    const lastLine = lines.at(-1)!;
    if (a === messages.length || line(a)) e = a - 1;
    else if (lastLine > s) e = lastLine - 1;
    else return ids;
    return messages.slice(s, e + 1).map((m) => m.id);
  });
  return { ...plan, hidden };
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
  const failed = scheduled.failed !== undefined;
  const ended = failed ? { replied: false, didntFinish: false } : runEnded(message, messages, run);
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
      {failed && (
        <p className="st-note st-unfinished" data-scheduled-didnt-start="">
          <span className="st-bad">The run didn't start.</span> {scheduled.failed}
        </p>
      )}
      {ended.didntFinish && (
        <p className="st-note st-unfinished" data-scheduled-unfinished="">
          <span className="st-bad">Didn't finish.</span> The session ended without a reply.
        </p>
      )}
      {!failed && tail}
    </div>
  );
}
