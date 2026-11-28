import type { InboxMessage } from '@plannotator/core/inbox-types';
import type { InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';
import { get, post } from '../api';
import { inboxUrl, machineOf } from '../inboxUrl';
import { newUuid } from '../uuid';

/** `GET|POST /api/inbox/threads/:id/swarm` (packages/server/inbox-swarm-route.ts): the swarm and its ghost thread's words, oldest first. */
export interface SwarmRead {
  swarm: InboxThreadSwarm | null;
  ghost: InboxMessage[];
}

/** On the computer that holds the thread (a linked computer's through its forward). */
const swarmUrl = (threadId: string) => inboxUrl(`/threads/${encodeURIComponent(threadId)}/swarm`, undefined, machineOf(threadId));

/** A thread's swarm in the window: the ghost pane's read, the person's words, "looked at", and Turn off. */
export const swarmApi = {
  read: (threadId: string) => get<SwarmRead>(swarmUrl(threadId)),
  /** The person's words to every member, or to the one `to` names. */
  say: (threadId: string, text: string, to: string | null) => post<SwarmRead>(swarmUrl(threadId), { say: { text, ...(to ? { to } : {}) } }),
  /** The person looked at the ghost thread: the Ghost button's count goes to zero. */
  seen: (threadId: string) => post<SwarmRead>(swarmUrl(threadId), { seen: true }),
  turn: (threadId: string, on: boolean) => post<SwarmRead>(swarmUrl(threadId), { on }),
  /** Add an agent (here or on a linked computer, `machine`): it is handed the thread with the `/swarm` skill, and is a member that has not joined. */
  add: (threadId: string, agent: { session: string; host: string | null; machine?: string; label?: string }) =>
    post<SwarmRead>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/swarm/add`, undefined, machineOf(threadId)), { ...agent, idempotency_key: newUuid() }),
};
