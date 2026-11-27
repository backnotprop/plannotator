/**
 * The thread view's background-work strip: what the thread's agent session
 * still runs in the background (shells, monitors, subagents), directly above
 * the reply box, while anything runs. "2 running · Build pin fix (agent, 4 m)
 * · Wait for test run (shell, 70 h, no output 70 h)". The list comes from
 * `GET /api/inbox/threads/:id/tasks` (packages/server/inbox-bg-tasks.ts,
 * read by data/threadTasks.ts) when the thread opens and every TASKS_POLL_MS
 * while the page is visible. How long each has run, and how long it has been
 * silent, is worked out here against the window's clock. A press on a task shows its full description and
 * command (a phone has no hover for the tooltip).
 */
import { useEffect, useState } from 'react';
import type { InboxBgTask } from '../data/threadTasks';

export type { InboxBgTask };

/** Output older than this reads "no output …": a task this quiet may be stuck. */
export const TASK_QUIET_MS = 10 * 60_000;
export const TASKS_POLL_MS = 15_000;

/** "<1 m", "4 m", "70 h", "5 d": minutes under an hour, hours under 100, then days. */
export function taskElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1 m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 100) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

const KIND_WORDS: Record<string, string> = { agent: 'agent', subagent: 'agent', shell: 'shell', monitor: 'monitor', workflow: 'workflow' };

export interface TaskStripItem {
  id: string;
  /** What the strip shows: the description, else the command, else the id. */
  label: string;
  /** "agent, 4 m" or "shell, 70 h, no output 70 h". */
  facts: string;
  quiet: boolean;
  /** The tooltip and the pressed-open text: description, agent type, command, start. */
  detail: string;
}

/** The strip's words for each task at `now` (epoch ms). */
export function taskStripItems(tasks: readonly InboxBgTask[], now: number): TaskStripItem[] {
  return tasks.map((task) => {
    const started = task.started_at ? Date.parse(task.started_at) : NaN;
    const output = task.last_output_at ? Date.parse(task.last_output_at) : NaN;
    const kind = KIND_WORDS[task.kind] ?? task.kind;
    const facts = [kind];
    if (Number.isFinite(started)) facts.push(taskElapsed(now - started));
    // Silent since its last output, or since it started when it never wrote any; never when the host cannot tell.
    const lastSign = task.last_output_at === undefined ? NaN : Number.isFinite(output) ? output : started;
    const quiet = Number.isFinite(lastSign) && now - lastSign > TASK_QUIET_MS;
    if (quiet) facts.push(`no output ${taskElapsed(now - lastSign)}`);
    const label = task.description.trim() || task.command?.trim() || task.id;
    const detail = [
      task.description.trim() || null,
      task.agent_type ? `Agent type: ${task.agent_type}` : null,
      task.command ? `$ ${task.command}` : null,
      Number.isFinite(started) ? `Started ${new Date(started).toLocaleString()}` : null,
      Number.isFinite(output) ? `Last output ${new Date(output).toLocaleString()}` : task.last_output_at === null ? 'No output yet' : null,
    ]
      .filter(Boolean)
      .join('\n');
    return { id: task.id, label, facts: facts.join(', '), quiet, detail };
  });
}

const sameTasks = (a: readonly InboxBgTask[], b: readonly InboxBgTask[]) =>
  a.length === b.length && a.every((task, i) => task.id === b[i]!.id && task.last_output_at === b[i]!.last_output_at && task.description === b[i]!.description);

/** The thread's tasks: read when it opens and every `pollMs` while the page is visible. */
function useThreadTasks(threadId: string, load: (threadId: string) => Promise<{ tasks: InboxBgTask[] }>, pollMs: number): InboxBgTask[] {
  const [tasks, setTasks] = useState<InboxBgTask[]>([]);
  useEffect(() => {
    let gone = false;
    const read = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      load(threadId)
        .then((model) => {
          if (!gone) setTasks((prev) => (sameTasks(prev, model.tasks) ? prev : model.tasks));
        })
        .catch(() => {});
    };
    setTasks([]);
    read();
    const timer = pollMs > 0 ? setInterval(read, pollMs) : null;
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      gone = true;
      if (timer) clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [threadId, load, pollMs]);
  return tasks;
}

/** The window's clock, moved every 30 s while the strip shows: elapsed times stay right without a reload. */
function useMinuteClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function TaskStrip({
  threadId,
  load,
  pollMs = TASKS_POLL_MS,
}: {
  threadId: string;
  /** The read (data/threadTasks.ts `readThreadTasks`); a failed read draws nothing. */
  load: (threadId: string) => Promise<{ tasks: InboxBgTask[] }>;
  pollMs?: number;
}) {
  const list = useThreadTasks(threadId, load, pollMs);
  const now = useMinuteClock(list.length > 0);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setOpen(null), [threadId]);
  if (list.length === 0) return null;
  const items = taskStripItems(list, now);
  const shown = items.find((item) => item.id === open) ?? null;
  return (
    <div className="ib-tasks" data-task-strip="" role="status" aria-label="Background work">
      <div className="ib-tasks-row">
        <span className="ib-tasks-n">{items.length} running</span>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`ib-task${item.quiet ? ' ib-task-quiet' : ''}`}
            data-task={item.id}
            data-quiet={item.quiet ? '' : undefined}
            title={item.detail}
            aria-expanded={open === item.id}
            onClick={() => setOpen((current) => (current === item.id ? null : item.id))}
          >
            <span className="ib-task-l">{item.label}</span> <span className="ib-task-f">({item.facts})</span>
          </button>
        ))}
      </div>
      {shown && (
        <pre className="ib-tasks-detail" data-task-detail="">
          {shown.detail}
        </pre>
      )}
    </div>
  );
}
