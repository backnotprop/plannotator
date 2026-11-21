// The person's choices for one project's drawing, as the Inbox writes them:
//
//   <PLANNOTATOR_DATA_DIR>/system/<project key>/setup.json
//
// `repos` are the extra repos only, each `host/owner/name` (the project's own
// repo comes from its folder's git remote). `docs` are doc site URLs. `agent`
// and `model` run the drawing phase and every redraw after it. `model` is null
// for the agent's own default; it may be saved bare (`claude-opus-5-5`) or in
// the agent's own form (`anthropic/claude-opus-5-5`), and `agentModel` gives
// the form each agent takes. `thread_message` is the first message of the
// drawing's Inbox thread, null until the first drawing starts one.

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

/** setup.json read back; null when it is not a version 1 setup. Unknown keys are ignored, so a newer Inbox may add some. */
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
