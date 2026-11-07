/**
 * The shell the mod's scripts run in. `$.process.run` runs an argv with no
 * shell, so every file operation the engine has no call for (an atomic
 * `mkdir` claim, `rm`, an append, `kill`, a detached launch) is a short
 * script, run through the shell this host has. Each argv builder names its
 * script and gives its POSIX text; the active shell turns that into the argv.
 */

import { findGitBash, gitBashShell } from './git-bash'

/** Every script the mod runs, by the builder that runs it. */
export type ShellScriptId =
  | 'wait'
  | 'launch'
  | 'mkdir'
  | 'cleanup'
  | 'claim'
  | 'prune'
  | 'debug-append'
  | 'alive'
  | 'stop'
  | 'rm'
  | 'transcript-title'
  | 'inbox-claim'
  | 'inbox-release'
  | 'inbox-project'

export interface ModShell {
  /** The argv that runs script `id` with `args`; `posix` is its `sh` text and `tag` its `$0`. */
  argv(id: ShellScriptId, posix: string, tag: string, args: readonly string[]): string[]
  /** True for the Windows shells: the host is Windows, whatever the shell's own syntax. */
  readonly windows?: boolean
}

/** `/bin/sh`, as on every macOS and Linux host. */
export const POSIX_SHELL: ModShell = {
  argv: (_id, posix, tag, args) => ['/bin/sh', '-c', posix, tag, ...args],
}

let active: ModShell = POSIX_SHELL

/** Makes `shell` the one every argv builder uses; `session.start` sets it once `resolveShell` found one. */
export function useShell(shell: ModShell): void {
  active = shell
}

/** Whether the mod runs on Windows (through one of its Windows shells). */
export function onWindows(): boolean {
  return active.windows === true
}

/** The argv for script `id` in the active shell. */
export function shellArgv(id: ShellScriptId, posix: string, tag: string, args: readonly string[]): string[] {
  return active.argv(id, posix, tag, args)
}

/** What `resolveShell` asks the engine: whether a path exists, and an environment variable. */
export interface ShellHost {
  exists(path: string): Promise<boolean>
  env(name: string): Promise<string | undefined>
}

/**
 * The shell this host offers, or null when there is none and the mod stays
 * inert. On Windows (`OS` is `Windows_NT` in every Windows process) that is Git
 * Bash, never a `/bin/sh` that resolves to some file on the current drive.
 */
export async function resolveShell(host: ShellHost): Promise<ModShell | null> {
  if ((await host.env('OS')) === 'Windows_NT') {
    const bash = await findGitBash(host)
    return bash ? gitBashShell(bash) : null
  }
  return (await host.exists('/bin/sh')) ? POSIX_SHELL : null
}
