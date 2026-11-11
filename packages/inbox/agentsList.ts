import { useEffect, useMemo, useRef, useState } from 'react';
import type { InboxAgent, InboxAgentsGroup, InboxListRow } from '@plannotator/core/inbox-types';
import { agentListFilter, type AgentListFilter } from './agents/model';
import type { MachinesModel } from './machines';

const STATES = new Set<InboxAgent['state']>(['waiting', 'working', 'idle', 'ended']);

let current: readonly InboxAgentsGroup[] | null = null;
let currentJson = 'null';
const listeners = new Set<() => void>();

const isAgent = (value: unknown): value is InboxAgent => {
  const agent = value as Partial<InboxAgent> | null;
  return !!agent && typeof agent === 'object' && typeof agent.id === 'string' && typeof agent.session === 'string' && STATES.has(agent.state as InboxAgent['state']);
};

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
  for (const listener of quiet) listener();
}

const quiet = new Set<() => void>();
/** Hear each change without counting as something that draws the agents (`inboxAgentsWatched` stays as it is). */
export function onInboxAgentsSet(listener: () => void): () => void {
  quiet.add(listener);
  return () => quiet.delete(listener);
}

export function subscribeInboxAgents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** Plain state, never `useSyncExternalStore`: that draws mid-read, before the reader's follow-up (a snoozed row moved to its band) lands, so the row left a draw late with focus on the page. */
export function useInboxAgents(): readonly InboxAgentsGroup[] | null {
  const [groups, setGroups] = useState(snapshot);
  useEffect(() => {
    const read = () => setGroups(snapshot());
    read();
    return subscribeInboxAgents(read);
  }, []);
  return groups;
}

const whoKey = (groups: readonly InboxAgentsGroup[] | null): string =>
  JSON.stringify((groups ?? []).map((g) => [g.machine ?? null, g.agents.map((a) => [a.id, a.session, a.continues ?? null, a.launch?.thread_id ?? null, a.label ?? null, a.project?.name ?? null, a.host, a.state === 'ended'])]));

function useInboxAgentsWho(on: boolean): readonly InboxAgentsGroup[] | null {
  const [groups, setGroups] = useState<readonly InboxAgentsGroup[] | null>(() => (on ? current : null));
  useEffect(() => {
    if (!on) {
      setGroups(null);
      return;
    }
    let key: string | null = null;
    const read = () => {
      const next = whoKey(current);
      if (next === key) return;
      key = next;
      setGroups(current);
    };
    read();
    return onInboxAgentsSet(read);
  }, [on]);
  return on ? groups : null;
}

export function useAgentListFilter(id: string | null, machines: MachinesModel, rows: readonly InboxListRow[]): AgentListFilter | null {
  const groups = useInboxAgentsWho(id !== null);
  const next = useMemo(() => (id ? agentListFilter(id, groups, machines, rows) : null), [id, groups, machines, rows]);
  const kept = useRef<{ key: string; filter: AgentListFilter | null }>({ key: 'null', filter: null });
  const key = JSON.stringify(next);
  if (key !== kept.current.key) kept.current = { key, filter: next };
  return kept.current.filter;
}

export function inboxAgentsWatched(): boolean {
  return listeners.size > 0;
}

export function inboxAgentsNow(): readonly InboxAgentsGroup[] | null {
  return current;
}

export function inboxAgentsFlat(groups: readonly InboxAgentsGroup[] | null): (InboxAgent & { machine?: string })[] {
  return (groups ?? []).flatMap((group) => group.agents.map((agent) => (group.machine ? { ...agent, machine: group.machine } : agent)));
}
