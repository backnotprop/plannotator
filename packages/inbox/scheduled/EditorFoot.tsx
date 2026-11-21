/**
 * The routine editor's foot (approval "inbox-routine-editor-autosave"): the next step. While a routine is off the
 * filled button is Turn on, with "Off, so it won't run on its own."; once on it says when it runs next and has no
 * filled button. Run once now is a quiet button beside it (a real run, as the list row's Run), Stop while a run goes.
 * A new one that cannot be made yet says it saves by itself once it has a name and a prompt, Turn on dimmed.
 */
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { Icon } from '../icons';
import { footNextWords } from './words';

/** On: the clock runs it. A one-off run of an off routine (Run once now) leaves it off. The editor's one rule. */
export const routineOn = (record: InboxScheduledRow | null): boolean => !!record && record.state !== 'done' && (record.state === 'on' || (record.state === 'running' && record.enabled));

export function EditorFoot({ record, ready, onTurnOn, onRun, onStop }: { record: InboxScheduledRow | null; ready: boolean; onTurnOn: () => void; onRun: () => void; onStop: () => void }) {
  const state = record?.state ?? null;
  const on = routineOn(record);
  const line = !record ? (
    ready ? (
      "Off, so it won't run on its own."
    ) : (
      'Saves by itself once it has a name and a prompt.'
    )
  ) : state === 'done' ? null : on ? (
    record.next_run ? (
      <>
        On · next run <b>{footNextWords(record.next_run)}</b>
      </>
    ) : (
      'On'
    )
  ) : (
    "Off, so it won't run on its own."
  );
  return (
    <div className="ib-pfoot st-pfoot">
      <span className="st-footline" data-scheduled-foot-line="">
        {line}
      </span>
      {state === 'running' ? (
        <button type="button" className="ib-btn" onClick={onStop} data-scheduled-stop="">
          Stop
        </button>
      ) : (
        record && (
          <button type="button" className="ib-btn st-once" onClick={onRun} data-scheduled-run-now="">
            <Icon name="play" size={12} />
            Run once now
          </button>
        )
      )}
      {!on && state !== 'done' && (
        <button type="button" className="ib-btn ib-pri" disabled={!record && !ready} onClick={onTurnOn} data-scheduled-turn-on="">
          Turn on
        </button>
      )}
    </div>
  );
}
