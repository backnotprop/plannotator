/**
 * Which projects' list rows name their sessions (option A, 2026-11-10): those with two or more live sessions, held so
 * a row never flips between a name and its project while the person reads (the Inbox's rule that nothing moves under
 * them).
 *
 * - "Live" is the Agents list's own (`InboxAgent.live`, packages/server/inbox-agents-list.ts): a session polling in
 *   the last 30 s, a wake-only session (Codex, Qwen, T3) heard within the hour, a launch that did not fail. One
 *   conversation under a new id (`continues`) is one agent there, so it counts once.
 * - A project turns "several" at once, the moment a second session is live: one change, in place, rows keep their
 *   height. It goes back only when it has had fewer than two for SEVERAL_HOLD_MS straight AND nobody is looking:
 *   the window is hidden, or comes back from being hidden, or the page loads. A session that restarts, reloads its
 *   plugin or loses the Inbox for a minute never makes the rows flip.
 *
 * `nextSeveral` is the rule (pure, tested alone); the rest keeps it in this window, recomputed when the agents change
 * (`onInboxAgentsSet`, which does not make every list read carry them) and when the window is hidden or shown.
 */
import { useSyncExternalStore } from 'react';
import type { InboxAgent, InboxAgentsGroup } from '@plannotator/core/inbox-types';
import { inboxAgentsNow, onInboxAgentsSet } from './agentsList';

export const SEVERAL_HOLD_MS = 10 * 60_000;

/** A project on one machine: `<machine>|<project id>` (machine empty on this Inbox's own list). */
export const projectKey = (machine: string | null | undefined, projectId: string) => `${machine ?? ''}|${projectId}`;

/**
 * The projects held as several, each with the last time it had two or more live sessions. `unseen`: nobody is
 * looking now (hidden, back from hidden, a fresh load), the only time one may be let go.
 */
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

/** What the rows read: the held projects, and each project's agents (for their names and peers). */
export interface RowSessions {
  several: ReadonlySet<string>;
  /** Agents by project key, any state. */
  agents: ReadonlyMap<string, readonly InboxAgent[]>;
  /** An old session id → the session its conversation goes on as (`continues`), by machine. */
  heirs: ReadonlyMap<string, string>;
}

/** Live agents per project and agents by project, from the Agents list's groups. */
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
  // The first read of this page is a fresh look: what is several now, nothing held from before.
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
    onInboxAgentsSet(() => recompute(hidden()));
    // Hidden, or just shown again: nobody was looking, so a project may be let go now.
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => recompute(true));
    recompute(hidden());
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** The held projects and their agents, redrawn when they change. */
export function useRowSessions(): RowSessions {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
