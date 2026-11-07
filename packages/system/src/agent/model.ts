import type { SystemAgent } from './setup.ts';

/**
 * The provider a bare model id belongs to, for agents that take
 * `provider/model` (Pi's and OpenCode's `--model`). Only families whose
 * provider id is the same in both agents are listed; any other bare id is
 * passed on as it is, for the agent to resolve or refuse.
 */
const PROVIDERS: readonly [RegExp, string][] = [
  [/^claude-/, 'anthropic'],
  [/^(gpt-|o\d|codex-)/, 'openai'],
  [/^gemini-/, 'google'],
];

/**
 * The model id as `agent` takes it on its command line, or null for the
 * agent's own default. setup.json may hold the id bare (`claude-opus-5-5`, the
 * Inbox's recommended model, saved the same for every agent) or already in
 * an agent's form (`anthropic/claude-opus-5-5`):
 *
 * - Claude Code takes a bare id or an alias (`opus`): an `anthropic/` prefix
 *   is dropped.
 * - Pi and OpenCode take `provider/model`: an id with a `/` is kept as it is
 *   (`openrouter/anthropic/claude-opus-5-5` stays), a bare id of a known family
 *   gets its provider (`claude-opus-5-5` becomes `anthropic/claude-opus-5-5`).
 */
export function agentModel(agent: SystemAgent, model: string | null | undefined): string | null {
  const id = model?.trim();
  if (!id) return null;
  if (agent === 'claude') return id.startsWith('anthropic/') ? id.slice('anthropic/'.length) || null : id;
  if (id.includes('/')) return id;
  const hit = PROVIDERS.find(([re]) => re.test(id));
  return hit ? `${hit[1]}/${id}` : id;
}
