import type { PluginRequest } from "@plannotator/shared/plugin-protocol";

export type ScenarioId =
  | "claude-plan-hook"
  | "opencode-plan"
  | "opencode-review"
  | "opencode-annotate"
  | "opencode-archive"
  | "pi-plan"
  | "pi-review"
  | "pi-annotate"
  | "pi-archive"
  | "codex-plan-hook"
  | "copilot-plan-hook"
  | "gemini-plan-file-hook"
  | "cli-review"
  | "cli-annotate"
  | "cli-annotate-gate"
  | "cli-annotate-html"
  | "cli-annotate-url"
  | "cli-archive";

export type ScenarioKind = "hook" | "plugin" | "cli";
export type CompletionMode = "plan" | "review" | "annotate" | "archive";

export interface ScenarioFixture {
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
  cleanup?: () => Promise<void> | void;
  completion?: CompletionMode;
}

export interface ScenarioCommand {
  command: string;
  args: string[];
  stdin?: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface ScenarioDefinition {
  id: ScenarioId;
  title: string;
  kind: ScenarioKind;
  agent: "claude-code" | "opencode" | "pi" | "codex" | "copilot-cli" | "gemini-cli" | "direct-cli";
  description: string;
  expectedSessionMode: CompletionMode;
  buildFixture(repoRoot: string): Promise<ScenarioFixture>;
  buildCommand(repoRoot: string, fixture: ScenarioFixture): ScenarioCommand;
}

export interface PluginScenarioOptions {
  origin: "opencode" | "pi";
  action: PluginRequest["action"];
  request: PluginRequest;
}
