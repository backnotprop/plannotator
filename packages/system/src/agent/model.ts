import type { SystemAgent } from './setup.ts';

const PROVIDERS: readonly [RegExp, string][] = [
  [/^claude-/, 'anthropic'],
  [/^(gpt-|o\d|codex-)/, 'openai'],
  [/^gemini-/, 'google'],
];

export function agentModel(agent: SystemAgent, model: string | null | undefined): string | null {
  const id = model?.trim();
  if (!id) return null;
  if (agent === 'claude') return id.startsWith('anthropic/') ? id.slice('anthropic/'.length) || null : id;
  if (id.includes('/')) return id;
  const hit = PROVIDERS.find(([re]) => re.test(id));
  return hit ? `${hit[1]}/${id}` : id;
}
