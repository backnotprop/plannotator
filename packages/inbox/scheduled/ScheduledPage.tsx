/**
 * The sidebar's Routines page (CONTRACT.md section 2): the table, and with one open, the narrow list beside
 * its editor. On a phone, or where the window stacks a list and a thread, the editor stands alone with a Back.
 */
import { useEffect, useState } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { SettingsModel } from '../api';
import type { Route } from '../app/route';
import { writeRoute } from '../app/writeRoute';
import type { InboxToastModel } from '../components/Toast';
import { errorText, errorToast } from '../toastError';
import { linkedMachineFacts, machineOf, selfMachineId } from '../inboxUrl';
import { lastLaunchAgent } from '../compose/model';
import { SidebarTrigger } from '../shell/sidebar';
import { InboxApiError } from '../apiError';
import { onRoutineHeld, runShown, scheduledApi } from './client';
import { useEditorKey } from './editorKey';
import { ScheduledEditor } from './ScheduledEditor';
import type { RoutineTab } from './RoutineTabs';
import { THIS_COMPUTER, type RoutineHome } from './RunsOn';
import { ScheduledTable, type RowActs } from './ScheduledTable';
import { farRoutinesOn, putScheduled, readScheduled, rowAway, useScheduledPage } from './store';
import { timeFrom } from './words';

export { useScheduledOn } from './store';

/** The capability switch: `loading` until the settings are read; `unsupported` where launch is not (Windows). */
export type ScheduledSwitch = 'on' | 'off' | 'loading' | 'unsupported';

type Toast = (toast: Omit<InboxToastModel, 'id'>) => void;

export interface ScheduledPageProps {
  /** The open one's id, `new` for a new one, or null for the table alone. */
  openId: string | null;
  switch: ScheduledSwitch;
  rows: readonly InboxListRow[];
  phone: boolean;
  /** The window shows one column at a time. */
  stacked: boolean;
  /** `replace`: a new one just made takes its own address in place of `new`. */
  onOpen: (id: string | null, replace?: boolean) => void;
  onOpenThread: (threadId: string, messageId?: string) => void;
  onSettings: (section: 'capabilities' | 'agents') => void;
  /** The window's one toast: a delete's Undo. */
  onToast?: Toast;
  /** The open one's tab (`&runs`) and its switch; absent: the editor keeps its own. */
  tab?: RoutineTab;
  onTab?: (tab: RoutineTab) => void;
}

/** The page at its address, from the window's settings and route. */
export function ScheduledRoute(props: { route: Route; settings: Pick<SettingsModel, 'scheduled_threads'> | null; rows: readonly InboxListRow[]; phone: boolean; stacked: boolean; onToast: Toast }) {
  const { settings } = props;
  const state = settings === null ? 'loading' : !settings.scheduled_threads ? 'unsupported' : settings.scheduled_threads.on ? 'on' : 'off';
  return (
    <ScheduledPage
      openId={props.route.scheduled ?? null}
      switch={state}
      rows={props.rows}
      phone={props.phone}
      stacked={props.stacked}
      // A new one taking its id keeps the tab it is on; another routine opens on Edit.
      onOpen={(id, replace) => writeRoute({ page: 'scheduled', project: null, thread: null, scheduled: id, routineRuns: (replace && props.route.routineRuns) || undefined }, { replace })}
      tab={props.route.routineRuns ? 'runs' : 'edit'}
      // A tab is not a step back: the address changes in place.
      onTab={(tab) => writeRoute({ page: 'scheduled', project: null, thread: null, scheduled: props.route.scheduled ?? null, routineRuns: tab === 'runs' || undefined }, { replace: true })}
      onOpenThread={(thread, msg) => writeRoute({ page: 'inbox', project: null, thread, msg: msg ?? null })}
      onSettings={(section) => writeRoute({ page: 'settings', project: null, thread: null, section })}
      onToast={props.onToast}
    />
  );
}

/** The list row's computer: null for this one. */
const computerOf = (row: InboxListRow) => (!row.machine || row.machine === selfMachineId() ? null : row.machine);

/** The folder New message last started an agent in on that computer (null: this one), if any. */
function lastProject(rows: readonly InboxListRow[], machine: string | null): string | null {
  let last: InboxListRow | null = null;
  for (const row of rows) if ('run' in row && computerOf(row) === machine && (!last || row.created_at > last.created_at)) last = row;
  return last?.project.id ?? null;
}

/** A linked computer by its name as the merged list says it. */
const homeOf = (machine: string | null): RoutineHome => (machine ? { id: machine, name: linkedMachineFacts(machine)?.name ?? 'another computer' } : { id: null, name: THIS_COMPUTER });

export function ScheduledPage(props: ScheduledPageProps) {
  const snap = useScheduledPage();
  const { openId } = props;
  const rows = snap.rows ?? [];
  // A write held for a linked computer that is away: the window's waiting toast ("Waiting for Studio: …").
  const toast = props.onToast;
  useEffect(() => {
    onRoutineHeld(toast ? (cause) => toast(errorToast(cause, '')) : null);
    return () => onRoutineHeld(null);
  }, [toast]);
  // Where a new one can be made: this computer while Routines are on here, then each linked one with them on there.
  const homes: RoutineHome[] = [...(props.switch === 'on' ? [homeOf(null)] : []), ...snap.computers.filter((c) => c.on).map((c) => homeOf(c.id))];
  const openRow = rows.find((row) => row.id === openId) ?? null;
  const openHome = openId === 'new' ? (homes[0] ?? homeOf(null)) : homeOf(openRow?.machine ?? machineOf(openId));
  const [actError, setActError] = useState<string | null>(null);
  const settle = (call: Promise<{ scheduled: InboxScheduledRow }>) => {
    setActError(null);
    return call.then(
      (answer) => putScheduled(answer.scheduled),
      (cause: Error) => {
        // A second Run press while the first starts is that run.
        if (!(cause instanceof InboxApiError && cause.code === 'routine_running')) setActError(cause.message);
        void readScheduled();
      },
    );
  };
  /** Delete, then the window's toast with Undo, which brings it back as it was. A failure throws, for its caller to say. */
  const remove = async (row: InboxScheduledRow): Promise<void> => {
    try {
      // Held for a computer that is away: it is deleted there when it is back, and the waiting toast said so.
      if (!(await scheduledApi.remove(row.id)).deleted) return;
    } catch (cause) {
      void readScheduled();
      throw new Error(`${row.name} was not deleted. ${errorText(cause, 'Try again.')}`);
    }
    putScheduled(null, row.id);
    if (openId === row.id) props.onOpen(null);
    const undo = () =>
      scheduledApi.restore(row.id).then(
        (answer) => putScheduled(answer.scheduled),
        (cause: unknown) => props.onToast?.({ icon: 'warn', wrap: true, lead: `${row.name} could not be brought back. ${errorText(cause, 'Try again.')}` }),
      );
    props.onToast?.({ icon: 'check', lead: 'Routine deleted', phoneLead: 'Deleted', detail: row.name, onUndo: () => void undo() });
  };
  const acts: RowActs = {
    computer: (row) => (row.machine ? (rowAway(snap, row) ? `${homeOf(row.machine).name} · away` : homeOf(row.machine).name) : null),
    away: (row) => rowAway(snap, row),
    open: (row) => props.onOpen(row.id),
    run: (row) => void settle(scheduledApi.run(row.id)),
    stop: (row) => void settle(scheduledApi.stop(row.id, runShown(row))),
    turn: (row, on) => void settle(scheduledApi.turn(row.id, on)),
    remove: (row) => {
      setActError(null);
      remove(row).catch((cause: Error) => setActError(cause.message));
    },
  };
  // Routines on here, or on a linked computer: the page lists and makes them either way.
  const on = props.switch === 'on' || farRoutinesOn(snap);
  const alone = props.phone || props.stacked;
  const editorKey = useEditorKey(openId);
  const editor = openId && (
    <ScheduledEditor
      key={editorKey.key}
      id={openId}
      row={openRow}
      version={snap.version}
      home={openHome}
      homes={homes}
      defaultsFor={(machine) => ({ agent: lastLaunchAgent(props.rows.filter((row) => computerOf(row) === machine)), projectId: lastProject(props.rows, machine) })}
      phone={props.phone}
      narrow={alone}
      onClose={() => props.onOpen(null)}
      onCreated={(id) => {
        editorKey.created(id);
        props.onOpen(id, true);
      }}
      onDelete={remove}
      onOpenThread={props.onOpenThread}
      tab={props.tab}
      onTab={props.onTab}
    />
  );
  if (openId && alone && on) return editor;
  const short = !!openId || props.phone;
  return (
    <>
      <section className={`ib-listcol st-list${openId ? ' st-list-split' : ''}`} aria-label="Routines" data-scheduled-page="">
        <div className="ib-lhead">
          <SidebarTrigger />
          <h1 tabIndex={-1}>Routines</h1>
          {on && (
            <button type="button" className="ib-btn st-new" aria-label="New routine" onClick={() => props.onOpen('new')} data-scheduled-new="">
              {props.phone ? 'New' : 'New routine'}
            </button>
          )}
        </div>
        <div className="ib-lbody st-lbody" aria-busy={props.switch === 'loading' || undefined}>
          {props.switch === 'loading' ? null : (
            <>
              {/* This computer's own: said above a linked computer's routines too, which list and run as ever. */}
              {props.switch === 'unsupported' ? (
                <p className="st-note" data-scheduled-off-note="">
                  Routines aren't available on Windows.
                </p>
              ) : props.switch === 'off' ? (
                <p className="st-note" data-scheduled-off-note="">
                  Routines are off on this computer.{' '}
                  <button type="button" className="st-link" onClick={() => props.onSettings('capabilities')}>
                    Turn them on in Settings
                  </button>
                </p>
              ) : null}
            </>
          )}
          {props.switch !== 'loading' && on && (
            <>
              {props.switch === 'on' && !snap.launchOn && (
                <p className="st-note" data-scheduled-launch-off="">
                  Starting agents is off, so nothing runs.{' '}
                  <button type="button" className="st-link" onClick={() => props.onSettings('agents')}>
                    Turn it on in Settings
                  </button>
                </p>
              )}
              {/* Each linked computer as the last read said it: away (its rows are as it last said), or not starting agents. */}
              {snap.computers.map((c) =>
                !c.on ? null : c.away ? (
                  <p key={c.id} className="st-note" data-scheduled-away={c.id}>
                    {c.read_at ? `${homeOf(c.id).name} has been away since ${timeFrom(c.read_at)}.` : `${homeOf(c.id).name} is away.`} Its routines are as it last said.
                  </p>
                ) : !c.launch_on ? (
                  <p key={c.id} className="st-note" data-scheduled-far-launch-off={c.id}>
                    Starting agents is off on {homeOf(c.id).name}, so nothing runs there.
                  </p>
                ) : null,
              )}
              {(actError ?? snap.error) && (
                <p className="ib-error" role="alert">
                  {actError ?? snap.error}
                </p>
              )}
              {snap.rows && rows.length === 0 && <p className="st-note">No routines yet.</p>}
              <ScheduledTable rows={rows} acts={acts} short={short} selected={openId} />
            </>
          )}
        </div>
      </section>
      {on && editor}
    </>
  );
}
