/**
 * One routine beside the list (CONTRACT.md section 2). It saves by itself and says so (useAutosave.ts, SaveStatus.tsx):
 * typing after a pause, a field when it is left, a pick at once, a schedule once the preview takes it, and what waits
 * as the page goes. A new one starts off, and is made once it has a name and a prompt; until then the tab keeps it.
 * Under its name, two tabs (RoutineTabs.tsx): Edit and Runs. Both panels stay mounted, so a switch keeps every word.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { usePhone } from '../phone';
import { INBOX_HOST_NAMES } from '@plannotator/core/inbox-types';
import type { InboxScheduledPreview, InboxScheduledRow, InboxScheduledRunSummary, InboxScheduledSchedule } from '@plannotator/core/inbox-scheduled-types';
import { Icon } from '../icons';
import { Switch } from '../components/SoundRow';
import { Tip } from '../components/Tip';
import { scheduledApi } from './client';
import { InboxApiError } from '../apiError';
import { putScheduled, readScheduled } from './store';
import { FilesRow, FolderPick, RunsAs, type LaunchBlock } from './EditorParts';
import { EditorFoot, routineOn } from './EditorFoot';
import { SaveStatus } from './SaveStatus';
import { localZone, ScheduleRow } from './ScheduleRow';
import { useAutosave } from './useAutosave';
import { panelIdOf, RoutineTabs, RunsPanel, tabIdOf, type RoutineTab } from './RoutineTabs';

export interface EditorProps {
  id: string;
  row: InboxScheduledRow | null;
  version: number;
  block: LaunchBlock | null;
  defaults: { agent: string | null; projectId: string | null };
  phone: boolean;
  narrow: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  /** Delete with the window's Undo; a failure rejects with what to say. */
  onDelete: (row: InboxScheduledRow) => Promise<void>;
  onOpenThread: (threadId: string, messageId?: string) => void;
  /** The tab shown (the address's `&runs`); absent: the editor keeps its own, starting on Edit. */
  tab?: RoutineTab;
  onTab?: (tab: RoutineTab) => void;
}

/** A one-time one after its time: "Done" (the line by the tabs says when it ran and how), or that it didn't run (skipped). */
const doneWords = (record: InboxScheduledRow): string => (record.last_run ? 'Done' : "Done · didn't run");

function MoreMenu({ on, onTurn, onRun, onDelete }: { on: boolean | null; onTurn: () => void; onRun: (() => void) | null; onDelete: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  // On a phone, main's bottom sheet (inbox.css `.ib-pm-pos[data-phone]`): it fits the screen and scrolls.
  const sheet = usePhone();
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(anchor.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger ref={anchor} className="ib-iconbtn" aria-label="More">
        <Icon name="dots" />
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        {sheet && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={sheet ? '' : undefined}>
          <Menu.Popup className="ib-pm" aria-label="Routine">
            {on !== null && (
              <Menu.Item className="ib-pmi" onClick={onTurn}>
                <span className="ib-pmi-l">{on ? 'Turn off' : 'Turn on'}</span>
              </Menu.Item>
            )}
            {onRun && (
              <Menu.Item className="ib-pmi" onClick={onRun} data-scheduled-menu-run="">
                <span className="ib-pmi-l">Run once now</span>
              </Menu.Item>
            )}
            <Menu.Item className="ib-pmi" onClick={onDelete}>
              <span className="ib-pmi-l">Delete</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function ScheduledEditor(props: EditorProps) {
  const { id, row, version, block } = props;
  const isNew = id === 'new';
  const [detail, setDetail] = useState<{ scheduled: InboxScheduledRow; runs: InboxScheduledRunSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (isNew) return;
    let live = true;
    scheduledApi.read(id).then(
      (answer) => live && setDetail(answer),
      (cause: Error) => live && setError(cause.message),
    );
    return () => {
      live = false;
    };
  }, [id, version]);
  const record = detail?.scheduled.id === id && (!row || detail.scheduled.updated_at >= row.updated_at) ? detail.scheduled : row;
  const firstAgent = props.defaults.agent ?? block?.launch?.agents[0]?.agent ?? 'claude-code';
  // The preview's word on each schedule: one it refused, or has not answered, is not saved yet.
  const verdicts = useRef(new Map<string, boolean>());
  const firstSchedule = useRef<string | null>(null);
  const autosave = useAutosave({
    id,
    record,
    fresh: () => ({ name: '', prompt: '', schedule: { cron: '0 9 * * *', tz: localZone() }, if_missed: 'run_once', folder: props.defaults.projectId ? { project_id: props.defaults.projectId } : { scratch: true }, agent: firstAgent, attachments: [] }),
    held: (key, fields) => {
      if (key !== 'schedule') return false;
      const shown = JSON.stringify(fields.schedule);
      return verdicts.current.get(shown) === false || (!verdicts.current.has(shown) && shown !== firstSchedule.current);
    },
    holdTyping: routineOn(record),
    onCreated: props.onCreated,
  });
  const { draft } = autosave;
  firstSchedule.current ??= JSON.stringify(draft.schedule);

  const [preview, setPreview] = useState<InboxScheduledPreview | null>(null);
  const asked = useRef(0);
  const previewed = useRef<string | null>(null);
  const checkSchedule = async (schedule: InboxScheduledSchedule): Promise<boolean> => {
    const n = ++asked.current;
    const shown = (previewed.current = JSON.stringify(schedule));
    const answer = await scheduledApi.preview(schedule).catch(() => null);
    // No answer: the server says on save.
    verdicts.current.set(shown, answer?.ok !== false);
    if (n !== asked.current) return false;
    setPreview(answer);
    return answer?.ok === true;
  };
  // The schedule shown, however it came (opened, read in after a link, changed elsewhere): its next run.
  useEffect(() => {
    if (JSON.stringify(draft.schedule) !== previewed.current) void checkSchedule(draft.schedule);
  }, [draft.schedule]);

  // A second press while the first run starts is that run: nothing to say.
  const act = (run: () => Promise<{ scheduled: InboxScheduledRow }>) => {
    setError(null);
    return run().then(
      (answer) => putScheduled(answer.scheduled),
      (cause: Error) => (cause instanceof InboxApiError && cause.code === 'routine_running' ? void readScheduled() : setError(cause.message)),
    );
  };

  // One rule for the switch, the ⋯ menu and the foot: a one-off run of an off routine leaves it off.
  const on = routineOn(record);
  const ready = !!draft.name.trim() && !!draft.prompt.trim();
  // Turning on and a run read the saved routine: what waits is saved first, and one that did not save is said, not
  // run. Turning off stops it at once; what waits is sent alongside.
  const turn = async (next: boolean) => {
    if (!record) return autosave.turnOn();
    if (!next) {
      autosave.flush();
      return act(() => scheduledApi.turn(record.id, false));
    }
    if (!(await autosave.settle())) return setError("Not turned on: your last change isn't saved yet.");
    return act(() => scheduledApi.turn(record.id, true));
  };
  const runOnce = async () => {
    if (!record) return;
    if (!(await autosave.settle())) return setError("Not run: your last change isn't saved yet.");
    return act(() => scheduledApi.run(record.id));
  };
  const remove = () => {
    if (!record) {
      autosave.drop();
      return props.onClose();
    }
    setError(null);
    props.onDelete(record).catch((cause: Error) => setError(cause.message));
  };
  const runs = detail?.runs ?? [];
  const uid = useId();
  const [ownTab, setOwnTab] = useState<RoutineTab>(props.tab ?? 'edit');
  const tab = props.tab ?? ownTab;
  const pickTab = (next: RoutineTab) => {
    setOwnTab(next);
    props.onTab?.(next);
  };
  const threadName = record?.thread_id ? (record.thread_name ?? record.name) : null;
  const agentName = block?.launch?.agents.find((a) => a.agent === draft.agent)?.name ?? INBOX_HOST_NAMES[draft.agent] ?? draft.agent;
  const name = draft.name || (isNew ? 'New routine' : '');
  const refused = autosave.status.kind === 'refused' ? autosave.status.message : null;

  return (
    <div className="ib-pane st-pane" data-scheduled-editor={id}>
      <div className="ib-phead">
        {props.narrow && (
          <button type="button" className="ib-pback" onClick={props.onClose} aria-label="Back to routines">
            <Icon name="chevL" size={18} />
            <span className="ib-pback-l">Routines</span>
          </button>
        )}
        <span className="ib-phsubj" data-on="" aria-hidden="true">
          {!props.narrow && <span className="ib-phsubj-t">{name}</span>}
        </span>
        <SaveStatus status={autosave.status} />
        {/* Title and status at the left, ⋯ and × at the right edge, as the thread pane's header. */}
        <span className="ib-sp" />
        <MoreMenu on={record?.state === 'done' ? null : on} onTurn={() => void turn(!on)} onRun={record && record.state !== 'running' ? () => void runOnce() : null} onDelete={remove} />
        {!props.narrow && (
          <>
            <span className="ib-vsep" aria-hidden="true" />
            <Tip content="Close">
              <button type="button" className="ib-iconbtn" onClick={props.onClose} aria-label="Close">
                <Icon name="x" />
              </button>
            </Tip>
          </>
        )}
      </div>
      <div className="ib-pbody st-body">
        <input
          className="ib-subject st-title"
          aria-label="Name"
          placeholder="Name"
          value={draft.name}
          onChange={(event) => autosave.type({ name: event.target.value })}
          onBlur={autosave.flush}
        />
        <div className="ib-tmeta st-meta">
          {record?.state === 'done' ? (
            <span>{doneWords(record)}</span>
          ) : (
            <>
              <Switch on={on} label={on ? 'On' : 'Off'} disabled={!record && !ready} onClick={() => void turn(!on)} />
              <span>{on ? 'On' : 'Off'}</span>
            </>
          )}
          {threadName && record?.thread_id && (
            <>
              <span className="ib-tdot" aria-hidden="true" />
              <span>
                Replies in{' '}
                <button type="button" className="st-link" onClick={() => props.onOpenThread(record.thread_id!)}>
                  {threadName}
                </button>
              </span>
            </>
          )}
          <span className="ib-tdot" aria-hidden="true" />
          <span className="st-wrap">Runs on this computer while the Inbox is running</span>
        </div>
        {/* What went wrong, by the save status rather than under a long prompt: a refused save, a run, a turn. */}
        {(error ?? refused) && (
          <p className="ib-error st-error" role="alert">
            {error ?? refused}
          </p>
        )}
        <RoutineTabs uid={uid} tab={tab} onTab={pickTab} record={record} />
        <div role="tabpanel" id={panelIdOf(uid, 'edit')} aria-labelledby={tabIdOf(uid, 'edit')} hidden={tab !== 'edit'} data-scheduled-panel="edit">
          <section className="ib-sgroup st-group">
            <h2>Schedule</h2>
            <ScheduleRow
              schedule={draft.schedule}
              preview={preview}
              onChange={(schedule) => {
                autosave.type({ schedule });
                void checkSchedule(schedule).then((ok) => ok && autosave.release());
              }}
            />
            <div className="st-miss">
              <span id="st-miss-l">If a run is missed:</span>
              <span className="ib-seg" role="radiogroup" aria-labelledby="st-miss-l">
                {(['run_once', 'skip'] as const).map((value) => (
                  <label key={value} className="ib-seg-o" data-on={draft.if_missed === value ? '' : undefined}>
                    <input type="radio" name={`st-miss-${id}`} value={value} checked={draft.if_missed === value} onChange={() => autosave.pick({ if_missed: value })} />
                    {value === 'run_once' ? "Run once when I'm back" : 'Skip it'}
                  </label>
                ))}
              </span>
            </div>
          </section>
          <section className="ib-sgroup st-group st-kv" aria-label="What it works with">
            <span className="st-k">Repo or folder</span>
            <FolderPick block={block} folder={draft.folder} shown={record && JSON.stringify(record.folder) === JSON.stringify(draft.folder) ? record.folder_shown : null} agentName={agentName} phone={props.phone} onChange={(folder) => autosave.pick({ folder })} />
            <span className="st-k">Files</span>
            <FilesRow files={draft.attachments} onChange={(attachments) => autosave.pick({ attachments })} />
          </section>
          <section className="ib-sgroup st-group">
            <h2>Prompt</h2>
            <div className="st-box">
              <textarea
                className="st-prompt"
                aria-label="Prompt"
                placeholder="What should this do?"
                autoFocus={isNew}
                value={draft.prompt}
                onChange={(event) => autosave.type({ prompt: event.target.value })}
                onBlur={autosave.flush}
              />
              <RunsAs block={block} agent={draft.agent} model={draft.model} effort={draft.effort} phone={props.phone} onChange={(next) => autosave.pick({ agent: next.agent, model: next.model, effort: next.effort })} />
            </div>
          </section>
        </div>
        <div role="tabpanel" id={panelIdOf(uid, 'runs')} aria-labelledby={tabIdOf(uid, 'runs')} hidden={tab !== 'runs'} className="st-runspanel" data-scheduled-panel="runs">
          <RunsPanel record={record} runs={runs} loaded={detail?.scheduled.id === id} onOpenThread={props.onOpenThread} />
        </div>
      </div>
      <EditorFoot
        record={record}
        ready={ready}
        onTurnOn={() => void turn(true)}
        onRun={() => void runOnce()}
        onStop={() => record && void act(() => scheduledApi.stop(record.id))}
      />
    </div>
  );
}
