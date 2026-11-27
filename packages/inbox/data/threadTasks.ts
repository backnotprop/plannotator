/**
 * A thread's background tasks (packages/server/inbox-bg-tasks.ts), for the strip above its reply box
 * (parts/TaskStrip.tsx). A thread on a linked machine is read there through the forward; an older machine without
 * the route answers 404, which the strip shows as nothing.
 */
import { apiGet } from '../api';
import { inboxUrl, machineOf } from '../inboxUrl';

/** One background task, as `GET /api/inbox/threads/:id/tasks` answers it. */
export interface InboxBgTask {
  id: string;
  kind: string;
  description: string;
  command?: string;
  agent_type?: string;
  started_at: string | null;
  /** null: no output yet; absent: the host cannot tell, so the strip never calls it quiet. */
  last_output_at?: string | null;
}

export async function readThreadTasks(threadId: string): Promise<{ tasks: InboxBgTask[] }> {
  const body = await apiGet<{ tasks?: InboxBgTask[] }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/tasks`, undefined, machineOf(threadId)));
  return { tasks: Array.isArray(body.tasks) ? body.tasks : [] };
}
