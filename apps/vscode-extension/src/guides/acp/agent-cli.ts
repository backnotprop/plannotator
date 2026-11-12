import { CLAUDE_CODE, CODEX, resolveAgentLaunch, type AdapterResolution, type AgentDescriptor, type CommandOverride, type ManagedLaunch } from "@plannotator/acp-client/agents";
import type { AgentLaunch } from "@plannotator/acp-client/client";
import { isSameProgram, type SameProgramCheck } from "@plannotator/acp-client/same-program";
import { findExecutable } from "../sources/runner";

export type ReadyResolution = Extract<AdapterResolution, { ok: true }>;

export interface AgentCli {
  command: string;
  env: string;
  label: string;
}

export const AGENT_CLIS: Readonly<Record<string, AgentCli>> = {
  [CLAUDE_CODE.id]: { command: "claude", env: "CLAUDE_CODE_EXECUTABLE", label: "Claude Code" },
  [CODEX.id]: { command: "codex", env: "CODEX_PATH", label: "Codex" },
};

export interface CliChoice {
  env?: Record<string, string | undefined>;
  useInstalled?: boolean;
}

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

export function agentLaunchFor(launch: ReadyResolution, cwd: string): AgentLaunch {
  return { command: launch.command, args: launch.args, cwd, ...(launch.env && { env: launch.env }), ...(launch.startHint && { startHint: launch.startHint }) };
}
