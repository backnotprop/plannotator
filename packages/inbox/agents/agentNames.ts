/**
 * The names the person gave agents (Rename… on an agent's sidebar row): id → name, for every id an agent has (its
 * `InboxAgent.id`, every session it was or is). The Inbox keeps them in the agent faces' entries (agentFaces.ts,
 * `POST /api/inbox/agent-faces` with `name`), so a continued session keeps its name as it keeps its face, and every
 * window open hears a rename at once (`event: agent-faces`). agentFaces.ts folds them here on each change.
 *
 * A given name beats every other name the window has for that agent: the agents' list (`InboxAgent.label`,
 * agentsList.ts) and the sessions' labels (sessionLabels.ts) read through this map, so the sidebar, the list's agent
 * filter, the list rows' agents, a message's author and the To picker show it. Display only: what is sent to an agent
 * (an `@` tag's token and label, a hand-off's label) stays what it was.
 *
 * A leaf: it imports nothing of the window's, so the label stores can read it without a cycle.
 */
import { useSyncExternalStore } from 'react';

export type AgentNames = ReadonlyMap<string, string>;

const EMPTY: AgentNames = new Map();
let current: AgentNames = EMPTY;
const listeners = new Set<() => void>();

/** The names now (agentFaces.ts, on each change). Unchanged: nobody hears it. */
export function setAgentNames(next: AgentNames): void {
  if (next.size === current.size && [...next].every(([id, name]) => current.get(id) === name)) return;
  current = next.size === 0 ? EMPTY : next;
  for (const listener of [...listeners]) listener();
}

/** Hear each change. */
export function onAgentNames(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** The names, redrawn when one changes. */
export function useAgentNames(): AgentNames {
  return useSyncExternalStore(onAgentNames, snapshot, snapshot);
}

/** The names now, outside React. */
export function agentNamesNow(): AgentNames {
  return current;
}

/** The name given to the agent of any of `ids` (the first that has one), or null. */
export function givenName(names: AgentNames, ...ids: readonly (string | null | undefined)[]): string | null {
  for (const id of ids) {
    const name = id ? names.get(id) : undefined;
    if (name) return name;
  }
  return null;
}
