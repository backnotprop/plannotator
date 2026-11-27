/**
 * What the session still runs in the background (shells, monitors, subagents,
 * workflows), for the strip above its Inbox thread's reply box. Claude Code
 * hands its own list to the `Stop` and `SubagentStop` hooks
 * (`background_tasks`: `{ id, type, status, description, command?,
 * agent_type?, ... }`, the running and pending work of the session); the mod
 * reads it there (register.ts) and InboxLink sends it as the bridge event
 * `{ type: "tasks", at, tasks }` (packages/server/inbox-bg-tasks.ts), again
 * every BACKGROUND_TASKS_RESEND_MS while anything runs, because the Inbox
 * forgets a list 5 min after its report and a session waiting on background
 * work fires no hook.
 *
 * Claude Code names no start time, so a task's `started_at` is when this
 * process first saw it; `last_output_at` is not known here and is left out.
 */

/** One task as the Inbox's `tasks` event takes it. */
export interface BackgroundTaskReport {
  id: string
  kind: string
  description: string
  command?: string
  agent_type?: string
  started_at: number
}

/** Inside the Inbox's 5-minute TTL (INBOX_BG_TASKS_TTL_MS). */
export const BACKGROUND_TASKS_RESEND_MS = 4 * 60_000

const KINDS: Record<string, string> = { subagent: 'agent', local_agent: 'agent', local_bash: 'shell' }

/**
 * The running tasks of a hook's `background_tasks`, or null when the hook
 * carried no list (an older Claude Code): the last report stands. A
 * `SubagentStop` lists the stopping agent itself as still running; `stopping`
 * leaves it out. `firstSeen` keeps each id's first sighting across reports
 * (ids no longer listed are dropped from it).
 */
export function backgroundTasksOf(given: unknown, stopping: string | null, firstSeen: Map<string, number>, now: number): BackgroundTaskReport[] | null {
  if (!Array.isArray(given)) return null
  const tasks: BackgroundTaskReport[] = []
  for (const entry of given) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== 'string' || !raw.id || raw.id === stopping) continue
    if (raw.status !== undefined && raw.status !== 'running' && raw.status !== 'pending') continue
    const type = typeof raw.type === 'string' && raw.type ? raw.type : 'task'
    const task: BackgroundTaskReport = {
      id: raw.id,
      kind: KINDS[type] ?? type,
      description: typeof raw.description === 'string' ? raw.description : '',
      started_at: firstSeen.get(raw.id) ?? now,
    }
    if (typeof raw.command === 'string' && raw.command) task.command = raw.command
    if (typeof raw.agent_type === 'string' && raw.agent_type) task.agent_type = raw.agent_type
    tasks.push(task)
  }
  for (const id of [...firstSeen.keys()]) if (!tasks.some((task) => task.id === id)) firstSeen.delete(id)
  for (const task of tasks) firstSeen.set(task.id, task.started_at)
  return tasks
}
