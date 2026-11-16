/**
 * One routine beside the list (CONTRACT.md section 2). It saves as you go, as the Board's card does: a name or
 * prompt when the field is left, a pick at once, a schedule once the preview takes it. A new one starts off, and is
 * made once it has a name and a prompt.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { usePhone } from '../phone';
import { INBOX_HOST_NAMES } from '@plannotator/core/inbox-types';
import type { InboxScheduledPreview, InboxScheduledRow, InboxScheduledRunSummary, InboxScheduledSchedule } from '@plannotator/core/inbox-scheduled-types';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { Switch } from '../components/SoundRow';
import { Tip } from '../components/Tip';
import { scheduledApi, type ScheduledFields } from './client';
import { InboxApiError } from '../apiError';
import { putScheduled, readScheduled } from './store';
import { FilesRow, FolderPick, RunsAs, type LaunchBlock } from './EditorParts';
import { localZone, ScheduleRow } from './ScheduleRow';
import { OUTCOME_WORDS, runWhenWords } from './words';

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
}

const RUNS_SHOWN = 5;

/** A one-time one after its time: "Done · ran Fri 5:02 PM", or that it didn't start or didn't run (skipped). */
const doneWords = (record: InboxScheduledRow): string => {
  if (!record.last_run) return "Done · didn't run";
  if (record.last_run.outcome === 'didnt_start') return "Done · didn't start";
  return `Done · ran ${runWhenWords(record.last_run.started_at).replace(/^Today /, '')}`;
};

const fieldsOf = (row: InboxScheduledRow): ScheduledFields => ({
  name: row.name,
  prompt: row.prompt,
  schedule: row.schedule,
  if_missed: row.if_missed,
  folder: row.folder,
  agent: row.agent,
  ...(row.model ? { model: row.model } : {}),
  ...(row.effort ? { effort: row.effort } : {}),
  attachments: row.attachments,
});

function MoreMenu({ on, onTurn, onDelete }: { on: boolean | null; onTurn: () => void; onDelete: () => void }) {
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
  const [draft, setDraft] = useState<ScheduledFields>(() =>
    record
      ? fieldsOf(record)
      : { name: '', prompt: '', schedule: { cron: '0 9 * * *', tz: localZone() }, if_missed: 'run_once', folder: props.defaults.projectId ? { project_id: props.defaults.projectId } : { scratch: true }, agent: firstAgent, attachments: [] },
  );
  // A change made elsewhere (another window, an agent) comes in, but never over a field being typed in.
  const seen = useRef(record);
  useEffect(() => {
    const before = seen.current;
    seen.current = record;
    if (!record || !before || before === record) {
      if (record && !before) setDraft(fieldsOf(record));
      return;
    }
    setDraft((now) => {
      const next = { ...now };
      const theirs = fieldsOf(record);
      const was = fieldsOf(before);
      for (const key of Object.keys(theirs) as (keyof ScheduledFields)[]) if (JSON.stringify(now[key]) === JSON.stringify(was[key])) Object.assign(next, { [key]: theirs[key] });
      return next;
    });
  }, [record]);

  const [preview, setPreview] = useState<InboxScheduledPreview | null>(null);
  const asked = useRef(0);
  const previewed = useRef<string | null>(null);
  const checkSchedule = async (schedule: InboxScheduledSchedule): Promise<boolean> => {
    const n = ++asked.current;
    previewed.current = JSON.stringify(schedule);
    const answer = await scheduledApi.preview(schedule).catch(() => null);
    if (n !== asked.current) return false;
    setPreview(answer);
    return answer?.ok === true;
  };
  // The schedule shown, however it came (opened, read in after a link, changed elsewhere): its next run.
  useEffect(() => {
    if (JSON.stringify(draft.schedule) !== previewed.current) void checkSchedule(draft.schedule);
  }, [draft.schedule]);

  // A new one is made once. A pick while it is being made is saved to it next, before it opens at its own address.
  const creating = useRef(false);
  const made = useRef<string | null>(null);
  const later = useRef<{ change: Partial<ScheduledFields>; enabled: boolean } | null>(null);
  const save = async (change: Partial<ScheduledFields>, enabled = false) => {
    const next = { ...draft, ...change };
    setDraft(next);
    setError(null);
    if (isNew && creating.current) {
      later.current = { change: { ...later.current?.change, ...change }, enabled: enabled || !!later.current?.enabled };
      return;
    }
    try {
      if (!isNew) {
        if (Object.keys(change).length > 0) putScheduled((await scheduledApi.update(id, change)).scheduled);
        return;
      }
      let target = made.current;
      let pending = { change, enabled };
      if (!target) {
        if (!next.name.trim() || !next.prompt.trim()) return;
        creating.current = true;
        try {
          const answer = await scheduledApi.create({ ...next, ...(enabled ? { enabled } : {}) } as ScheduledFields);
          target = made.current = answer.scheduled.id;
          putScheduled(answer.scheduled);
        } finally {
          creating.current = false;
        }
        pending = { change: {}, enabled: false };
      }
      const rest = later.current;
      later.current = null;
      const fields = { ...pending.change, ...rest?.change };
      if (Object.keys(fields).length > 0) putScheduled((await scheduledApi.update(target, fields)).scheduled);
      if (pending.enabled || rest?.enabled) putScheduled((await scheduledApi.turn(target, true)).scheduled);
      props.onCreated(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  // A second press while the first run starts is that run: nothing to say.
  const act = (run: () => Promise<{ scheduled: InboxScheduledRow }>) =>
    run().then(
      (answer) => putScheduled(answer.scheduled),
      (cause: Error) => (cause instanceof InboxApiError && cause.code === 'routine_running' ? void readScheduled() : setError(cause.message)),
    );

  const on = record ? record.state !== 'off' && record.state !== 'done' : false;
  const turn = () => (record ? act(() => scheduledApi.turn(record.id, !on)) : void save({}, true));
  const remove = () => {
    if (!record) return props.onClose();
    setError(null);
    props.onDelete(record).catch((cause: Error) => setError(cause.message));
  };
  const runs = detail?.runs ?? [];
  const threadName = record?.thread_id ? (record.thread_name ?? record.name) : null;
  const agentName = block?.launch?.agents.find((a) => a.agent === draft.agent)?.name ?? INBOX_HOST_NAMES[draft.agent] ?? draft.agent;
  const running = record?.state === 'running';
  const name = draft.name || (isNew ? 'New routine' : '');

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
        <MoreMenu on={record?.state === 'done' ? null : on} onTurn={() => void turn()} onDelete={remove} />
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
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          onBlur={() => draft.name.trim() && draft.name !== (record?.name ?? '') && void save({ name: draft.name.trim() })}
        />
        <div className="ib-tmeta st-meta">
          {record?.state === 'done' ? (
            <span>{doneWords(record)}</span>
          ) : (
            <>
              <Switch on={on} label={on ? 'On' : 'Off'} disabled={isNew && (!draft.name.trim() || !draft.prompt.trim())} onClick={() => void turn()} />
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
        <section className="ib-sgroup st-group">
          <h2>Schedule</h2>
          <ScheduleRow
            schedule={draft.schedule}
            preview={preview}
            onChange={(schedule) => {
              setDraft((now) => ({ ...now, schedule }));
              void checkSchedule(schedule).then((ok) => ok && void save({ schedule }));
            }}
          />
          <div className="st-miss">
            <span id="st-miss-l">If a run is missed:</span>
            <span className="ib-seg" role="radiogroup" aria-labelledby="st-miss-l">
              {(['run_once', 'skip'] as const).map((value) => (
                <label key={value} className="ib-seg-o" data-on={draft.if_missed === value ? '' : undefined}>
                  <input type="radio" name={`st-miss-${id}`} value={value} checked={draft.if_missed === value} onChange={() => void save({ if_missed: value })} />
                  {value === 'run_once' ? "Run once when I'm back" : 'Skip it'}
                </label>
              ))}
            </span>
          </div>
        </section>
        <section className="ib-sgroup st-group st-kv" aria-label="What it works with">
          <span className="st-k">Repo or folder</span>
          <FolderPick block={block} folder={draft.folder} shown={record && JSON.stringify(record.folder) === JSON.stringify(draft.folder) ? record.folder_shown : null} agentName={agentName} phone={props.phone} onChange={(folder) => void save({ folder })} />
          <span className="st-k">Files</span>
          <FilesRow files={draft.attachments} onChange={(attachments) => void save({ attachments })} />
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
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              onBlur={() => draft.prompt.trim() && draft.prompt !== (record?.prompt ?? '') && void save({ prompt: draft.prompt })}
            />
            <RunsAs block={block} agent={draft.agent} model={draft.model} effort={draft.effort} phone={props.phone} onChange={(next) => void save({ agent: next.agent, model: next.model, effort: next.effort })} />
          </div>
        </section>
        {record && record.runs > 0 && (
          <section className="ib-sgroup st-group" aria-labelledby="st-runs-h">
            <h2 id="st-runs-h" className="st-runs-h">
              Runs<span className="ib-n">{formatCount(record.runs)}</span>
            </h2>
            <div className="st-runs">
              {runs.slice(0, RUNS_SHOWN).map((run) => (
                <button key={run.message_id} type="button" className="st-runrow" onClick={() => record.thread_id && props.onOpenThread(record.thread_id, run.message_id)} data-run-outcome={run.outcome}>
                  <b>Run {run.run}</b>
                  <span className={run.outcome === 'didnt_finish' || run.outcome === 'didnt_start' ? 'st-bad' : 'st-mut'}>{OUTCOME_WORDS[run.outcome]}</span>
                  <span className="st-mut">{runWhenWords(run.started_at)}</span>
                  <Icon name="chevR" size={12} />
                </button>
              ))}
            </div>
            {record.runs > RUNS_SHOWN && record.thread_id && (
              <button type="button" className="st-all" onClick={() => props.onOpenThread(record.thread_id!)}>
                All {formatCount(record.runs)} in the thread
              </button>
            )}
          </section>
        )}
        {error && (
          <p className="ib-error st-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="ib-pfoot st-pfoot">
        {running ? (
          <button type="button" className="ib-btn" onClick={() => record && void act(() => scheduledApi.stop(record.id))} data-scheduled-stop="">
            Stop
          </button>
        ) : (
          <button type="button" className="ib-btn ib-pri" disabled={!record} onClick={() => record && void act(() => scheduledApi.run(record.id))} data-scheduled-run-now="">
            Run now
          </button>
        )}
      </div>
    </div>
  );
}
