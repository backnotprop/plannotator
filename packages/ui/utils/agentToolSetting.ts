export type AgentToolHost = 'claude-code' | 'pi' | 'oh-my-pi' | 'opencode';

export interface AgentToolSetting {
  readonly host: AgentToolHost;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly env?: boolean;
}

function isAgentToolHost(value: unknown): value is AgentToolHost {
  return value === 'claude-code' || value === 'pi' || value === 'oh-my-pi' || value === 'opencode';
}

export function parseAgentToolSetting(serverConfig: unknown): AgentToolSetting | undefined {
  if (typeof serverConfig !== 'object' || serverConfig === null) return undefined;
  const sc = serverConfig as Record<string, unknown>;
  if (!isAgentToolHost(sc.agentToolHost) || typeof sc.agentToolEnabled !== 'boolean') return undefined;
  return {
    host: sc.agentToolHost,
    enabled: sc.agentToolEnabled,
    configured: sc.agentToolConfigured === true,
    ...(typeof sc.agentToolEnv === 'boolean' ? { env: sc.agentToolEnv } : {}),
  };
}

export function withSavedAgentTool(setting: AgentToolSetting, value: boolean): AgentToolSetting {
  return { ...setting, enabled: setting.env ?? value, configured: true };
}

export async function saveAgentToolSetting(
  value: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentTool: value }),
    });
  } catch {
    throw new Error('Could not reach Plannotator. Nothing was changed.');
  }
  if (response.ok) return;
  let detail = '';
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') detail = body.error;
  } catch {
  }
  throw new Error(detail || `Plannotator answered ${response.status}. Nothing was changed.`);
}

const HOST_NAMES: Record<AgentToolHost, string> = {
  'claude-code': 'Claude Code',
  pi: 'Pi',
  'oh-my-pi': 'Oh My Pi',
  opencode: 'OpenCode',
};

export function agentToolHostName(host: AgentToolHost): string {
  return HOST_NAMES[host];
}

export function agentToolAppliesWhen(host: AgentToolHost): string {
  return host === 'pi' ? 'the next Pi session' : `the next time ${HOST_NAMES[host]} starts`;
}

export function agentToolCostNote(host: AgentToolHost): string {
  if (host === 'claude-code') return 'Claude Code loads it only when needed.';
  if (host === 'oh-my-pi') return 'Oh My Pi lists it in one short line (about 50 tokens) and loads the rest only when needed.';
  return 'Adds about 800 tokens to every request.';
}
