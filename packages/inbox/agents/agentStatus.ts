/**
 * The "Agent status" setting in the window (owner, 2026-11-18; off by default; the server's side is
 * packages/server/inbox-agent-status-setting.ts). On, every agent's icon carries its status mark
 * (`InboxAgent.status_mark`: working, waiting on you here or in its terminal, idle where its host reports turns);
 * off, only agents in a Rex pane carry one (`rex_mark`, which shows either way).
 *
 * Its two switches, Settings → General → Appearance's row and the list's ⋮ menu item, read and write this one store,
 * so they never disagree. What it says comes from the agents list (`status_marks` on this Inbox's group), which every
 * window reads again when the setting changes; a switch pressed here shows at once, until the next list agrees.
 */
import { useSyncExternalStore } from 'react';
import type { InboxAgentsGroup } from '@plannotator/core/inbox-types';
import { apiPost } from '../api';
import { inboxUrl } from '../inboxUrl';
import { inboxAgentsNow, onInboxAgentsSet, subscribeInboxAgents } from '../agentsList';

/** The switch's words (Settings' row and the ⋮ menu's item). */
export const AGENT_STATUS_LABEL = 'Show agent status';
/** Settings' row only, under its label. */
export const AGENT_STATUS_DESC = 'A mark on each agent: working, or waiting on you here or in its terminal. Also in the ⋮ menu.';

/** Pressed here and not yet in a list read: what the switch shows meanwhile. */
let pending: boolean | null = null;
const listeners = new Set<() => void>();
const tell = () => {
  for (const listener of listeners) listener();
};

/** What the agents list says of the setting: on when this Inbox's group says so. */
export function agentStatusOf(groups: readonly InboxAgentsGroup[] | null): boolean {
  return !!groups?.some((group) => group.status_marks === true);
}

/** Whether every agent's mark is drawn now. */
export function agentStatusOn(): boolean {
  return pending ?? agentStatusOf(inboxAgentsNow());
}

// A list read that agrees with a press ends it.
onInboxAgentsSet(() => {
  if (pending !== null && agentStatusOf(inboxAgentsNow()) === pending) {
    pending = null;
    tell();
  }
});

/** Hear the setting and the agents list both (a mark redraws when either changes). */
export function subscribeAgentStatus(listener: () => void): () => void {
  listeners.add(listener);
  const off = subscribeInboxAgents(listener);
  return () => {
    listeners.delete(listener);
    off();
  };
}

export function useAgentStatusOn(): boolean {
  return useSyncExternalStore(subscribeAgentStatus, agentStatusOn, agentStatusOn);
}

/** The person turned it on or off: shown at once, then saved; a save that fails puts back what the list says. */
export async function setAgentStatus(on: boolean): Promise<void> {
  pending = on;
  tell();
  try {
    await apiPost(inboxUrl('/settings'), { agent_status: { on } });
  } catch {
    pending = null;
    tell();
  }
}

/** Tests only: no press waiting. */
export function resetAgentStatusForTests(): void {
  pending = null;
  tell();
}
