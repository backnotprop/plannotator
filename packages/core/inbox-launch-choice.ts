/** Absent fields pass no flag: the agent's own CLI decides. */
export interface InboxLaunchChoice {
  model?: string;
  effort?: string;
  /** OpenCode's own primary agent for the session (build, plan, or one the person made): `agent` on its new session. */
  primary_agent?: string;
}

export interface InboxLaunchChoices {
  models: string[];
  efforts: string[];
  effort_word: string;
  model_efforts?: Record<string, string[]>;
  /** OpenCode's own agents a session may start as (`GET /api/agent`: primary, not hidden). Absent: no Agent column. */
  primary_agents?: string[];
  last?: InboxLaunchChoice;
}

/** Goes on argv as one entry: never a leading "-", which the CLI would read as a flag. */
export const INBOX_LAUNCH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

export const inboxLaunchTokenOk = (value: unknown): value is string => typeof value === "string" && INBOX_LAUNCH_TOKEN.test(value);

/** Claude Code 2.1.322's and Pi 1.5's lists, for when the installed CLI's help can't be read. */
export const CLAUDE_CHOICES_FALLBACK = { models: ["fable", "opus", "sonnet"], efforts: ["low", "medium", "high", "xhigh", "max"], effort_word: "Effort" } as const;
export const PI_CHOICES_FALLBACK = { models: [] as string[], efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], effort_word: "Thinking" } as const;

const words = (list: string) =>
  list
    .split(/,|\bor\b/)
    .map((word) => word.trim().replace(/^'|'$/g, ""))
    .filter((word) => inboxLaunchTokenOk(word));

/** Read from the CLI's own help, so a new alias or level shows with the CLI that brings it. Help wraps lines. */
export function parseClaudeChoices(help: string): Omit<InboxLaunchChoices, "last"> {
  const text = help.replace(/\s+/g, " ");
  const model = /--model <model>.*?\(e\.g\. ([^)]*)\)/.exec(text);
  const effort = /--effort <level>[^(]*\(([^)]*)\)/.exec(text);
  const models = model ? words(model[1]!) : [];
  const efforts = effort ? words(effort[1]!) : [];
  return {
    models: models.length > 0 ? models : [...CLAUDE_CHOICES_FALLBACK.models],
    efforts: efforts.length > 0 ? efforts : [...CLAUDE_CHOICES_FALLBACK.efforts],
    effort_word: CLAUDE_CHOICES_FALLBACK.effort_word,
  };
}

export function parsePiChoices(help: string, listModels: string | null): Omit<InboxLaunchChoices, "last"> {
  const text = help.replace(/\s+/g, " ");
  const thinking = /--thinking <level> Set thinking level: (.*?)(?: --|$)/.exec(text);
  const efforts = thinking ? words(thinking[1]!) : [];
  const models: string[] = [];
  for (const line of (listModels ?? "").split("\n")) {
    const [provider, model] = line.trim().split(/\s+/);
    if (!provider || !model || provider === "provider") continue;
    const value = `${provider}/${model}`;
    if (inboxLaunchTokenOk(value) && !models.includes(value)) models.push(value);
  }
  return { models, efforts: efforts.length > 0 ? efforts : [...PI_CHOICES_FALLBACK.efforts], effort_word: PI_CHOICES_FALLBACK.effort_word };
}

export function parseCodexModels(answer: unknown): Omit<InboxLaunchChoices, "last"> | null {
  const data = (answer as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const models: string[] = [];
  const efforts: string[] = [];
  const modelEfforts: Record<string, string[]> = {};
  for (const entry of data as { id?: unknown; hidden?: unknown; supportedReasoningEfforts?: unknown }[]) {
    if (entry?.hidden === true || !inboxLaunchTokenOk(entry?.id) || models.includes(entry.id)) continue;
    const levels = (Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [])
      .map((option: { reasoningEffort?: unknown }) => option?.reasoningEffort)
      .filter((level): level is string => inboxLaunchTokenOk(level));
    models.push(entry.id);
    modelEfforts[entry.id] = levels;
    for (const level of levels) if (!efforts.includes(level)) efforts.push(level);
  }
  if (models.length === 0) return null;
  return { models, efforts, effort_word: "Effort", model_efforts: modelEfforts };
}

export function parseOpenCodeModels(answer: unknown): Omit<InboxLaunchChoices, "last"> | null {
  const data = (answer as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const models: string[] = [];
  const efforts: string[] = [];
  const modelEfforts: Record<string, string[]> = {};
  for (const entry of data as { providerID?: unknown; id?: unknown; enabled?: unknown; variants?: unknown }[]) {
    const model = `${String(entry?.providerID)}/${String(entry?.id)}`;
    if (entry?.enabled === false || typeof entry?.providerID !== "string" || typeof entry?.id !== "string" || !inboxLaunchTokenOk(model) || models.includes(model)) continue;
    const variants = (Array.isArray(entry.variants) ? entry.variants : []).map((variant: { id?: unknown }) => variant?.id).filter((id): id is string => inboxLaunchTokenOk(id));
    models.push(model);
    modelEfforts[model] = variants;
    for (const variant of variants) if (!efforts.includes(variant)) efforts.push(variant);
  }
  if (models.length === 0) return null;
  return { models, efforts, effort_word: "Variant", model_efforts: modelEfforts };
}

/** OpenCode's agents a session can start as: a primary one (or one for either use) that is not hidden, in its order. */
export function parseOpenCodeAgents(answer: unknown): string[] | null {
  const data = (answer as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const agents: string[] = [];
  for (const entry of data as { id?: unknown; mode?: unknown; hidden?: unknown }[]) {
    if (entry?.mode === "subagent" || entry?.hidden === true || !inboxLaunchTokenOk(entry?.id) || agents.includes(entry.id)) continue;
    agents.push(entry.id);
  }
  return agents;
}

export function launchEffortsFor(choices: Pick<InboxLaunchChoices, "efforts" | "model_efforts">, model: string | undefined): string[] {
  return (model && choices.model_efforts?.[model]) || choices.efforts;
}

/** `efforts` null: the lists are not read yet, so only the token is checked (a slow CLI never refuses a start). */
export function parseLaunchChoice(raw: { model?: unknown; effort?: unknown; primary_agent?: unknown }, efforts: readonly string[] | null): InboxLaunchChoice {
  const choice: InboxLaunchChoice = {};
  if (raw.model !== undefined && raw.model !== null) {
    if (!inboxLaunchTokenOk(raw.model)) throw new LaunchChoiceError("model", "to.launch.model: a model name, such as opus.");
    choice.model = raw.model;
  }
  if (raw.effort !== undefined && raw.effort !== null) {
    if (!inboxLaunchTokenOk(raw.effort) || (efforts && !efforts.includes(raw.effort))) {
      throw new LaunchChoiceError("effort", `to.launch.effort: one of ${(efforts ?? []).join(", ") || "the levels the agent lists"}.`);
    }
    choice.effort = raw.effort;
  }
  if (raw.primary_agent !== undefined && raw.primary_agent !== null) {
    if (!inboxLaunchTokenOk(raw.primary_agent)) throw new LaunchChoiceError("primary_agent", "to.launch.primary_agent: an agent's name, such as plan.");
    choice.primary_agent = raw.primary_agent;
  }
  return choice;
}

export class LaunchChoiceError extends Error {
  constructor(
    readonly field: "model" | "effort" | "primary_agent",
    message: string,
  ) {
    super(message);
  }
}

/** Checked again here: a record edited by hand never reaches argv unchecked. */
export function launchChoiceArgs(agent: string, choice: InboxLaunchChoice): string[] {
  const effortFlag = agent === "pi" ? "--thinking" : agent === "claude-code" ? "--effort" : null;
  const args: string[] = [];
  if (inboxLaunchTokenOk(choice.model) && (agent === "claude-code" || agent === "pi")) args.push("--model", choice.model);
  if (effortFlag && inboxLaunchTokenOk(choice.effort)) args.push(effortFlag, choice.effort);
  return args;
}

export function codexThreadChoice(choice: InboxLaunchChoice): { model?: string; config: Record<string, string> } {
  return {
    ...(inboxLaunchTokenOk(choice.model) ? { model: choice.model } : {}),
    config: inboxLaunchTokenOk(choice.effort) ? { model_reasoning_effort: choice.effort } : {},
  };
}

export function openCodeSessionModel(model: string | undefined, variant: string | undefined): { providerID: string; id: string; variant?: string } | null {
  if (!inboxLaunchTokenOk(model)) return null;
  const at = model.indexOf("/");
  if (at <= 0 || at === model.length - 1) return null;
  return { providerID: model.slice(0, at), id: model.slice(at + 1), ...(inboxLaunchTokenOk(variant) ? { variant } : {}) };
}

export function launchChoiceLine(choice: InboxLaunchChoice | null | undefined, shortModel = (model: string) => model): string | null {
  if (!choice?.model && !choice?.effort && !choice?.primary_agent) return null;
  return [choice.model ? shortModel(choice.model) : null, choice.effort ?? null, choice.primary_agent ?? null].filter(Boolean).join(" · ");
}
