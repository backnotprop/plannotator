/**
 * Centralized agent configuration — single source of truth for all supported agents.
 *
 * To add a new agent:
 *   1. Add an entry to AGENT_CONFIG below (origin key, display name, badge CSS classes,
 *      optional AI provider types)
 *   2. If detection is via environment variable, add it to the detection chain
 *      in apps/hook/server/index.ts (detectedOrigin constant)
 *   3. That's it — all UI components read from this config automatically
 */

type AgentConfigEntry = {
  name: string;
  badge: string;
  /** AI provider type(s) that naturally match this origin, in preference order. */
  aiProviderTypes?: readonly string[];
};

export const AGENT_CONFIG = {
  'claude-code': { name: 'Claude Code', badge: 'bg-orange-500/15 text-orange-400', aiProviderTypes: ['claude-agent-sdk'] },
  'amp':         { name: 'Amp',         badge: 'bg-lime-500/15 text-lime-400' },
  'droid':       { name: 'Droid',       badge: 'bg-cyan-500/15 text-cyan-400' },
  'kiro-cli':    { name: 'Kiro CLI',    badge: 'bg-amber-500/15 text-amber-400' },
  'opencode':    { name: 'OpenCode',    badge: 'bg-emerald-500/15 text-emerald-400', aiProviderTypes: ['opencode-sdk'] },
  'copilot-cli': { name: 'GitHub Copilot', badge: 'bg-blue-500/15 text-blue-400' },
  'pi':          { name: 'Pi',          badge: 'bg-violet-500/15 text-violet-400', aiProviderTypes: ['pi-sdk'] },
  'codex':       { name: 'Codex',       badge: 'bg-purple-500/15 text-purple-400', aiProviderTypes: ['codex-sdk'] },
  'gemini-cli':  { name: 'Gemini CLI', badge: 'bg-sky-500/15 text-sky-400' },
  'oh-my-pi':    { name: 'Oh My Pi',    badge: 'bg-fuchsia-500/15 text-fuchsia-400' },
} as const satisfies Record<string, AgentConfigEntry>;

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

/** Resolve an origin to matching AI provider types, in preference order. */
export function getAgentAIProviderTypes(origin: Origin | null | undefined): readonly string[] {
  if (origin && origin in AGENT_CONFIG) {
    const config = AGENT_CONFIG[origin as Origin];
    return 'aiProviderTypes' in config ? config.aiProviderTypes : [];
  }
  return [];
}

/**
 * Whether a registered AI provider naturally matches an origin's harness.
 * Provider registry instance IDs can be custom (a caller may register with
 * its own `instanceId`), so both the registry id and the provider type name
 * are checked against `getAgentAIProviderTypes(origin)` — id-only matching
 * would silently miss a custom instance id. The one shared rule behind
 * `findOriginAIProvider` (packages/ui/utils/aiProvider.ts, client-side
 * default-provider matching) and `originForkProviderIds`
 * (packages/ai/endpoints.ts, server-side origin-fork gating, #1519).
 */
export function matchesAgentProvider(
  origin: Origin | null | undefined,
  providerId: string,
  providerName: string,
): boolean {
  const providerTypes = getAgentAIProviderTypes(origin);
  return providerTypes.includes(providerId) || providerTypes.includes(providerName);
}
