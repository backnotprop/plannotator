/**
 * The shell the mod's scripts run in. `$.process.run` runs an argv with no
 * shell, so every file operation the engine has no call for (an atomic
 * `mkdir` claim, `rm`, an append, `kill`, a detached launch) is a short
 * script, run through the shell this host has. Each argv builder names its
 * script and gives its POSIX text; the active shell turns that into the argv.
 */

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

/** The argv for script `id` in the active shell. */
export function shellArgv(id: ShellScriptId, posix: string, tag: string, args: readonly string[]): string[] {
  return active.argv(id, posix, tag, args)
}

/** What `resolveShell` asks the engine: whether a path exists, and an environment variable. */
export interface ShellHost {
  exists(path: string): Promise<boolean>
  env(name: string): Promise<string | undefined>
}

/** The shell this host offers, or null when there is none and the mod stays inert. */
export async function resolveShell(host: ShellHost): Promise<ModShell | null> {
  return (await host.exists('/bin/sh')) ? POSIX_SHELL : null
}
