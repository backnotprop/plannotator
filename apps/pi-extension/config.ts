import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type PhaseName = "planning" | "executing" | "reviewing";
export type RuntimePhase = PhaseName | "idle";

export interface PhaseModelRef {
  provider: string;
  id: string;
}

/**
 * Config values loaded from JSON can intentionally clear inherited values.
 *
 * - `null` clears a value from a parent config.
 * - `[]` clears active tools.
 * - `""` clears string values.
 */
export interface PhaseProfile {
  model?: PhaseModelRef | null;
  thinking?: ThinkingLevel | null;
  activeTools?: string[] | null;
  statusLabel?: string | null;
  systemPrompt?: string | null;
}

export interface PlannotatorConfig {
  defaults?: PhaseProfile | null;
  phases?: Partial<Record<PhaseName, PhaseProfile | null>>;
}

export interface LoadedPlannotatorConfig {
  config: PlannotatorConfig;
  warnings: string[];
}

export interface ResolvedPhaseProfile {
  model?: PhaseModelRef;
  thinking?: ThinkingLevel;
  activeTools?: string[];
  statusLabel?: string;
  systemPrompt?: string;
}

export interface PromptVariables {
  planFilePath: string;
  todoList: string;
  completedCount: number;
  totalCount: number;
  remainingCount: number;
  phase: RuntimePhase;
}

export interface PromptRenderResult {
  text: string;
  unknownVariables: string[];
}

const INTERNAL_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "plannotator.json");
const PHASES: PhaseName[] = ["planning", "executing", "reviewing"];
const THINKING_LEVELS = new Set<string>(["minimal", "low", "medium", "high", "xhigh"]);

function getAgentConfigDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;
  return join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): { data?: unknown; error?: string } {
  if (!existsSync(path)) return {};

  try {
    return { data: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (error) {
    return { error: `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function normalizeModel(value: unknown): PhaseModelRef | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!provider || !id) return undefined;
  return { provider, id };
}

function normalizeThinking(value: unknown): ThinkingLevel | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;

  return THINKING_LEVELS.has(trimmed as ThinkingLevel) ? (trimmed as ThinkingLevel) : undefined;
}

function normalizeTools(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];

  const tools = value.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0);
  return tools.length > 0 ? tools : undefined;
}

function normalizeLabel(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePrompt(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.length > 0 ? value : null;
}

function normalizeProfile(raw: unknown): PhaseProfile | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;

  const profile: PhaseProfile = {};

  if ("model" in raw) profile.model = normalizeModel(raw.model);
  if ("thinking" in raw) profile.thinking = normalizeThinking(raw.thinking);
  if ("thinkingLevel" in raw && profile.thinking === undefined) profile.thinking = normalizeThinking(raw.thinkingLevel);
  if ("activeTools" in raw) profile.activeTools = normalizeTools(raw.activeTools);
  if ("statusLabel" in raw) profile.statusLabel = normalizeLabel(raw.statusLabel);
  if ("systemPrompt" in raw) profile.systemPrompt = normalizePrompt(raw.systemPrompt);

  return profile;
}

function cloneProfile(profile: PhaseProfile | null | undefined): PhaseProfile | null | undefined {
  if (profile === null || profile === undefined) return profile;
  return { ...profile, activeTools: profile.activeTools ? [...profile.activeTools] : profile.activeTools };
}

function mergeProfile(base: PhaseProfile | null | undefined, override: PhaseProfile | null | undefined): PhaseProfile | null | undefined {
  if (override === null) return null;
  if (override === undefined) return cloneProfile(base);
  if (base === null || base === undefined) return cloneProfile(override);

  const merged: PhaseProfile = {
    model: override.model !== undefined ? override.model : base.model,
    thinking: override.thinking !== undefined ? override.thinking : base.thinking,
    activeTools: override.activeTools !== undefined ? override.activeTools : base.activeTools,
    statusLabel: override.statusLabel !== undefined ? override.statusLabel : base.statusLabel,
    systemPrompt: override.systemPrompt !== undefined ? override.systemPrompt : base.systemPrompt,
  };

  return merged;
}

function mergeConfig(base: PlannotatorConfig, override: PlannotatorConfig): PlannotatorConfig {
  const phases: Partial<Record<PhaseName, PhaseProfile | null>> = {};
  for (const phase of PHASES) {
    const merged = mergeProfile(base.phases?.[phase], override.phases?.[phase]);
    if (merged !== undefined) phases[phase] = merged;
  }

  return {
    defaults: mergeProfile(base.defaults, override.defaults),
    phases: Object.keys(phases).length > 0 ? phases : undefined,
  };
}

function loadConfigSource(path: string): { config: PlannotatorConfig; warning?: string } {
  const parsed = readJsonFile(path);
  if (parsed.error) {
    return { config: {}, warning: parsed.error };
  }

  const raw = parsed.data;
  if (!isRecord(raw)) return { config: {} };

  const config: PlannotatorConfig = {};
  if ("defaults" in raw) config.defaults = normalizeProfile(raw.defaults);

  if ("phases" in raw && isRecord(raw.phases)) {
    const phases: Partial<Record<PhaseName, PhaseProfile | null>> = {};
    for (const phase of PHASES) {
      const normalized = normalizeProfile(raw.phases[phase]);
      if (normalized !== undefined) phases[phase] = normalized;
    }
    if (Object.keys(phases).length > 0) config.phases = phases;
  }

  return { config };
}

export function loadPlannotatorConfig(cwd: string): LoadedPlannotatorConfig {
  const warnings: string[] = [];

  const internal = loadConfigSource(INTERNAL_CONFIG_PATH);
  if (internal.warning) warnings.push(internal.warning);

  const globalPath = join(getAgentConfigDir(), "plannotator.json");
  const globalConfig = loadConfigSource(globalPath);
  if (globalConfig.warning) warnings.push(globalConfig.warning);

  const projectPath = join(cwd, ".pi", "plannotator.json");
  const projectConfig = loadConfigSource(projectPath);
  if (projectConfig.warning) warnings.push(projectConfig.warning);

  const merged = mergeConfig(mergeConfig(internal.config, globalConfig.config), projectConfig.config);
  return { config: merged, warnings };
}

export function resolvePhaseProfile(config: PlannotatorConfig, phase: PhaseName): ResolvedPhaseProfile {
  const defaults = config.defaults ?? {};
  const phaseConfig = config.phases?.[phase] ?? {};

  return {
    model: resolveModel(defaults.model, phaseConfig.model),
    thinking: resolveThinking(defaults.thinking, phaseConfig.thinking),
    activeTools: resolveTools(defaults.activeTools, phaseConfig.activeTools),
    statusLabel: resolveString(defaults.statusLabel, phaseConfig.statusLabel),
    systemPrompt: resolveString(defaults.systemPrompt, phaseConfig.systemPrompt),
  };
}

function resolveModel(base: PhaseModelRef | null | undefined, override: PhaseModelRef | null | undefined): PhaseModelRef | undefined {
  if (override !== undefined) {
    return override ?? undefined;
  }
  return base ?? undefined;
}

function resolveThinking(base: ThinkingLevel | null | undefined, override: ThinkingLevel | null | undefined): ThinkingLevel | undefined {
  if (override !== undefined) {
    return override ?? undefined;
  }
  return base ?? undefined;
}

function resolveTools(base: string[] | null | undefined, override: string[] | null | undefined): string[] | undefined {
  if (override !== undefined) {
    if (override === null) return [];
    return [...override];
  }
  if (base === null) return [];
  return base ? [...base] : undefined;
}

function resolveString(base: string | null | undefined, override: string | null | undefined): string | undefined {
  if (override !== undefined) {
    if (override === null || override === "") return undefined;
    return override;
  }
  return base ?? undefined;
}

export function buildPromptVariables(options: {
  planFilePath: string;
  phase: RuntimePhase;
  totalCount: number;
  completedCount: number;
  remainingCount?: number;
  todoList?: string;
}): PromptVariables {
  const totalCount = options.totalCount;
  const completedCount = options.completedCount;
  const remainingCount = options.remainingCount ?? Math.max(totalCount - completedCount, 0);

  return {
    planFilePath: options.planFilePath,
    todoList: options.todoList ?? "",
    completedCount,
    totalCount,
    remainingCount,
    phase: options.phase,
  };
}

export function renderTemplate(template: string, vars: PromptVariables): PromptRenderResult {
  const unknownVariables = new Set<string>();
  const text = template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    if (key in vars) {
      const value = vars[key as keyof PromptVariables];
      return value === undefined || value === null ? "" : String(value);
    }
    unknownVariables.add(key);
    return "";
  });

  return { text, unknownVariables: [...unknownVariables] };
}

export function formatTodoList(items: Array<{ step: number; text: string; completed: boolean }>): {
  todoList: string;
  completedCount: number;
  totalCount: number;
  remainingCount: number;
} {
  const totalCount = items.length;
  const completedCount = items.filter((item) => item.completed).length;
  const remainingItems = items.filter((item) => !item.completed);
  const todoList = remainingItems.length
    ? remainingItems.map((item) => `- [ ] ${item.step}. ${item.text}`).join("\n")
    : "";

  return {
    todoList,
    completedCount,
    totalCount,
    remainingCount: remainingItems.length,
  };
}
