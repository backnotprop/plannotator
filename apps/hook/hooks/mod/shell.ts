/**
 * The shell the mod's scripts run in. `$.process.run` runs an argv with no
 * shell, so every file operation the engine has no call for (an atomic
 * `mkdir` claim, `rm`, an append, `kill`, a detached launch) is a short
 * script, run through the shell this host has. Each argv builder names its
 * script and gives its POSIX text; the active shell turns that into the argv.
 */

import { findGitBash, gitBashShell } from './git-bash'
import { powerShellShell } from './powershell'

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
  | 'transcript-forked-from'
  | 'transcript-continued-in'
  | 'inbox-claim'
  | 'inbox-release'
  | 'inbox-project'
  | 'probe'

export interface ModShell {
  /** The argv that runs script `id` with `args`; `posix` is its `sh` text and `tag` its `$0`. */
  argv(id: ShellScriptId, posix: string, tag: string, args: readonly string[]): string[]
  /** True for the Windows shells: the host is Windows, whatever the shell's own syntax. */
  readonly windows?: boolean
  /** A Windows shell's `PLANNOTATOR_MOD_SHELL` value, which the session's pin records. */
  readonly name?: WindowsShellName
}

/** `PLANNOTATOR_MOD_SHELL`'s values, and what a session's pin file holds. */
export type WindowsShellName = 'sh' | 'powershell'

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
 * inert. On Windows (`OS` is `Windows_NT` in every Windows process) that is
 * Git Bash where it is installed, since its scripts are the POSIX ones and each
 * call is about 15 times faster, else Windows PowerShell, which every Windows
 * 10 and 11 has. It is never a `/bin/sh` that resolves to some file on the
 * current drive. `PLANNOTATOR_MOD_SHELL` (`sh` or `powershell`) holds Windows
 * to one of the two, and `sh` without Git Bash leaves the mod inert.
 */
export async function resolveShell(host: ShellHost): Promise<ModShell | null> {
  return (await resolveShells(host))[0] ?? null
}

/** Every shell `resolveShell` could pick, best first. */
export async function resolveShells(host: ShellHost): Promise<ModShell[]> {
  if ((await host.env('OS')) !== 'Windows_NT') return (await host.exists('/bin/sh')) ? [POSIX_SHELL] : []
  const choice = (await host.env('PLANNOTATOR_MOD_SHELL'))?.trim().toLowerCase()
  const shells: ModShell[] = []
  if (choice !== 'powershell') {
    const bash = await findGitBash(host)
    if (bash) shells.push(gitBashShell(bash))
    if (choice === 'sh') return shells
  }
  // The Windows folder comes from the environment: Windows may sit on any drive.
  for (const windows of [await host.env('SYSTEMROOT'), await host.env('WINDIR')]) {
    const path = windows && `${windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    if (path && (await host.exists(path))) {
      shells.push(powerShellShell(path))
      break
    }
  }
  return shells
}

/** The probe's POSIX text: it prints `ok`. */
export const PROBE_SCRIPT = "printf 'ok\\n'"

/** A script run's result, as `$.process.run` gives it; undefined when it could not run at all. */
type RunResult = { exitCode: number; stdout: string } | undefined

/**
 * Whether `shell` really runs the mod's scripts. A PowerShell under
 * Constrained Language Mode (AppLocker, WDAC) refuses the .NET calls they make,
 * and some security products block a hidden `-EncodedCommand` run outright.
 */
export async function shellRuns(shell: ModShell, run: (argv: string[]) => Promise<RunResult>): Promise<boolean> {
  const result = await run(shell.argv('probe', PROBE_SCRIPT, 'plannotator-probe', [])).catch(() => undefined)
  return result?.exitCode === 0 && result.stdout.replace(/\r?\n$/, '') === 'ok'
}

/** What `pickShell` needs from the engine besides the environment. */
export interface ShellPickIo {
  /** The session's pin file, or null when there is none. */
  readPin(): Promise<string | null>
  /** Records `shell` as the session's, for its later processes. */
  writePin(shell: ModShell): Promise<void>
  run(argv: string[]): Promise<RunResult>
}

/**
 * The shell for this session, or null to stay inert. Every Claude Code process
 * on one session uses the same Windows shell: the first records its pick, and
 * later ones take it over their own `PLANNOTATOR_MOD_SHELL`, since the two
 * shells claim a decision differently and number processes differently. A
 * Windows shell must also pass the probe (`shellRuns`); one that fails gives
 * way to the next, and none leaves the mod off. macOS and Linux skip both.
 */
export async function pickShell(host: ShellHost, io: ShellPickIo): Promise<ModShell | null> {
  const read = (await io.readPin().catch(() => null))?.trim()
  const pinned = read === 'sh' || read === 'powershell' ? read : undefined
  const env = pinned ? async (name: string) => (name === 'PLANNOTATOR_MOD_SHELL' ? pinned : host.env(name)) : host.env
  for (const shell of await resolveShells({ exists: host.exists, env })) {
    if (shell.windows && !(await shellRuns(shell, io.run))) continue
    if (shell.name && !pinned) await io.writePin(shell).catch(() => undefined)
    return shell
  }
  return null
}
