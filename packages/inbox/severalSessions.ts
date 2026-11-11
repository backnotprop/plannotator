/**
 * Projects whose rows name their sessions: two or more live. Held so a row never flips back while someone looks; it
 * is let go only after SEVERAL_HOLD_MS with fewer than two, and only while the window is hidden or freshly shown.
 */
import { useEffect, useState } from 'react';
import type { InboxAgent, InboxAgentsGroup } from '@plannotator/core/inbox-types';
import { inboxAgentsNow, onInboxAgentsSet } from './agentsList';

export const SEVERAL_HOLD_MS = 10 * 60_000;

export const projectKey = (machine: string | null | undefined, projectId: string) => `${machine ?? ''}|${projectId}`;

export function nextSeveral(held: ReadonlyMap<string, number>, live: ReadonlyMap<string, number>, now: number, unseen: boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, count] of live) if (count >= 2) out.set(key, now);
  for (const [key, at] of held) {
    if (out.has(key)) continue;
    if (unseen && now - at >= SEVERAL_HOLD_MS) continue;
    out.set(key, at);
  }
  return out;
}

export interface RowSessions {
  several: ReadonlySet<string>;
  agents: ReadonlyMap<string, readonly InboxAgent[]>;
  heirs: ReadonlyMap<string, string>;
}

export function sessionsByProject(groups: readonly InboxAgentsGroup[] | null): { live: Map<string, number>; agents: Map<string, InboxAgent[]>; heirs: Map<string, string> } {
  const live = new Map<string, number>();
  const agents = new Map<string, InboxAgent[]>();
  const heirs = new Map<string, string>();
  (groups ?? []).forEach((group, index) => {
    // This Inbox's own group is the first; its rows carry no machine unless the list is merged.
    const machines = index === 0 && group.machine ? [group.machine, null] : [group.machine ?? null];
    for (const agent of group.agents) {
      if (!agent.project?.id) continue;
      for (const machine of machines) {
        const key = projectKey(machine, agent.project.id);
        agents.set(key, [...(agents.get(key) ?? []), agent]);
        if (agent.live) live.set(key, (live.get(key) ?? 0) + 1);
        for (const old of agent.continues ?? []) heirs.set(`${machine ?? ''}|${old}`, agent.session);
      }
    }
  });
  return { live, agents, heirs };
}

let held = new Map<string, number>();
let current: RowSessions = { several: new Set(), agents: new Map(), heirs: new Map() };
let loaded = false;
const listeners = new Set<() => void>();

function recompute(unseen: boolean): void {
  const groups = inboxAgentsNow();
  if (groups === null) return;
  const { live, agents, heirs } = sessionsByProject(groups);
  held = nextSeveral(held, live, Date.now(), unseen || !loaded);
  loaded = true;
  current = { several: new Set(held.keys()), agents, heirs };
  for (const listener of listeners) listener();
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
let wired = false;
function subscribe(listener: () => void): () => void {
  if (!wired) {
    wired = true;
    // Not a watcher (`subscribeInboxAgents`): a list read on every turn moved focus under a row action.
    onInboxAgentsSet(() => recompute(hidden()));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => recompute(true));
    recompute(hidden());
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** Plain state, not `useSyncExternalStore`: agents are set mid list read, and a store hook would draw before the read's own changes. */
export function useRowSessions(): RowSessions {
  const [sessions, setSessions] = useState(snapshot);
  useEffect(() => {
    const read = () => setSessions(snapshot());
    const stop = subscribe(read);
    read();
    return stop;
  }, []);
  return sessions;
}
