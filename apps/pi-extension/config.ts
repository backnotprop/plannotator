import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type PhaseName = "planning" | "executing" | "reviewing";
export type RuntimePhase = PhaseName | "idle";
export type ExecutionMode = "automatic" | "external";

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
  thinking?: ConfiguredThinkingLevel | null;
  activeTools?: string[] | null;
  statusLabel?: string | null;
  /**
   * Phase framing template, delivered ONCE as a conversation message when the
   * phase is entered. Plannotator never modifies Pi's system prompt (#922);
   * the obsolete `systemPrompt` config key is ignored with a warning.
   */
  instructions?: string | null;
}

export interface PlannotatorConfig {
  executionMode?: ExecutionMode | null;
  defaults?: PhaseProfile | null;
  phases?: Partial<Record<PhaseName, PhaseProfile | null>>;
}

export interface LoadedPlannotatorConfig {
  config: PlannotatorConfig;
  warnings: string[];
}

export interface LoadPlannotatorConfigOptions {
  /** Whether Pi approved project-local inputs for this working directory. */
  projectTrusted: boolean;
}

export interface ResolvedPhaseProfile {
  model?: PhaseModelRef;
  thinking?: ConfiguredThinkingLevel;
  activeTools?: string[];
  statusLabel?: string;
  instructions?: string;
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
/**
 * Thinking levels accepted in plannotator.json, in Pi's own order.
 *
 * This list is deliberately a SUPERSET of the `ThinkingLevel` union of the
 * pinned `@earendil-works/pi-agent-core` floor (>=0.79.1, which stops at
 * "xhigh"): Pi added "max" in 0.84 and clamps a level the running model does
 * not support (`clampThinkingLevel`), so accepting a newer level costs nothing
 * on an older Pi while silently rejecting it breaks the config on a newer one
 * (#1304). The compile-time guard below runs the check in the other direction —
 * every level the pinned Pi type knows must be accepted here — so the next
 * level Pi adds fails the typecheck instead of being silently dropped.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ConfiguredThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

type AcceptedThinkingLevel<T extends ConfiguredThinkingLevel> = T;
/** Compile-time assertion: adding a level to Pi's `ThinkingLevel` fails here until it is listed above. */
export type AllPiThinkingLevelsAccepted = AcceptedThinkingLevel<ThinkingLevel>;

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

/**
 * Where a profile came from, so a rejected value can name itself instead of
 * disappearing. `scope` is the JSON path of the profile ("defaults",
 * "phases.planning"); `path` is the config file it was read from.
 */
interface ProfileContext {
  path: string;
  scope: string;
  warnings: string[];
}

function normalizeThinking(value: unknown, key: string, ctx: ProfileContext): ConfiguredThinkingLevel | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (THINKING_LEVEL_SET.has(trimmed)) return trimmed as ConfiguredThinkingLevel;
  }

  // An unrecognized level falls through to the inherited one, which looks
  // exactly like the configured level having been applied (#1304). Say so.
  ctx.warnings.push(
    `Ignoring unknown ${key} ${JSON.stringify(value)} at ${ctx.scope} in ${ctx.path}: expected one of ${THINKING_LEVELS.map((level) => `"${level}"`).join(", ")}. Keeping the inherited thinking level.`,
  );
  return undefined;
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

function normalizeProfile(raw: unknown, ctx: ProfileContext): PhaseProfile | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;

  const profile: PhaseProfile = {};

  if ("model" in raw) profile.model = normalizeModel(raw.model);
  if ("thinking" in raw) profile.thinking = normalizeThinking(raw.thinking, "thinking", ctx);
  if ("thinkingLevel" in raw && profile.thinking === undefined) {
    profile.thinking = normalizeThinking(raw.thinkingLevel, "thinkingLevel", ctx);
  }
  if ("activeTools" in raw) profile.activeTools = normalizeTools(raw.activeTools);
  if ("statusLabel" in raw) profile.statusLabel = normalizeLabel(raw.statusLabel);
  if ("instructions" in raw) profile.instructions = normalizePrompt(raw.instructions);

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
    instructions: override.instructions !== undefined ? override.instructions : base.instructions,
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
    executionMode: override.executionMode !== undefined ? override.executionMode : base.executionMode,
    defaults: mergeProfile(base.defaults, override.defaults),
    phases: Object.keys(phases).length > 0 ? phases : undefined,
  };
}

function loadConfigSource(path: string): { config: PlannotatorConfig; warnings: string[] } {
  const parsed = readJsonFile(path);
  if (parsed.error) {
    return { config: {}, warnings: [parsed.error] };
  }

  const raw = parsed.data;
  if (!isRecord(raw)) return { config: {}, warnings: [] };

  const warnings: string[] = [];
  const config: PlannotatorConfig = {};
  if (raw.executionMode === null || raw.executionMode === "automatic" || raw.executionMode === "external") {
    config.executionMode = raw.executionMode;
  } else if (raw.executionMode !== undefined) {
    // Unrecognized values fall through to the inherited value (ultimately
    // "automatic"), so say so instead of silently ignoring the key.
    warnings.push(
      `Ignoring unknown executionMode ${JSON.stringify(raw.executionMode)} in ${path}: expected "automatic" or "external". Falling back to automatic.`,
    );
  }
  if ("defaults" in raw) config.defaults = normalizeProfile(raw.defaults, { path, scope: "defaults", warnings });

  if ("phases" in raw && isRecord(raw.phases)) {
    const phases: Partial<Record<PhaseName, PhaseProfile | null>> = {};
    for (const phase of PHASES) {
      const normalized = normalizeProfile(raw.phases[phase], { path, scope: `phases.${phase}`, warnings });
      if (normalized !== undefined) phases[phase] = normalized;
    }
    if (Object.keys(phases).length > 0) config.phases = phases;
  }

  // Plannotator no longer modifies Pi's system prompt (#922). The old
  // systemPrompt key is ignored; say so once instead of silently dropping it.
  const obsoleteScopes: string[] = [];
  if (isRecord(raw.defaults) && "systemPrompt" in raw.defaults) obsoleteScopes.push("defaults");
  if (isRecord(raw.phases)) {
    for (const phase of PHASES) {
      const phaseRaw = raw.phases[phase];
      if (isRecord(phaseRaw) && "systemPrompt" in phaseRaw) obsoleteScopes.push(`phases.${phase}`);
    }
  }
  if (obsoleteScopes.length > 0) {
    warnings.push(
      `Ignoring obsolete "systemPrompt" under ${obsoleteScopes.join(", ")} in ${path}: Plannotator no longer modifies the system prompt. Rename the key to "instructions" to deliver the text as a phase-entry message instead.`,
    );
  }

  return { config, warnings };
}

export function loadPlannotatorConfig(
  cwd: string,
  options: LoadPlannotatorConfigOptions,
): LoadedPlannotatorConfig {
  const warnings: string[] = [];

  // The bundled config carries the planning rules and phase instructions. A
  // packaging regression that drops it would otherwise silently produce a
  // rule-less planning phase, so its absence is worth a warning (user global
  // and project configs stay optional and silent).
  if (!existsSync(INTERNAL_CONFIG_PATH)) {
    warnings.push(
      `Built-in config missing at ${INTERNAL_CONFIG_PATH}: phase instructions and planning tools will not apply. Reinstall the extension.`,
    );
  }

  const internal = loadConfigSource(INTERNAL_CONFIG_PATH);
  warnings.push(...internal.warnings);

  const globalPath = join(getAgentConfigDir(), "plannotator.json");
  const globalConfig = loadConfigSource(globalPath);
  warnings.push(...globalConfig.warnings);

  const projectPath = join(cwd, ".pi", "plannotator.json");
  const projectConfig = options.projectTrusted
    ? loadConfigSource(projectPath)
    : { config: {}, warnings: [] };
  warnings.push(...projectConfig.warnings);

  const merged = mergeConfig(mergeConfig(internal.config, globalConfig.config), projectConfig.config);
  return { config: merged, warnings };
}

export function resolveExecutionMode(config: PlannotatorConfig): ExecutionMode {
  return config.executionMode ?? "automatic";
}

export function resolvePhaseProfile(config: PlannotatorConfig, phase: PhaseName): ResolvedPhaseProfile {
  const defaults = config.defaults ?? {};
  const phaseConfig = config.phases?.[phase] ?? {};

  return {
    model: resolveModel(defaults.model, phaseConfig.model),
    thinking: resolveThinking(defaults.thinking, phaseConfig.thinking),
    activeTools: resolveTools(defaults.activeTools, phaseConfig.activeTools),
    statusLabel: resolveString(defaults.statusLabel, phaseConfig.statusLabel),
    instructions: resolveString(defaults.instructions, phaseConfig.instructions),
  };
}

function resolveModel(base: PhaseModelRef | null | undefined, override: PhaseModelRef | null | undefined): PhaseModelRef | undefined {
  if (override !== undefined) {
    return override ?? undefined;
  }
  return base ?? undefined;
}

function resolveThinking(
  base: ConfiguredThinkingLevel | null | undefined,
  override: ConfiguredThinkingLevel | null | undefined,
): ConfiguredThinkingLevel | undefined {
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
