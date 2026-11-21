/**
 * The sidebar's reload count (owner approval "reload-hosts", generalizing
 * "restart-warning"): the live sessions a reload brings up to date, per
 * runtime (Claude Code's also when its plugin needs an update first:
 * `update_first`). One runtime names itself ("Reload Claude Code 2", "Reload Pi 1",
 * "Restart Oh My Pi 1", "Reload OpenCode 1"); more than one reads
 * "Reload agents N". Pure.
 */

import type { InboxReloadRuntime, InboxRestartAgents } from '@plannotator/core/inbox-types';

export const NO_RESTART_AGENTS: InboxRestartAgents = { total: 0, runtimes: {} };

const RUNTIMES: readonly InboxReloadRuntime[] = ['claude-code', 'pi', 'oh-my-pi', 'opencode'];

/** The event stream's or the list's `restart_agents`, checked; null when absent or malformed. */
export function parseRestartAgents(value: unknown): InboxRestartAgents | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { total?: unknown; runtimes?: unknown; update_first?: unknown };
  if (typeof record.total !== 'number' || !Number.isFinite(record.total) || record.total < 0) return null;
  const runtimes: InboxRestartAgents['runtimes'] = {};
  const raw = record.runtimes && typeof record.runtimes === 'object' ? (record.runtimes as Record<string, unknown>) : {};
  for (const runtime of RUNTIMES) {
    const n = raw[runtime];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) runtimes[runtime] = Math.floor(n);
  }
  const first = record.update_first;
  const updateFirst = typeof first === 'number' && Number.isFinite(first) && first > 0 ? Math.floor(first) : 0;
  return { total: Math.floor(record.total), runtimes, ...(updateFirst > 0 ? { update_first: updateFirst } : {}) };
}

/**
 * What the sidebar shows: the Inbox's `restart_agents`, else an older Inbox's
 * Claude Code count (`restart_claude_code`), else nothing.
 */
export function restartAgentsOf(agents: unknown, claudeCode: number | undefined): InboxRestartAgents {
  const parsed = parseRestartAgents(agents);
  if (parsed) return parsed;
  const n = typeof claudeCode === 'number' && claudeCode > 0 ? Math.floor(claudeCode) : 0;
  return n > 0 ? { total: n, runtimes: { 'claude-code': n } } : NO_RESTART_AGENTS;
}

/** A runtime's name as the window writes it. */
export const RUNTIME_NAMES: Record<InboxReloadRuntime, string> = {
  'claude-code': 'Claude Code',
  pi: 'Pi',
  'oh-my-pi': 'Oh My Pi',
  opencode: 'OpenCode',
};

/** The row's words: "Reload Claude Code", "Restart Oh My Pi", or "Reload agents" for more than one runtime. */
export function restartAgentsLabel(agents: InboxRestartAgents): string {
  const present = RUNTIMES.filter((runtime) => (agents.runtimes[runtime] ?? 0) > 0);
  if (present.length !== 1) return 'Reload agents';
  const only = present[0]!;
  return `${only === 'oh-my-pi' ? 'Restart' : 'Reload'} ${RUNTIME_NAMES[only]}`;
}

/** What the row does, said to a screen reader after its words: which sessions, and that it opens Settings → Agents. */
export function restartAgentsDescription(agents: InboxRestartAgents): string {
  const claude = agents.runtimes['claude-code'] ?? 0;
  // Their plugin on disk is itself behind: the update comes first (Settings, Agents shows both steps).
  if (claude > 0 && claude === agents.total && (agents.update_first ?? 0) > 0) {
    return `${claude === 1 ? '1 Claude Code session runs' : `${claude} Claude Code sessions run`} an older plugin; update the plugin, then type /reload-plugins. Opens Settings, Agents.`;
  }
  if (claude > 0 && claude === agents.total) {
    return `${claude === 1 ? '1 Claude Code session runs' : `${claude} Claude Code sessions run`} the plugin from before the update; /reload-plugins loads the new one. Opens Settings, Agents.`;
  }
  const parts = RUNTIMES.filter((runtime) => (agents.runtimes[runtime] ?? 0) > 0).map((runtime) => {
    const n = agents.runtimes[runtime]!;
    return `${n} ${RUNTIME_NAMES[runtime]} ${n === 1 ? 'session runs' : 'sessions run'}`;
  });
  const who = parts.length > 0 ? parts.join(', ') : `${agents.total} ${agents.total === 1 ? 'session runs' : 'sessions run'}`;
  return `${who} Plannotator from before the update; a reload loads the new one. Opens Settings, Agents.`;
}
