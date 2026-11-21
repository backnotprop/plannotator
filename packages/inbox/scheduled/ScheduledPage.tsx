/**
 * The sidebar's Routines page (CONTRACT.md section 2): the table, and with one open, the narrow list beside
 * its editor. On a phone, or where the window stacks a list and a thread, the editor stands alone with a Back.
 */
import { useState } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { SettingsModel } from '../api';
import type { Route } from '../app/route';
import { writeRoute } from '../app/writeRoute';
import type { InboxToastModel } from '../components/Toast';
import { errorText } from '../toastError';
import { selfMachineId } from '../inboxUrl';
import { lastLaunchAgent } from '../compose/model';
import { SidebarTrigger } from '../shell/sidebar';
import { InboxApiError } from '../apiError';
import { scheduledApi } from './client';
import { useLaunchBlock } from './EditorParts';
import { useEditorKey } from './editorKey';
import { ScheduledEditor } from './ScheduledEditor';
import type { RoutineTab } from './RoutineTabs';
import { ScheduledTable, type RowActs } from './ScheduledTable';
import { putScheduled, readScheduled, useScheduledPage } from './store';

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

const local = (row: InboxListRow) => !row.machine || row.machine === selfMachineId();

/** The folder New message last started an agent in on this computer, if any. */
function lastProject(rows: readonly InboxListRow[]): string | null {
  let last: InboxListRow | null = null;
  for (const row of rows) if ('run' in row && local(row) && (!last || row.created_at > last.created_at)) last = row;
  return last?.project.id ?? null;
}

export function ScheduledPage(props: ScheduledPageProps) {
  const snap = useScheduledPage();
  const block = useLaunchBlock();
  const { openId } = props;
  const rows = snap.rows ?? [];
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
      await scheduledApi.remove(row.id);
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
    open: (row) => props.onOpen(row.id),
    run: (row) => void settle(scheduledApi.run(row.id)),
    stop: (row) => void settle(scheduledApi.stop(row.id)),
    turn: (row, on) => void settle(scheduledApi.turn(row.id, on)),
    remove: (row) => {
      setActError(null);
      remove(row).catch((cause: Error) => setActError(cause.message));
    },
  };
  const on = props.switch === 'on';
  const alone = props.phone || props.stacked;
  const editorKey = useEditorKey(openId);
  const editor = openId && (
    <ScheduledEditor
      key={editorKey.key}
      id={openId}
      row={rows.find((row) => row.id === openId) ?? null}
      version={snap.version}
      block={block}
      defaults={{ agent: lastLaunchAgent(props.rows), projectId: lastProject(props.rows) }}
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
          {props.switch === 'loading' ? null : props.switch === 'unsupported' ? (
            <p className="st-note" data-scheduled-off-note="">
              Routines aren't available on Windows.
            </p>
          ) : !on ? (
            <p className="st-note" data-scheduled-off-note="">
              Routines are off on this computer.{' '}
              <button type="button" className="st-link" onClick={() => props.onSettings('capabilities')}>
                Turn them on in Settings
              </button>
            </p>
          ) : (
            <>
              {!snap.launchOn && (
                <p className="st-note" data-scheduled-launch-off="">
                  Starting agents is off, so nothing runs.{' '}
                  <button type="button" className="st-link" onClick={() => props.onSettings('agents')}>
                    Turn it on in Settings
                  </button>
                </p>
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
