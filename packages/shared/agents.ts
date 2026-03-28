/**
 * Centralized agent configuration — single source of truth for all supported agents.
 *
 * To add a new agent:
 *   1. Add an entry to AGENT_CONFIG below (origin key, display name, badge CSS classes)
 *   2. If detection is via environment variable, add it to the detection chain
 *      in apps/hook/server/index.ts (detectedOrigin constant)
 *   3. That's it — all UI components read from this config automatically
 */

export const AGENT_CONFIG = {
  'claude-code': { name: 'Claude Code', badge: 'bg-orange-500/15 text-orange-400' },
  'opencode':    { name: 'OpenCode',    badge: 'bg-emerald-500/15 text-emerald-400' },
  'copilot-cli': { name: 'GitHub Copilot', badge: 'bg-blue-500/15 text-blue-400' },
  'pi':          { name: 'Pi',          badge: 'bg-violet-500/15 text-violet-400' },
  'codex':       { name: 'Codex',       badge: 'bg-purple-500/15 text-purple-400' },
} as const;

/** All recognized origin values. */
export type Origin = keyof typeof AGENT_CONFIG;

/** Resolve an origin to a human-readable agent name. */
export function getAgentName(origin: Origin | null | undefined): string {
  if (origin && origin in AGENT_CONFIG) return AGENT_CONFIG[origin as Origin].name;
  return 'Coding Agent';
}

/** Resolve an origin to Tailwind badge classes. */
export function getAgentBadge(origin: Origin | null | undefined): string {
  if (origin && origin in AGENT_CONFIG) return AGENT_CONFIG[origin as Origin].badge;
  return 'bg-zinc-500/20 text-zinc-400';
}
