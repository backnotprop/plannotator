/**
 * A routine's two tabs under its name: Edit (what it runs and when) and Runs (each run, newest first). The tabs are
 * the Inbox's segmented control as a tab list (Feedback's and Settings → Appearance's: automatic activation, the
 * arrows, Home and End move the pick and focus with it). The Runs tab is in the address (`#routine=sch_…&runs`), so a
 * reload or a shared link lands on it. Its label says when a run is going (the page's running mark) or the last one
 * didn't start or didn't finish (a red dot). On Edit, one line beside the tabs says how the last run went, and opens
 * Runs.
 */
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { InboxScheduledRow, InboxScheduledRunSummary } from '@plannotator/core/inbox-scheduled-types';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { routineOn } from './EditorFoot';
import { RunningDots } from './marks';
import { elapsedWords, footNextWords, OUTCOME_WORDS, runWhenWords } from './words';

export type RoutineTab = 'edit' | 'runs';
const TABS: { id: RoutineTab; label: string }[] = [
  { id: 'edit', label: 'Edit' },
  { id: 'runs', label: 'Runs' },
];

const bad = (outcome: InboxScheduledRunSummary['outcome']) => outcome === 'didnt_start' || outcome === 'didnt_finish';
const running = (record: InboxScheduledRow | null) => record?.state === 'running' && !!record.running_since;
/** The last run ended badly and none is going now. */
export const lastRunFailed = (record: InboxScheduledRow | null) => !running(record) && !!record?.last_run && bad(record.last_run.outcome);

/** Ticks each second while a run goes, for its time so far. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export const tabIdOf = (uid: string, tab: RoutineTab) => `st-tab-${tab}-${uid}`;
export const panelIdOf = (uid: string, tab: RoutineTab) => `st-panel-${tab}-${uid}`;

export function RoutineTabs({ uid, tab, onTab, record }: { uid: string; tab: RoutineTab; onTab: (tab: RoutineTab) => void; record: InboxScheduledRow | null }) {
  const go = (next: RoutineTab) => {
    onTab(next);
    document.getElementById(tabIdOf(uid, next))?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    // Cmd+← and Alt+← are the browser's Back: not a tab switch.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const index = TABS.findIndex((choice) => choice.id === tab);
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (index - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    go(TABS[next]!.id);
  };
  const live = running(record);
  const failed = lastRunFailed(record);
  return (
    // The row is a container: the pane's width, not the window's, puts the line beside the tabs or under them.
    <div className="st-tabsrow">
      <div className="st-tabsin">
        <div className="ib-seg st-tabs" role="tablist" aria-label="Routine" onKeyDown={onKey} data-scheduled-tabs="">
          {TABS.map((choice) => {
            const on = tab === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="tab"
                id={tabIdOf(uid, choice.id)}
                className="ib-seg-o"
                data-on={on ? '' : undefined}
                data-scheduled-tab={choice.id}
                aria-selected={on}
                aria-controls={panelIdOf(uid, choice.id)}
                tabIndex={on ? 0 : -1}
                onClick={() => onTab(choice.id)}
              >
                {choice.label}
                {/* Heard as "Runs, 12", not "Runs12". */}
                {choice.id === 'runs' && !!record?.runs && (
                  <>
                    <span className="ib-sr">, </span>
                    <span className="ib-n">{formatCount(record.runs)}</span>
                  </>
                )}
                {choice.id === 'runs' && live && <RunningDots />}
                {choice.id === 'runs' && failed && <span className="st-tabdot" aria-hidden="true" data-scheduled-runs-failed="" />}
                {choice.id === 'runs' && (live || failed) && <span className="ib-sr">{live ? ', a run is going' : `, the last run ${OUTCOME_WORDS[record!.last_run!.outcome].toLowerCase()}`}</span>}
              </button>
            );
          })}
        </div>
        {/* Off Edit (`data-off`): beside the tabs it keeps its place unseen; under them it takes no space. */}
        <LastRun record={record} shown={tab === 'edit'} onRuns={() => go('runs')} />
      </div>
    </div>
  );
}

/** "Last run Today 9:00 AM · Replied", "Running · 0:42", or the one that didn't start or finish in red. Opens Runs. */
function LastRun({ record, shown, onRuns }: { record: InboxScheduledRow | null; shown: boolean; onRuns: () => void }) {
  const live = running(record);
  const now = useNow(live);
  if (!record) return null;
  let words: ReactNode;
  // The running mark is on the Runs tab beside it: the words alone here.
  if (live) words = <span>Running · {elapsedWords(record.running_since!, now)}</span>;
  else if (record.last_run)
    words = (
      <span>
        Last run {runWhenWords(record.last_run.started_at)} · <span className={bad(record.last_run.outcome) ? 'st-bad' : undefined}>{OUTCOME_WORDS[record.last_run.outcome]}</span>
      </span>
    );
  else return null;
  return (
    // Off Edit: out of the Tab order and unheard; the CSS hides it (scheduled.css `.st-lastrun[data-off]`).
    <button type="button" className="st-lastrun" onClick={onRuns} data-off={shown ? undefined : ''} aria-hidden={!shown || undefined} tabIndex={shown ? undefined : -1} data-scheduled-last-run={live ? 'running' : record.last_run!.outcome}>
      {words}
      <Icon name="chevR" size={12} />
    </button>
  );
}

/** The Runs tab: each run the Inbox answered (the newest 20), each opening the thread at its run, or none yet. */
export function RunsPanel({ record, runs, loaded, onOpenThread }: { record: InboxScheduledRow | null; runs: readonly InboxScheduledRunSummary[]; loaded: boolean; onOpenThread: (threadId: string, messageId?: string) => void }) {
  if (!record || record.runs === 0)
    return (
      <div className="st-norun" data-scheduled-no-runs="">
        <p>No runs yet.</p>
        <p className="st-mut">{record && routineOn(record) && record.next_run ? `The first run is ${footNextWords(record.next_run)}.` : 'It runs on its schedule once it is on, or when you run it once now.'}</p>
      </div>
    );
  // Read with the routine: until then nothing, not an empty list.
  if (!loaded) return null;
  const thread = record.thread_id;
  return (
    <>
      <div className="st-runs" data-scheduled-runs="">
        {runs.map((run) => (
          <button key={run.message_id} type="button" className="st-runrow" onClick={() => thread && onOpenThread(thread, run.message_id)} data-run-outcome={run.outcome}>
            <b>Run {run.run}</b>
            <span className={bad(run.outcome) ? 'st-bad' : run.outcome === 'running' ? undefined : 'st-mut'}>{OUTCOME_WORDS[run.outcome]}</span>
            <span className="st-mut">{runWhenWords(run.started_at)}</span>
            <Icon name="chevR" size={12} />
          </button>
        ))}
      </div>
      {thread && (
        <button type="button" className="st-all" onClick={() => onOpenThread(thread)}>
          {record.runs > runs.length ? `All ${formatCount(record.runs)} in the thread` : 'Open the thread'}
        </button>
      )}
    </>
  );
}
