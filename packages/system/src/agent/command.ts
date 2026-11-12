import { agentModel } from './model.ts';
import type { SystemSetup } from './setup.ts';
export { LOCKFILE_NAMES, TEST_FOLDERS } from '../gate/gate.ts';

export const SYSTEM_COMMANDS = {
  check: 'plannotator system check [--root <repo folder>] [--dir <drawing folder>] [--repo <alias>=<folder>]... [--at <commit>] [--json]',
  gate: 'plannotator system gate [--project <repo folder>] [--dir <drawing folder>] --from <commit> --to <commit>',
  tick: 'plannotator system tick --project <repo folder> --key <project key>',
  revision: 'plannotator system revision --project <repo folder> --pr <host/owner/repo#n> --head <commit> -',
  schedule: 'plannotator system schedule install --project <repo folder> --key <project key> | remove --key <project key> | list',
} as const;

export type SystemSubcommand = keyof typeof SYSTEM_COMMANDS;

export const SYSTEM_TICK_INTERVAL_SECONDS = 15 * 60;

export function redrawCommand(setup: Pick<SystemSetup, 'agent' | 'model'>, prompt: string): { command: string[]; stdin: string | null } {
  const model = agentModel(setup.agent, setup.model);
  const withModel = model ? ['--model', model] : [];
  if (setup.agent === 'claude') {
    return { command: ['claude', '-p', '--permission-mode', 'bypassPermissions', '--no-session-persistence', ...withModel], stdin: prompt };
  }
  if (setup.agent === 'pi') return { command: ['pi', '--no-session', ...withModel, '-p'], stdin: prompt };
  return { command: ['opencode', 'run', ...withModel, prompt], stdin: null };
}
