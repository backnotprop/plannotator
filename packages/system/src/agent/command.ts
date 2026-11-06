// How the scheduled redraw starts the person's own agent, headless, and the
// `plannotator system` command the recipes call.
import { agentModel } from './model.ts';
import type { SystemSetup } from './setup.ts';

/**
 * The `plannotator system` subcommands the recipes and the scheduled job
 * call. The command itself is a thin file over this package
 * (`apps/hook/server/system-command.ts`, step A7); its help prints these lines.
 * Every command prints one JSON value on stdout and nothing on failure,
 * writes `<code>: <message>` on stderr, and exits 0 ok, 1 failed, 2 bad usage,
 * as `plannotator inbox call` does.
 */
export const SYSTEM_COMMANDS = {
  check: 'plannotator system check [--root <repo folder>] [--dir <drawing folder>] [--repo <alias>=<folder>]... [--at <commit>] [--json]',
  gate: 'plannotator system gate [--project <repo folder>] --from <commit> --to <commit>',
  tick: 'plannotator system tick --project <repo folder> --key <project key>',
  revision: 'plannotator system revision --project <repo folder> --pr <host/owner/repo#n> --head <commit> -',
  schedule: 'plannotator system schedule install --project <repo folder> --key <project key> | remove --key <project key> | list',
} as const;

export type SystemSubcommand = keyof typeof SYSTEM_COMMANDS;

/**
 * The command that runs one unattended redraw with the agent and model the
 * person chose in setup. The agent runs as it normally does, with its full
 * tools and the project's own settings and MCP servers (owner ruling
 * 2026-11-06: no limits on agents). Claude Code runs with
 * `--permission-mode bypassPermissions`, so a run with nobody there never
 * stops on a permission prompt. The prompt goes on stdin where the agent
 * reads it there (Claude Code and Pi), else as the last argument (OpenCode's
 * `run`).
 */
export function redrawCommand(setup: Pick<SystemSetup, 'agent' | 'model'>, prompt: string): { command: string[]; stdin: string | null } {
  const model = agentModel(setup.agent, setup.model);
  const withModel = model ? ['--model', model] : [];
  if (setup.agent === 'claude') {
    return { command: ['claude', '-p', '--permission-mode', 'bypassPermissions', '--no-session-persistence', ...withModel], stdin: prompt };
  }
  if (setup.agent === 'pi') return { command: ['pi', '--no-session', ...withModel, '-p'], stdin: prompt };
  return { command: ['opencode', 'run', ...withModel, prompt], stdin: null };
}
