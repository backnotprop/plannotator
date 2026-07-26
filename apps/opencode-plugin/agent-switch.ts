export interface OpenCodeAgentLike {
  name?: string;
}

interface OpenCodeClientLike {
  app?: {
    agents?: (input?: unknown) => Promise<{ data?: OpenCodeAgentLike[] }>;
    log?: (entry: { level: "info" | "error"; message: string }) => unknown;
  };
  tui?: {
    showToast?: (input: unknown) => unknown;
  };
}

export function resolveTargetAgent(agentSwitch?: string): string | undefined {
  const trimmed = agentSwitch?.trim();
  return trimmed && trimmed !== "disabled" ? trimmed : undefined;
}

function warnAgentUnavailable(client: OpenCodeClientLike, targetAgent: string): void {
  const message = `Configured OpenCode agent "${targetAgent}" is not available; sending feedback without switching agents.`;

  try {
    void client.app?.log?.({ level: "info", message: `[Plannotator] ${message}` });
  } catch {
    // OpenCode logging is best-effort.
  }

  try {
    const result = client.tui?.showToast?.({
      body: { title: "Plannotator", message, variant: "warning" },
    });
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Toast delivery is best-effort.
  }
}

export async function resolveValidatedTargetAgent(input: {
  client: OpenCodeClientLike;
  targetAgent?: string;
  directory?: string;
}): Promise<string | undefined> {
  const targetAgent = resolveTargetAgent(input.targetAgent);
  if (!targetAgent) return undefined;

  try {
    const response = await input.client.app?.agents?.({
      query: { directory: input.directory },
    });
    const agents = response?.data ?? [];
    if (agents.some((agent) => agent.name === targetAgent)) {
      return targetAgent;
    }
  } catch {
    // Treat validation failures as unavailable: better to omit the agent than
    // send a stale/invalid target that OpenCode may reject.
  }

  warnAgentUnavailable(input.client, targetAgent);
  return undefined;
}
