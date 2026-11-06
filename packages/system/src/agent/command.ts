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
 * What a Claude Code redraw may do with no one to ask: read, search and edit
 * files in its folder, read git, and run the drawing's check and gate. Any
 * other tool is refused (`--permission-mode dontAsk`), so a redraw cannot
 * push, open a pull request, reach the network or run a script the repo
 * ships. Doc sites are opened only by their host, one rule each.
 */
export const CLAUDE_REDRAW_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'MultiEdit', 'Write',
  'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git ls-files:*)', 'Bash(git ls-tree:*)',
  'Bash(git rev-parse:*)', 'Bash(grep:*)', 'Bash(plannotator system check:*)', 'Bash(plannotator system gate:*)',
] as const;

/**
 * The command that runs one unattended redraw with the agent and model the
 * person chose in setup. `docs` are the doc sites already passed through
 * `unattendedDocs`. The prompt goes on stdin where the agent reads it there
 * (Claude Code and Pi), else as the last argument (OpenCode's `run`).
 */
export function redrawCommand(setup: Pick<SystemSetup, 'agent' | 'model'>, prompt: string, o: { docs?: readonly string[] } = {}): { command: string[]; stdin: string | null } {
  const model = agentModel(setup.agent, setup.model);
  const withModel = model ? ['--model', model] : [];
  if (setup.agent === 'claude') {
    const hosts = [...new Set((o.docs ?? []).map((d) => new URL(d).hostname))];
    const tools = [...CLAUDE_REDRAW_TOOLS, ...hosts.map((h) => `WebFetch(domain:${h})`)];
    return {
      command: ['claude', '-p', '--permission-mode', 'dontAsk', '--allowedTools', tools.join(','), '--no-session-persistence', ...withModel],
      stdin: prompt,
    };
  }
  if (setup.agent === 'pi') return { command: ['pi', '--no-session', ...withModel, '-p'], stdin: prompt };
  return { command: ['opencode', 'run', ...withModel, prompt], stdin: null };
}
