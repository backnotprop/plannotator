import type { InboxSwarm } from '@plannotator/core/inbox-types';
import { get, post } from '../api';
import { inboxUrl } from '../inboxUrl';

/** A thread's swarm on the computer that holds it (packages/server/inbox-swarm-route.ts); `machine` null: this one. */
export const swarmApi = {
  read: (threadId: string, machine: string | null) => get<{ thread_id: string; swarm: InboxSwarm | null }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/swarm`, undefined, machine)),
  set: (threadId: string, on: boolean, machine: string | null) => post<{ thread_id: string; swarm: InboxSwarm | null }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/swarm`, undefined, machine), { on }),
};
