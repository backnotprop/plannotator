/**
 * Each machine's agents for the sidebar's Agents section (agents/AgentsSection.tsx, approval "inbox-agents-section").
 * The list read carries them (`agents`, packages/server/inbox-agents-list.ts) and App
 * puts each read here, before the read's own "nothing new" check: an agent's last poll moves on every read, and only
 * what reads this store draws again for it, never the list.
 *
 * The list is read again on `event: deliveries` with `agents` only while something reads this store
 * (`inboxAgentsWatched`), so the frames cost nothing until the section draws.
 */
import { useSyncExternalStore } from 'react';
import type { InboxAgent, InboxAgentsGroup } from '@plannotator/core/inbox-types';

const STATES = new Set<InboxAgent['state']>(['waiting', 'working', 'idle', 'ended']);

/** Null: the Inbox's list names no agents (an Inbox from before them), or none was read yet. */
let current: readonly InboxAgentsGroup[] | null = null;
let currentJson = 'null';
const listeners = new Set<() => void>();

const isAgent = (value: unknown): value is InboxAgent => {
  const agent = value as Partial<InboxAgent> | null;
  return !!agent && typeof agent === 'object' && typeof agent.id === 'string' && typeof agent.session === 'string' && STATES.has(agent.state as InboxAgent['state']);
};

/** The groups a list read brought (`agents`); a group or agent that does not parse is dropped. Unchanged: no redraw. */
export function setInboxAgents(next: unknown): void {
  const clean = Array.isArray(next)
    ? next
        .filter((group): group is InboxAgentsGroup => !!group && typeof group === 'object' && Array.isArray((group as InboxAgentsGroup).agents))
        .map((group) => {
          const agents = group.agents.filter(isAgent);
          return {
            ...(typeof group.machine === 'string' ? { machine: group.machine } : {}),
            agents,
            total: typeof group.total === 'number' && group.total >= agents.length ? group.total : agents.length,
            ended_today: typeof group.ended_today === 'number' && group.ended_today >= 0 ? group.ended_today : 0,
          };
        })
    : null;
  const json = JSON.stringify(clean);
  if (json === currentJson) return;
  current = clean === null ? null : Object.freeze(clean);
  currentJson = json;
  for (const listener of listeners) listener();
}

/** Hear each change (the hook's subscription; while one is held, `inboxAgentsWatched`). */
export function subscribeInboxAgents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** Each machine's agents now (this Inbox's first), redrawn when a list read changes them; null when the Inbox names none. */
export function useInboxAgents(): readonly InboxAgentsGroup[] | null {
  return useSyncExternalStore(subscribeInboxAgents, snapshot, snapshot);
}

/** Something draws the agents: `event: deliveries` with `agents` reads the list again. */
export function inboxAgentsWatched(): boolean {
  return listeners.size > 0;
}

/** The agents now, outside React (tests, a handler). */
export function inboxAgentsNow(): readonly InboxAgentsGroup[] | null {
  return current;
}

/** Every agent, each with its machine (absent on an Inbox that is not merging machines). */
export function inboxAgentsFlat(groups: readonly InboxAgentsGroup[] | null): (InboxAgent & { machine?: string })[] {
  return (groups ?? []).flatMap((group) => group.agents.map((agent) => (group.machine ? { ...agent, machine: group.machine } : agent)));
}
