export type SystemAgent = 'claude' | 'pi' | 'opencode';
export const SYSTEM_AGENTS: readonly SystemAgent[] = ['claude', 'pi', 'opencode'];

export type SystemSetup = {
  v: 1;
  repos: string[];
  docs: string[];
  agent: SystemAgent;
  model: string | null;
  thread_message: string | null;
};

export function parseSetup(value: unknown): SystemSetup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === 'string');
  if (v.v !== 1 || !strings(v.repos) || !strings(v.docs)) return null;
  if (!SYSTEM_AGENTS.includes(v.agent as SystemAgent)) return null;
  if (v.model !== undefined && v.model !== null && typeof v.model !== 'string') return null;
  if (v.thread_message !== undefined && v.thread_message !== null && typeof v.thread_message !== 'string') return null;
  return {
    v: 1,
    repos: [...v.repos],
    docs: [...v.docs],
    agent: v.agent as SystemAgent,
    model: typeof v.model === 'string' && v.model.trim() ? v.model.trim() : null,
    thread_message: typeof v.thread_message === 'string' && v.thread_message ? v.thread_message : null,
  };
}
