import { join } from "node:path";
import type { PluginRequest } from "@plannotator/shared/plugin-protocol";
import {
  codexThreadId,
  copilotSessionId,
  createWorkspaceFixture,
  simulatorPlan,
} from "./fixtures";
import type {
  CompletionMode,
  ScenarioCommand,
  ScenarioDefinition,
  ScenarioFixture,
  ScenarioId,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function plannotatorCommand(repoRoot: string): string {
  return join(repoRoot, "bin", "plannotator.js");
}

function commonEnv(fixture: ScenarioFixture): Record<string, string> {
  return {
    PLANNOTATOR_BROWSER: browserNoopCommand(),
    PLANNOTATOR_DISABLE_AUTO_INSTALL: "1",
    PLANNOTATOR_SHARE: "disabled",
    ...(fixture.env ?? {}),
  };
}

function browserNoopCommand(): string {
  return process.platform === "win32" ? "cmd" : "/usr/bin/true";
}

function command(
  repoRoot: string,
  fixture: ScenarioFixture,
  args: string[],
  stdin = fixture.stdin,
): ScenarioCommand {
  return {
    command: plannotatorCommand(repoRoot),
    args,
    stdin,
    cwd: fixture.cwd,
    env: commonEnv(fixture),
  };
}

async function workspace(label: string): Promise<ScenarioFixture> {
  const fixture = await createWorkspaceFixture(label);
  return {
    cwd: fixture.root,
    cleanup: fixture.cleanup,
    env: {
      HOME: fixture.root,
      COPILOT_HOME: fixture.copilotHome,
    },
  };
}

async function pluginFixture(label: string, request: PluginRequest): Promise<ScenarioFixture> {
  const fixture = await createWorkspaceFixture(label);
  return {
    cwd: fixture.root,
    stdin: JSON.stringify({ ...request, cwd: fixture.root, timeoutMs: DEFAULT_TIMEOUT_MS }),
    completion: modeForPluginAction(request.action),
    cleanup: fixture.cleanup,
    env: {
      HOME: fixture.root,
      COPILOT_HOME: fixture.copilotHome,
    },
  };
}

function modeForPluginAction(action: PluginRequest["action"]): CompletionMode {
  if (action === "annotate-last") return "annotate";
  return action;
}

function pluginScenario({
  id,
  title,
  origin,
  action,
  request,
}: {
  id: ScenarioId;
  title: string;
  origin: "opencode" | "pi";
  action: PluginRequest["action"];
  request: Record<string, unknown>;
}): ScenarioDefinition {
  const expectedSessionMode = modeForPluginAction(action);
  return {
    id,
    title,
    kind: "plugin",
    agent: origin,
    expectedSessionMode,
    description: `Runs plannotator plugin ${action} using the ${origin} protocol.`,
    buildFixture: (repoRoot) =>
      pluginFixture(id, {
        ...request,
        action,
        origin,
        sharingEnabled: false,
      } as PluginRequest),
    buildCommand: (repoRoot, fixture) => command(repoRoot, fixture, ["plugin", action, "--origin", origin]),
  };
}

export const scenarioDefinitions: ScenarioDefinition[] = [
  {
    id: "claude-plan-hook",
    title: "Claude Code plan hook",
    kind: "hook",
    agent: "claude-code",
    expectedSessionMode: "plan",
    description: "Feeds a Claude PermissionRequest ExitPlanMode event through stdin.",
    async buildFixture() {
      const fixture = await workspace("claude-plan");
      fixture.stdin = JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "ExitPlanMode",
        tool_input: { plan: simulatorPlan() },
        permission_mode: "default",
      });
      fixture.completion = "plan";
      return fixture;
    },
    buildCommand: (repoRoot, fixture) => command(repoRoot, fixture, []),
  },
  pluginScenario({
    id: "opencode-plan",
    title: "OpenCode plan",
    origin: "opencode",
    action: "plan",
    request: { plan: simulatorPlan() },
  }),
  pluginScenario({
    id: "opencode-review",
    title: "OpenCode review",
    origin: "opencode",
    action: "review",
    request: { args: "" },
  }),
  pluginScenario({
    id: "opencode-annotate",
    title: "OpenCode annotate",
    origin: "opencode",
    action: "annotate",
    request: { markdown: "# Annotate\n\nOpenCode annotation fixture.", filePath: "opencode.md" },
  }),
  pluginScenario({
    id: "opencode-archive",
    title: "OpenCode archive",
    origin: "opencode",
    action: "archive",
    request: {},
  }),
  pluginScenario({
    id: "pi-plan",
    title: "Pi plan",
    origin: "pi",
    action: "plan",
    request: { plan: simulatorPlan() },
  }),
  pluginScenario({
    id: "pi-review",
    title: "Pi review",
    origin: "pi",
    action: "review",
    request: { args: "" },
  }),
  pluginScenario({
    id: "pi-annotate",
    title: "Pi annotate",
    origin: "pi",
    action: "annotate",
    request: { markdown: "# Annotate\n\nPi annotation fixture.", filePath: "pi.md" },
  }),
  pluginScenario({
    id: "pi-archive",
    title: "Pi archive",
    origin: "pi",
    action: "archive",
    request: {},
  }),
  {
    id: "codex-plan-hook",
    title: "Codex Stop hook plan",
    kind: "hook",
    agent: "codex",
    expectedSessionMode: "plan",
    description: "Feeds a Codex Stop hook and resolves the plan from a fixture rollout file.",
    async buildFixture() {
      const fixture = await createWorkspaceFixture("codex-plan");
      return {
        cwd: fixture.root,
        stdin: JSON.stringify({
          hook_event_name: "Stop",
          turn_id: "turn-1",
          stop_hook_active: true,
        }),
        completion: "plan",
        cleanup: fixture.cleanup,
        env: {
          HOME: fixture.codexHome,
          CODEX_THREAD_ID: codexThreadId(),
        },
      };
    },
    buildCommand: (repoRoot, fixture) => command(repoRoot, fixture, []),
  },
  {
    id: "copilot-plan-hook",
    title: "Copilot plan hook",
    kind: "hook",
    agent: "copilot-cli",
    expectedSessionMode: "plan",
    description: "Runs the Copilot pre-tool hook against a local session-state fixture.",
    async buildFixture() {
      const fixture = await createWorkspaceFixture("copilot-plan");
      return {
        cwd: fixture.root,
        stdin: JSON.stringify({
          toolName: "exit_plan_mode",
          toolArgs: "{}",
          cwd: fixture.root,
          timestamp: Date.now(),
          sessionId: copilotSessionId(),
        }),
        completion: "plan",
        cleanup: fixture.cleanup,
        env: {
          HOME: fixture.root,
          COPILOT_HOME: fixture.copilotHome,
          COPILOT_CLI: "1",
        },
      };
    },
    buildCommand: (repoRoot, fixture) => command(repoRoot, fixture, ["copilot-plan"]),
  },
  {
    id: "gemini-plan-file-hook",
    title: "Gemini plan-file hook",
    kind: "hook",
    agent: "gemini-cli",
    expectedSessionMode: "plan",
    description: "Feeds a Gemini plan-file event and reads plan markdown from disk.",
    async buildFixture() {
      const fixture = await createWorkspaceFixture("gemini-plan");
      return {
        cwd: fixture.root,
        stdin: JSON.stringify({
          hook_event_name: "PermissionRequest",
          transcript_path: fixture.geminiTranscriptPath,
          session_id: fixture.geminiSessionId,
          tool_input: { plan_filename: fixture.geminiPlanFilename },
        }),
        completion: "plan",
        cleanup: fixture.cleanup,
        env: {
          HOME: fixture.root,
          GEMINI_CLI: "1",
        },
      };
    },
    buildCommand: (repoRoot, fixture) => command(repoRoot, fixture, []),
  },
  {
    id: "cli-review",
    title: "Direct CLI review",
    kind: "cli",
    agent: "direct-cli",
    expectedSessionMode: "review",
    description: "Runs plannotator review against a local git diff fixture.",
    buildFixture: async () => {
      const fixture = await workspace("cli-review");
      fixture.completion = "review";
      return fixture;
    },
    buildCommand: (repoRoot, fixture) => command(repoRoot, fixture, ["review"]),
  },
  {
    id: "cli-annotate",
    title: "Direct CLI annotate",
    kind: "cli",
    agent: "direct-cli",
    expectedSessionMode: "annotate",
    description: "Runs plannotator annotate against a markdown fixture.",
    async buildFixture() {
      const fixture = await createWorkspaceFixture("cli-annotate");
      return {
        cwd: fixture.root,
        completion: "annotate",
        cleanup: fixture.cleanup,
        env: { HOME: fixture.root },
      };
    },
    buildCommand: (repoRoot, fixture) =>
      command(repoRoot, fixture, ["annotate", "docs/notes.md", "--json"]),
  },
  {
    id: "cli-annotate-gate",
    title: "CLI annotate with gate",
    kind: "cli",
    agent: "direct-cli",
    expectedSessionMode: "annotate",
    description: "Runs plannotator annotate --gate, adding an Approve button alongside annotations.",
    async buildFixture() {
      const fixture = await createWorkspaceFixture("cli-annotate-gate");
      return {
        cwd: fixture.root,
        completion: "annotate",
        cleanup: fixture.cleanup,
        env: { HOME: fixture.root },
      };
    },
    buildCommand: (repoRoot, fixture) =>
      command(repoRoot, fixture, ["annotate", "docs/notes.md", "--gate", "--json"]),
  },
  {
    id: "cli-annotate-html",
    title: "CLI annotate --render-html",
    kind: "cli",
    agent: "direct-cli",
    expectedSessionMode: "annotate",
    description: "Runs plannotator annotate on an HTML file with --render-html (rendered as-is, not converted).",
    async buildFixture() {
      const fixture = await createWorkspaceFixture("cli-annotate-html");
      return {
        cwd: fixture.root,
        completion: "annotate",
        cleanup: fixture.cleanup,
        env: { HOME: fixture.root },
      };
    },
    buildCommand: (repoRoot, fixture) =>
      command(repoRoot, fixture, ["annotate", "docs/page.html", "--render-html", "--json"]),
  },
  {
    id: "cli-annotate-url",
    title: "CLI annotate URL (--no-jina)",
    kind: "cli",
    agent: "direct-cli",
    expectedSessionMode: "annotate",
    description: "Runs plannotator annotate on a URL with Jina disabled (uses fetch+Turndown fallback).",
    async buildFixture() {
      const fixture = await createWorkspaceFixture("cli-annotate-url");
      return {
        cwd: fixture.root,
        completion: "annotate",
        cleanup: fixture.cleanup,
        env: { HOME: fixture.root },
      };
    },
    buildCommand: (repoRoot, fixture) =>
      command(repoRoot, fixture, ["annotate", "https://example.com", "--no-jina", "--json"]),
  },
  {
    id: "cli-archive",
    title: "Direct CLI archive",
    kind: "cli",
    agent: "direct-cli",
    expectedSessionMode: "archive",
    description: "Runs plannotator archive and closes it through the session API.",
    buildFixture: async () => {
      const fixture = await workspace("cli-archive");
      fixture.completion = "archive";
      return fixture;
    },
    buildCommand: (repoRoot, fixture) => command(repoRoot, fixture, ["archive"]),
  },
];

export function getScenario(id: ScenarioId): ScenarioDefinition {
  const scenario = scenarioDefinitions.find((item) => item.id === id);
  if (!scenario) throw new Error(`Unknown simulator scenario: ${id}`);
  return scenario;
}
