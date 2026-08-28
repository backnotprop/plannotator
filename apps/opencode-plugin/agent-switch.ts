export interface OpenCodeAgentLike {
  name?: string;
}

export interface OpenCodeModel {
  providerID: string;
  modelID: string;
}

interface OpenCodeClientLike {
  app?: {
    agents?: (input?: unknown) => Promise<{ data?: OpenCodeAgentLike[] }>;
    log?: (entry: { level: "info" | "error"; message: string }) => unknown;
  };
  tui?: {
    showToast?: (input: unknown) => unknown;
  };
  session?: {
    message?: (input: unknown) => Promise<{
      data?: {
        info?: {
          role?: string;
          providerID?: string;
          modelID?: string;
        };
      };
    }>;
  };
}

/** What the omitted agent switch would have applied to, used in the warning copy. */
export type AgentSwitchDelivery = "feedback" | "plan-approval";

export function resolveTargetAgent(agentSwitch?: string): string | undefined {
  const trimmed = agentSwitch?.trim();
  return trimmed && trimmed !== "disabled" ? trimmed : undefined;
}

/**
 * The submit_plan tool context identifies the assistant message that made the
 * request. Its recorded model is more reliable than an agent's configured
 * default when approval hands work to a different agent.
 */
export async function getAssistantMessageModel(input: {
  client: OpenCodeClientLike;
  sessionId: string;
  messageId: string;
}): Promise<OpenCodeModel | undefined> {
  try {
    const response = await input.client.session?.message?.({
      path: { id: input.sessionId, messageID: input.messageId },
    });
    const info = response?.data?.info;
    if (
      info?.role !== "assistant" ||
      typeof info.providerID !== "string" || !info.providerID ||
      typeof info.modelID !== "string" || !info.modelID
    ) {
      return undefined;
    }
    return { providerID: info.providerID, modelID: info.modelID };
  } catch {
    // Approval can still proceed when an older OpenCode host cannot fetch it.
    return undefined;
  }
}

function warnAgentUnavailable(
  client: OpenCodeClientLike,
  targetAgent: string,
  delivery: AgentSwitchDelivery,
): void {
  const action = delivery === "plan-approval" ? "approving the plan" : "sending feedback";
  const message = `Configured OpenCode agent "${targetAgent}" is not available; ${action} without switching agents.`;

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
  delivery?: AgentSwitchDelivery;
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

  warnAgentUnavailable(input.client, targetAgent, input.delivery ?? "feedback");
  return undefined;
}
