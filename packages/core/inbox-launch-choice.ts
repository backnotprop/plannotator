/**
 * Model and effort for one launch (compose's "New Claude Code session", docs/agent-guides/inbox-launch.md "Model and
 * effort"): what an agent's CLI documents, how a value is checked, and the arguments it becomes. Shared by the server
 * (which builds the arguments and checks every value again) and the window (which draws the menu).
 *
 * The lists come from the CLI's own `--help` on each machine (`parseClaudeChoices`, `parsePiChoices`), so a new
 * alias or level shows with the CLI that brings it; the constants below are only the fallback when the help can't
 * be read. "Default" passes nothing: the agent starts on what its own CLI would use.
 */

/** One launch's choice. Absent: pass nothing, the agent's own default applies (as before this existed). */
export interface InboxLaunchChoice {
  model?: string;
  effort?: string;
}

/** What a machine's agent offers for a launch (compose's launch block, per agent). */
export interface InboxLaunchChoices {
  /** Model values the menu lists (Claude Code's aliases; Pi's `provider/model`). Empty: no Model menu. */
  models: string[];
  /** Effort levels, in the CLI's order. Empty: no Effort menu. */
  efforts: string[];
  /** The word the CLI uses for effort: "Effort" (Claude Code), "Thinking" (Pi). */
  effort_word: string;
  /** The last choice sent to this agent on that machine (`<dataDir>/inbox/launch/last-choice.json`): the menu starts on it. */
  last?: InboxLaunchChoice;
}

/**
 * A model or effort value as it may go on argv: a plain token that never starts with "-" (it would read as a flag),
 * with only the characters model names use (`claude-opus-4-1`, `opus[1m]`, `openai/gpt-5.5`, `x:high`, a Bedrock id).
 * Never a shell string: the value is one argv entry.
 */
export const INBOX_LAUNCH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

export const inboxLaunchTokenOk = (value: unknown): value is string => typeof value === "string" && INBOX_LAUNCH_TOKEN.test(value);

/** Claude Code 2.1.322's `--help`, used only when the installed CLI's help can't be read. */
export const CLAUDE_CHOICES_FALLBACK = { models: ["fable", "opus", "sonnet"], efforts: ["low", "medium", "high", "xhigh", "max"], effort_word: "Effort" } as const;
/** Pi 1.5's `--help` (`--thinking`), the same fallback. */
export const PI_CHOICES_FALLBACK = { models: [] as string[], efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], effort_word: "Thinking" } as const;

const words = (list: string) =>
  list
    .split(/,|\bor\b/)
    .map((word) => word.trim().replace(/^'|'$/g, ""))
    .filter((word) => inboxLaunchTokenOk(word));

/**
 * `claude --help`: the aliases `--model` names ("an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')")
 * and the levels `--effort` lists ("(low, medium, high, xhigh, max)"). Help wraps lines, so whitespace is folded first.
 * Either list unreadable: the fallback's.
 */
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

/**
 * `pi --help` (`--thinking <level>  Set thinking level: off, minimal, …`) and `pi --list-models` (a table: provider,
 * model, …; only the providers Pi can use here). A model is `provider/model`, which `--model` takes as it is.
 */
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

/**
 * A Send's `to.launch.model` / `.effort`: absent or null is the default; anything else must be a plain token, and an
 * effort one of the levels the agent lists (`efforts`; null: not known yet, the token check only). Throws the field
 * and the words for a refusal.
 */
export function parseLaunchChoice(raw: { model?: unknown; effort?: unknown }, efforts: readonly string[] | null): InboxLaunchChoice {
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
  return choice;
}

export class LaunchChoiceError extends Error {
  constructor(
    readonly field: "model" | "effort",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The arguments a choice adds to the agent's start: Claude Code `--model M --effort E`, Pi `--model M --thinking E`.
 * Each value is checked again here (a record written by hand never reaches argv unchecked); none chosen, nothing.
 */
export function launchChoiceArgs(agent: string, choice: InboxLaunchChoice): string[] {
  const effortFlag = agent === "pi" ? "--thinking" : agent === "claude-code" ? "--effort" : null;
  const args: string[] = [];
  if (inboxLaunchTokenOk(choice.model) && (agent === "claude-code" || agent === "pi")) args.push("--model", choice.model);
  if (effortFlag && inboxLaunchTokenOk(choice.effort)) args.push(effortFlag, choice.effort);
  return args;
}

/** "opus · high", "Default model · high", or null when neither is chosen: the run's line and compose's button. */
export function launchChoiceLine(choice: InboxLaunchChoice | null | undefined, shortModel = (model: string) => model): string | null {
  if (!choice?.model && !choice?.effort) return null;
  return [choice.model ? shortModel(choice.model) : null, choice.effort ?? null].filter(Boolean).join(" · ");
}
