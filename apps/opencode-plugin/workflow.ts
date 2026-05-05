import { normalizeEditPermission } from "./plan-mode";

export type WorkflowMode = "manual" | "user-managed" | "plan-agent" | "all-agents";

export interface PlannotatorOpenCodeOptions {
  workflow?: unknown;
  planningAgents?: unknown;
}

export interface NormalizedWorkflowOptions {
  workflow: WorkflowMode;
  planningAgents: string[];
  planningAgentSet: Set<string>;
}

const WORKFLOWS = new Set<WorkflowMode>(["manual", "user-managed", "plan-agent", "all-agents"]);
const DEFAULT_WORKFLOW: WorkflowMode = "plan-agent";
const DEFAULT_PLANNING_AGENTS = ["plan"];
const BUILTIN_PLAN_AGENT = "plan";

type AgentConfig = {
  mode?: string;
  permission?: Record<string, any>;
  [key: string]: any;
};

type OpenCodeConfig = {
  experimental?: {
    primary_tools?: string[];
    [key: string]: any;
  };
  agent?: Record<string, AgentConfig>;
  [key: string]: any;
};

export function normalizeWorkflowOptions(
  rawOptions: PlannotatorOpenCodeOptions | null | undefined,
): NormalizedWorkflowOptions {
  const rawWorkflow = typeof rawOptions?.workflow === "string"
    ? rawOptions.workflow.trim()
    : "";
  const workflow = WORKFLOWS.has(rawWorkflow as WorkflowMode)
    ? rawWorkflow as WorkflowMode
    : DEFAULT_WORKFLOW;

  const planningAgents = normalizePlanningAgents(rawOptions?.planningAgents);
  return {
    workflow,
    planningAgents,
    planningAgentSet: new Set(planningAgents),
  };
}

function normalizePlanningAgents(value: unknown): string[] {
  const seen = new Set<string>();
  const agents: string[] = [BUILTIN_PLAN_AGENT];
  seen.add(BUILTIN_PLAN_AGENT);

  if (!Array.isArray(value)) return agents;

  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    agents.push(trimmed);
  }

  return agents;
}

export function isPlanningAgent(
  agentName: string | undefined,
  options: NormalizedWorkflowOptions,
): boolean {
  return !!agentName && options.planningAgentSet.has(agentName);
}

export function shouldRegisterSubmitPlan(options: NormalizedWorkflowOptions): boolean {
  return options.workflow !== "manual";
}

export function shouldModifyPrompts(options: NormalizedWorkflowOptions): boolean {
  return options.workflow !== "manual" && options.workflow !== "user-managed";
}

export function shouldApplyToolDefinitionRewrites(options: NormalizedWorkflowOptions): boolean {
  return options.workflow !== "manual" && options.workflow !== "user-managed";
}

export function shouldInjectFullPlanningPrompt(
  agentName: string | undefined,
  options: NormalizedWorkflowOptions,
): boolean {
  return shouldModifyPrompts(options) && isPlanningAgent(agentName, options);
}

export function shouldInjectGenericPlanReminder(
  agentName: string | undefined,
  isSubagent: boolean,
  options: NormalizedWorkflowOptions,
): boolean {
  if (options.workflow !== "all-agents") return false;
  if (!agentName || isSubagent) return false;
  if (agentName === "build") return false;
  return !isPlanningAgent(agentName, options);
}

export function shouldRejectSubmitPlanForAgent(
  agentName: string | undefined,
  options: NormalizedWorkflowOptions,
): boolean {
  return options.workflow === "plan-agent" && !isPlanningAgent(agentName, options);
}

export function applyWorkflowConfig(
  opencodeConfig: OpenCodeConfig,
  options: NormalizedWorkflowOptions,
  allowSubagents: boolean,
): void {
  if (options.workflow === "manual" || options.workflow === "user-managed") return;

  if (!allowSubagents) {
    const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? [];
    if (!existingPrimaryTools.includes("submit_plan")) {
      opencodeConfig.experimental = {
        ...opencodeConfig.experimental,
        primary_tools: [...existingPrimaryTools, "submit_plan"],
      };
    }
  }

  opencodeConfig.agent ??= {};

  for (const agentName of options.planningAgents) {
    allowPlanningAgent(opencodeConfig, agentName);
  }

  if (options.workflow === "all-agents") return;

  if (!options.planningAgentSet.has("build")) {
    denySubmitPlan(opencodeConfig, "build");
  }

  for (const [agentName, agentConfig] of Object.entries(opencodeConfig.agent)) {
    if (options.planningAgentSet.has(agentName)) {
      allowPlanningAgent(opencodeConfig, agentName);
      continue;
    }

    if (isPrimaryCapableAgent(agentConfig, allowSubagents)) {
      denySubmitPlan(opencodeConfig, agentName);
    }
  }
}

function allowPlanningAgent(opencodeConfig: OpenCodeConfig, agentName: string): void {
  const agent = ensureAgentConfig(opencodeConfig, agentName);
  const permission = ensurePermission(agent);
  permission.submit_plan = "allow";
  permission.edit = {
    ...normalizeEditPermission(permission.edit),
    "*.md": "allow",
  };
}

function denySubmitPlan(opencodeConfig: OpenCodeConfig, agentName: string): void {
  const agent = ensureAgentConfig(opencodeConfig, agentName);
  ensurePermission(agent).submit_plan = "deny";
}

function ensureAgentConfig(opencodeConfig: OpenCodeConfig, agentName: string): AgentConfig {
  opencodeConfig.agent ??= {};
  opencodeConfig.agent[agentName] ??= {};
  return opencodeConfig.agent[agentName];
}

function ensurePermission(agent: AgentConfig): Record<string, any> {
  if (!agent.permission || typeof agent.permission !== "object" || Array.isArray(agent.permission)) {
    agent.permission = {};
  }
  return agent.permission;
}

function isPrimaryCapableAgent(agent: AgentConfig, allowSubagents: boolean): boolean {
  const mode = typeof agent.mode === "string" ? agent.mode : "all";
  if (mode === "subagent") return allowSubagents;
  return mode === "primary" || mode === "all" || !agent.mode;
}
