/**
 * The names the person gave agents (Rename… on an agent's sidebar row), by every id an agent has: its
 * `InboxAgent.id` and every session it was or is. agentFaces.ts fills it from the Inbox's faces entries and the
 * agents' list.
 *
 * Precedence is decided at read time, never stored: a given name, else the session's own title (its latest poll's
 * `label`), else what the caller falls back to. So a title the tool changes later shows only while no name is given,
 * and Reset name shows the title as it is then. Display only: nothing here is sent to an agent.
 *
 * A leaf (no import from the window), so the label stores can read it without a cycle.
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

/** Sessions with each named one's `label` replaced by its given name; the same array when none is named. */
export function withGivenLabels<T extends { session: string; label?: string }>(sessions: readonly T[], names: AgentNames): readonly T[] {
  if (names.size === 0 || !sessions.some((s) => names.has(s.session))) return sessions;
  return sessions.map((s) => {
    const name = names.get(s.session);
    return name ? { ...s, label: name } : s;
  });
}
