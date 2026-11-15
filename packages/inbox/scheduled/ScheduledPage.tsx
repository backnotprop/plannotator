/**
 * The sidebar's Scheduled threads page (CONTRACT.md section 2): the table, and with one open, the narrow list beside
 * its editor. On a phone, or where the window stacks a list and a thread, the editor stands alone with a Back.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { selfMachineId } from '../inboxUrl';
import { lastLaunchAgent } from '../compose/model';
import { SidebarTrigger } from '../shell/sidebar';
import { scheduledApi } from './client';
import { useLaunchBlock } from './EditorParts';
import { ScheduledEditor } from './ScheduledEditor';
import { ScheduledTable, type RowActs } from './ScheduledTable';
import { putScheduled, readScheduled, useScheduledPage } from './store';

export { useScheduledOn } from './store';

export interface ScheduledPageProps {
  /** The open one's id, `new` for a new one, or null for the table alone. */
  openId: string | null;
  /** The capability switch. */
  on: boolean;
  rows: readonly InboxListRow[];
  phone: boolean;
  /** The window shows one column at a time. */
  stacked: boolean;
  /** `replace`: a new one just made takes its own address in place of `new`. */
  onOpen: (id: string | null, replace?: boolean) => void;
  onOpenThread: (threadId: string, messageId?: string) => void;
  onSettings: (section: 'capabilities' | 'agents') => void;
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
  const settle = (call: Promise<{ scheduled: InboxScheduledRow }>) =>
    call.then(
      (answer) => putScheduled(answer.scheduled),
      () => void readScheduled(),
    );
  const acts: RowActs = {
    open: (row) => props.onOpen(row.id),
    run: (row) => void settle(scheduledApi.run(row.id)),
    stop: (row) => void settle(scheduledApi.stop(row.id)),
    turn: (row, on) => void settle(scheduledApi.turn(row.id, on)),
    remove: (row) =>
      void scheduledApi.remove(row.id).then(() => {
        putScheduled(null, row.id);
        if (openId === row.id) props.onOpen(null);
      }, () => void readScheduled()),
  };
  const alone = props.phone || props.stacked;
  const titleOf = (threadId: string) => {
    const row = props.rows.find((r) => r.thread_id === threadId);
    return row ? (row.thread_name ?? row.subject) : null;
  };
  const editor = openId && (
    <ScheduledEditor
      key={openId}
      id={openId}
      row={rows.find((row) => row.id === openId) ?? null}
      version={snap.version}
      block={block}
      defaults={{ agent: lastLaunchAgent(props.rows), projectId: lastProject(props.rows) }}
      phone={props.phone}
      narrow={alone}
      threadTitle={titleOf}
      onClose={() => props.onOpen(null)}
      onCreated={(id) => props.onOpen(id, true)}
      onOpenThread={props.onOpenThread}
    />
  );
  if (openId && alone && props.on) return editor;
  const short = !!openId || props.phone;
  return (
    <>
      <section className={`ib-listcol st-list${openId ? ' st-list-split' : ''}`} aria-label="Scheduled threads" data-scheduled-page="">
        <div className="ib-lhead">
          <SidebarTrigger />
          <h1 tabIndex={-1}>Scheduled threads</h1>
          {props.on && (
            <button type="button" className="ib-btn st-new" aria-label="New scheduled thread" onClick={() => props.onOpen('new')} data-scheduled-new="">
              {props.phone ? 'New' : 'New scheduled thread'}
            </button>
          )}
        </div>
        <div className="ib-lbody st-lbody">
          {!props.on ? (
            <p className="st-note" data-scheduled-off-note="">
              Scheduled threads are off on this computer.{' '}
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
              {snap.error && (
                <p className="ib-error" role="alert">
                  {snap.error}
                </p>
              )}
              {snap.rows && rows.length === 0 && <p className="st-note">No scheduled threads yet.</p>}
              <ScheduledTable rows={rows} acts={acts} short={short} selected={openId} />
            </>
          )}
        </div>
      </section>
      {props.on && editor}
    </>
  );
}
