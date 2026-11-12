/**
 * Each machine's agents for the sidebar's Agents section (agents/AgentsSection.tsx, approval "inbox-agents-section").
 * The list read carries them (`agents`, packages/server/inbox-agents-list.ts) and App
 * puts each read here, before the read's own "nothing new" check: an agent's last poll moves on every read, and only
 * what reads this store draws again for it, never the list.
 *
 * The list is read again on `event: deliveries` with `agents` only while something reads this store
 * (`inboxAgentsWatched`), so the frames cost nothing until the section draws.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InboxAgent, InboxAgentsGroup, InboxListRow } from '@plannotator/core/inbox-types';
import { agentListFilter, type AgentListFilter } from './agents/model';
import type { MachinesModel } from './machines';

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
  for (const listener of quiet) listener();
}

const quiet = new Set<() => void>();
/**
 * Hear each change without counting as something that draws the agents (`inboxAgentsWatched` stays as it is): the
 * agent icons' faces (agents/agentFaces.ts) find an agent's sessions here, and must not make every list read carry them.
 */
export function onInboxAgentsSet(listener: () => void): () => void {
  quiet.add(listener);
  return () => quiet.delete(listener);
}

/** Hear each change (the hook's subscription; while one is held, `inboxAgentsWatched`). */
export function subscribeInboxAgents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/**
 * Each machine's agents now (this Inbox's first), redrawn when a list read changes them; null when the Inbox names none.
 *
 * Plain state, never `useSyncExternalStore`: that draws at once, in the middle of the list read that set the agents,
 * with the read's own rows already in and what the reader does next (a snoozed row moved to its band, App.tsx
 * `moveSnoozedRow`) not yet. The row menu then saw its write landed with the row still on screen, and the row left a
 * draw later with focus on the page (rowMenu.test.tsx). As state, the agents draw in the same pass as the read.
 */
export function useInboxAgents(): readonly InboxAgentsGroup[] | null {
  const [groups, setGroups] = useState(snapshot);
  useEffect(() => {
    const read = () => setGroups(snapshot());
    // A read that landed between the first draw and this subscription.
    read();
    return subscribeInboxAgents(read);
  }, []);
  return groups;
}

/**
 * Who each agent is, never what moves on every read (its state but ended, its last poll, its counts): what the
 * list's agent filter and its title read (agents/model.ts `agentListFilter`).
 */
const whoKey = (groups: readonly InboxAgentsGroup[] | null): string =>
  JSON.stringify((groups ?? []).map((g) => [g.machine ?? null, g.agents.map((a) => [a.id, a.session, a.continues ?? null, a.launch?.thread_id ?? null, a.label ?? null, a.project?.name ?? null, a.host, a.state === 'ended'])]));

/**
 * The agents while `on` (the list is filtered to one agent; null otherwise), drawn again only when who they are
 * changes (`whoKey`), never for a poll: the window (App) reads this, and must not draw the list on every list read.
 * Heard through `onInboxAgentsSet`, so it does not make `event: deliveries` with `agents` read the list again. A
 * thread with several sessions finds its agents in it too (Thread.tsx, `threadSessions`).
 */
export function useInboxAgentsWho(on: boolean): readonly InboxAgentsGroup[] | null {
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

/**
 * The list's agent filter for `id` (`#agent=<id>`; null: none), the same object until what it matches or its name
 * changes, so a list read that brings nothing of the agent's never draws the list's rows again.
 */
export function useAgentListFilter(id: string | null, machines: MachinesModel, rows: readonly InboxListRow[]): AgentListFilter | null {
  const groups = useInboxAgentsWho(id !== null);
  const next = useMemo(() => (id ? agentListFilter(id, groups, machines, rows) : null), [id, groups, machines, rows]);
  const kept = useRef<{ key: string; filter: AgentListFilter | null }>({ key: 'null', filter: null });
  const key = JSON.stringify(next);
  if (key !== kept.current.key) kept.current = { key, filter: next };
  return kept.current.filter;
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
