/**
 * The `plannotator` agent tool switch as the UI sees it: what the server
 * reports in `serverConfig` (packages/shared/config.ts getServerConfig) and
 * the POST /api/config write that changes it.
 *
 * Only a Plannotator server that knows the session's tool host sends
 * `agentToolHost` (the Claude Code mod, Pi, Oh My Pi, OpenCode 2). Everything else, an
 * older server, OpenCode 1, Codex, a `@plannotator/ui` host such as
 * Workspaces, parses to undefined, and no toggle or offer is shown.
 */

/**
 * The hosts that register the `plannotator` agent tool. `oh-my-pi` is the Pi
 * extension running inside Oh My Pi, where the tool is on by default.
 */
export type AgentToolHost = 'claude-code' | 'pi' | 'oh-my-pi' | 'opencode';

export interface AgentToolSetting {
  readonly host: AgentToolHost;
  /** The value the NEXT session uses (env, then config file, then the host default). */
  readonly enabled: boolean;
  /** config.json holds an explicit choice (false: the host default applies). */
  readonly configured: boolean;
  /** PLANNOTATOR_AGENT_TOOL, when it overrides the file. A toggle cannot change it. */
  readonly env?: boolean;
}

function isAgentToolHost(value: unknown): value is AgentToolHost {
  return value === 'claude-code' || value === 'pi' || value === 'oh-my-pi' || value === 'opencode';
}

/** Reads the agent tool fields out of a `serverConfig` payload, or undefined when the server reports no tool host. */
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

/** The setting after a successful write of `value` (an env override still decides). */
export function withSavedAgentTool(setting: AgentToolSetting, value: boolean): AgentToolSetting {
  return { ...setting, enabled: setting.env ?? value, configured: true };
}

/**
 * Writes `{ agentTool }` to config.json through POST /api/config. Resolves
 * once the server confirms the file holds the value; rejects with a readable
 * message otherwise (the server answers 500 when the write did not land).
 * Not debounced and not best-effort like the settings registry's write-back:
 * the offer and the switch must know whether it worked.
 */
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
    // No JSON body: the status line below is all there is.
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

/**
 * When a change takes effect on this host: the tool list is part of the
 * model's prompt, so each host reads the setting once. Pi reads it per
 * session; the Claude Code mod and the OpenCode plugin decide once per
 * process (when the module or plugin loads), so those take a restart, and so
 * does Oh My Pi, which may keep the extension loaded across its sessions.
 */
export function agentToolAppliesWhen(host: AgentToolHost): string {
  return host === 'pi' ? 'the next Pi session' : `the next time ${HOST_NAMES[host]} starts`;
}

/**
 * What the tool costs in context. Pi and OpenCode send its full definition
 * with every request; Claude Code defers it behind tool search, so it costs
 * about its name until it is used; Oh My Pi lists it as one line of its
 * system prompt (about 210 characters, measured on OMP 18.10) and loads the
 * schema only when the model reads it.
 */
export function agentToolCostNote(host: AgentToolHost): string {
  if (host === 'claude-code') return 'Claude Code loads it only when needed.';
  if (host === 'oh-my-pi') return 'Oh My Pi lists it in one short line (about 50 tokens) and loads the rest only when needed.';
  return 'Adds about 780 tokens to every request.';
}
