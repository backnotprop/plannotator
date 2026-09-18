import {
  supportsSwitchAgent,
  supportsSwitchModel,
  type V2ContextLike,
} from "./v2-client";

/** OpenCode's durable model selection associated with an agent. */
export interface OpenCodeAgentModel {
  providerID: string;
  id: string;
  variant?: string;
}

export interface OpenCodeAgentLike {
  name?: string;
  model?: OpenCodeAgentModel;
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

/** What the omitted agent switch would have applied to, used in the warning copy. */
export type AgentSwitchDelivery = "feedback" | "plan-approval";

export function resolveTargetAgent(agentSwitch?: string): string | undefined {
  const trimmed = agentSwitch?.trim();
  return trimmed && trimmed !== "disabled" ? trimmed : undefined;
}

function warnAgentUnavailable(
  client: OpenCodeClientLike,
  targetAgent: string,
  delivery: AgentSwitchDelivery,
): void {
  const action = delivery === "plan-approval" ? "approving the plan" : "sending feedback";
  const message = `Configured OpenCode agent "${targetAgent}" is not available; `
    + `${action} without switching agents.`;

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

/**
 * OpenCode 2 agent switch.
 *
 * `ctx.session.switchAgent` arrived with the same plugin-API generation as
 * native command execution, so it is duck-typed rather than imported: on a host
 * without it the plan is still approved and the caller is told the switch was
 * skipped. An agent's configured model is a separate durable session selection
 * in OpenCode, so this applies both selections in the same order as its clients.
 * Returns the agent actually switched to, or undefined when the session's agent
 * was left alone.
 */
export async function switchV2SessionAgent(input: {
  ctx: V2ContextLike;
  sessionID: string;
  requestedAgent?: string;
  getAgents: () => Promise<OpenCodeAgentLike[]>;
  warn?: (message: string) => void;
}): Promise<string | undefined> {
  const warn = input.warn ?? ((message: string) => console.error(message));
  const targetAgent = resolveTargetAgent(input.requestedAgent);
  if (!targetAgent) return undefined;

  const selected = (await input.getAgents()).find((agent) => agent.name === targetAgent);
  if (!selected) {
    warn(
      `[Plannotator] Configured OpenCode agent "${targetAgent}" is not available; `
      + "approving the plan without switching agents.",
    );
    return undefined;
  }

  if (!supportsSwitchAgent(input.ctx)) {
    warn(
      "[Plannotator] This OpenCode 2 host does not expose agent switching to plugins; "
      + "approving the plan without switching agents.",
    );
    return undefined;
  }

  if (selected.model && !supportsSwitchModel(input.ctx)) {
    warn(
      `[Plannotator] This OpenCode 2 host cannot select the model configured for `
      + `agent "${targetAgent}"; approving the plan without switching agents.`,
    );
    return undefined;
  }

  try {
    await input.ctx.session!.switchAgent!({ sessionID: input.sessionID, agent: targetAgent });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`[Plannotator] Could not switch the OpenCode session to "${targetAgent}": ${detail}`);
    return undefined;
  }

  if (!selected.model) return targetAgent;

  try {
    await input.ctx.session!.switchModel!({
      sessionID: input.sessionID,
      model: selected.model,
    });
  } catch (error) {
    warn(
      `[Plannotator] Switched the OpenCode session to "${targetAgent}", but could not select `
      + `its configured model: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return targetAgent;
}
