/**
 * A scheduled thread's row in the Inbox list: the scheduled thread is the sender (the play mark in the agent tile, its
 * name where the project sits), the run is the subject ("Run 9"). A running run shows the Running pill with the dots;
 * only a run that didn't finish (or didn't start) gets the warn mark.
 *
 * The list row carries nothing that says a thread is a scheduled thread's, so this reads this computer's own list and
 * matches by thread. A row from another linked machine stays an ordinary row (UI-NEEDS.md names the row field that
 * would let it look the same).
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { Icon } from '../icons';
import { selfMachineId } from '../inboxUrl';
import { RunningDots } from './marks';

export interface RowScheduled {
  name: string;
  run: number | null;
  state: 'running' | 'failed' | 'didnt_start' | 'other';
}

const marks = new WeakMap<InboxListRow, RowScheduled>();
const looks = new WeakMap<InboxListRow, { from: InboxScheduledRow; look: InboxListRow }>();
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** The row as the list draws it: unchanged unless it is one of this computer's scheduled threads. */
export function scheduledLook(row: InboxListRow, scheduled: readonly InboxScheduledRow[] | null): InboxListRow {
  if (!scheduled || scheduled.length === 0 || (row.machine && row.machine !== selfMachineId())) return row;
  const from = scheduled.find((s) => s.thread_id === row.thread_id);
  if (!from) return row;
  const had = looks.get(row);
  if (had?.from === from) return had.look;
  const last = from.last_run;
  const running = from.state === 'running';
  const failed = !running && (last?.outcome === 'didnt_finish' || last?.outcome === 'didnt_start');
  const run = last?.run ?? null;
  const preview = running && from.running_since ? `Started at ${TIME.format(new Date(from.running_since))}.` : last?.outcome === 'didnt_start' ? "Didn't start." : failed ? 'The session ended without a reply.' : row.latest_preview;
  const look: InboxListRow = { ...row, thread_name: run ? `Run ${run}` : row.thread_name, latest_preview: preview, run: undefined, session_ended: undefined };
  marks.set(look, { name: from.name, run, state: running ? 'running' : last?.outcome === 'didnt_start' ? 'didnt_start' : failed ? 'failed' : 'other' });
  looks.set(row, { from, look });
  return look;
}

export const scheduledOf = (row: InboxListRow): RowScheduled | undefined => marks.get(row);

/** The sender's tile: the play mark in place of the agents' marks. */
export function ScheduledTile() {
  return (
    <span className="st-tile" role="img" aria-label="Scheduled thread" data-scheduled-tile="">
      <Icon name="scheduled" size={12} />
    </span>
  );
}

/** Running, with the dots; the warn mark for a run that didn't finish or didn't start; nothing else. */
export function ScheduledBadge({ row }: { row: InboxListRow }) {
  const s = marks.get(row);
  if (!s || s.state === 'other') return null;
  const run = s.run ? `Run ${s.run}` : s.name;
  if (s.state === 'running')
    return (
      <span className="ib-badge ib-bicon ib-b-act st-pill" role="status" aria-label={`${run} running`} data-scheduled-badge="running">
        <RunningDots />
        <span>Running</span>
      </span>
    );
  const words = `${run} ${s.state === 'didnt_start' ? "didn't start" : "didn't finish"}`;
  return (
    <span className="ib-badge ib-bicon ib-b-stop st-warn" aria-label={words} title={words} data-scheduled-badge="failed">
      <Icon name="warn" size={14} />
    </span>
  );
}
export { useScheduled } from './store';
