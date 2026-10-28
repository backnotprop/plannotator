/**
 * Guided Reviews runs the user's own Claude Code / Codex CLI through their ACP
 * adapters. Kept in the extension (not the shared `@plannotator/acp-client`):
 * it is Guides' choice, with Guides' setting and wording; the Inbox's runner
 * resolves its agents without it.
 */

import { CLAUDE_CODE, CODEX, resolveAgentLaunch, type AdapterResolution, type AgentDescriptor, type CommandOverride, type ManagedLaunch } from "@plannotator/acp-client/agents";
import type { AgentLaunch } from "@plannotator/acp-client/client";
import { isSameProgram, type SameProgramCheck } from "@plannotator/acp-client/same-program";
import { findExecutable } from "../sources/runner";

export type ReadyResolution = Extract<AdapterResolution, { ok: true }>;

/** An adapter's agent CLI, which it runs only when the environment variable `env` names it. */
export interface AgentCli {
  command: string;
  env: string;
  label: string;
}

/**
 * Without the variable, the adapter runs the copy it brings: claude-agent-acp
 * the Agent SDK's bundled Claude, codex-acp its `@openai/codex` dependency.
 */
export const AGENT_CLIS: Readonly<Record<string, AgentCli>> = {
  // claude-agent-acp 0.91.0 runs `CLAUDE_CODE_EXECUTABLE` when set (dist/acp-agent.js: `claudeCliPath`, and `pathToClaudeCodeExecutable` for each session).
  [CLAUDE_CODE.id]: { command: "claude", env: "CLAUDE_CODE_EXECUTABLE", label: "Claude Code" },
  // codex-acp 2.2.2 runs `CODEX_PATH` when set (dist/index.js: `startAcpServer`, and the `cli` subcommand).
  [CODEX.id]: { command: "codex", env: "CODEX_PATH", label: "Codex" },
};

/** How an adapter's agent CLI is chosen (`withAgentCli`). */
export interface CliChoice {
  /** The environment the adapter inherits: a variable already set there is kept. Default: this process's. */
  env?: Record<string, string | undefined>;
  /** `plannotator.guides.useInstalledCli` (default on); off: the adapter runs its own copy. */
  useInstalled?: boolean;
}

/** `resolveAgentLaunch`, then the user's own CLI for an adapter that runs one (`withAgentCli`). */
export function resolveGuidesLaunch(
  agent: AgentDescriptor,
  override: CommandOverride = {},
  find: (name: string) => string | null = findExecutable,
  managed: (agent: AgentDescriptor) => ManagedLaunch | null = () => null,
  platform: NodeJS.Platform = process.platform,
  sameProgram: SameProgramCheck = isSameProgram,
  choice: CliChoice = {},
): AdapterResolution {
  const launch = resolveAgentLaunch(agent, override, find, managed, platform, sameProgram);
  return launch.ok ? withAgentCli(agent, launch, find, platform, choice) : launch;
}

/**
 * Point the adapter at the user's own CLI (`claude`, `codex`), found the same
 * way as the adapter (PATH plus the usual install folders), so a guide runs
 * the Claude or Codex the user installed and configured. A variable the user
 * already set is left alone, and `useInstalled: false` keeps the adapter's
 * own copy. When the CLI is not found the adapter runs the copy it brings, as
 * it did before: someone who uses only the Claude Code VS Code extension has
 * no `claude` on PATH, and their guides keep working.
 *
 * Windows: only an `.exe` is used; a `.cmd` / `.bat` (what npm installs:
 * `%APPDATA%\npm\claude.cmd`) keeps the adapter's own copy. claude-agent-acp
 * 0.91.0 starts the path without a shell (the SDK's spawn, the `--cli`
 * sign-in, `auth status`), which Node refuses for a `.cmd`. codex-acp 2.2.2
 * starts its app-server through cross-spawn, but its `cli` subcommand uses
 * `shell: true` with the path unquoted, which breaks on a path with spaces.
 */
export function withAgentCli(
  agent: AgentDescriptor,
  launch: ReadyResolution,
  find: (name: string) => string | null,
  platform: NodeJS.Platform = process.platform,
  choice: CliChoice = {},
): ReadyResolution {
  const cli = AGENT_CLIS[agent.id];
  if (!cli) return launch;
  const env = choice.env ?? process.env;
  const own = `the copy of ${cli.label} that comes with ${agent.label}'s ACP adapter`;
  const mine = env[cli.env]?.trim();
  if (mine) return { ...launch, cliLog: `${agent.label} runs ${mine} (${cli.env}, set in your environment).` };
  if (choice.useInstalled === false) return { ...launch, cliLog: `${agent.label} runs ${own} (plannotator.guides.useInstalledCli is off).` };
  const found = find(cli.command);
  if (!found) return { ...launch, cliLog: `\`${cli.command}\` is not on PATH, so ${agent.label} runs ${own}. Install the ${cli.label} CLI to use your own version.` };
  if (platform === "win32" && !/\.exe$/i.test(found)) {
    return { ...launch, cliLog: `${found} is not an .exe, which the adapter cannot start on Windows, so ${agent.label} runs ${own}. Install ${cli.label}'s native ${cli.command}.exe, or set ${cli.env} to an .exe, to use your own.` };
  }
  return {
    ...launch,
    env: { ...launch.env, [cli.env]: found },
    cliLog: `${agent.label} runs your ${cli.command} at ${found} (${cli.env}).`,
    startHint: `Guided Reviews ran your ${cli.command} at ${found}; it may be older than ${agent.label}'s ACP adapter expects. Update it, or turn off plannotator.guides.useInstalledCli to use ${own}.`,
  };
}

/** What `AcpClient.start` needs to start a resolved agent in `cwd`. */
export function agentLaunchFor(launch: ReadyResolution, cwd: string): AgentLaunch {
  return { command: launch.command, args: launch.args, cwd, ...(launch.env && { env: launch.env }), ...(launch.startHint && { startHint: launch.startHint }) };
}
