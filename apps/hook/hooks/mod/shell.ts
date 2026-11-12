import { findGitBash, gitBashShell } from './git-bash'
import { powerShellShell } from './powershell'

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
  argv(id: ShellScriptId, posix: string, tag: string, args: readonly string[]): string[]
  readonly windows?: boolean
  readonly name?: WindowsShellName
}

export type WindowsShellName = 'sh' | 'powershell'

export const POSIX_SHELL: ModShell = {
  argv: (_id, posix, tag, args) => ['/bin/sh', '-c', posix, tag, ...args],
}

let active: ModShell = POSIX_SHELL

export function useShell(shell: ModShell): void {
  active = shell
}

export function onWindows(): boolean {
  return active.windows === true
}

export function shellArgv(id: ShellScriptId, posix: string, tag: string, args: readonly string[]): string[] {
  return active.argv(id, posix, tag, args)
}

export interface ShellHost {
  exists(path: string): Promise<boolean>
  env(name: string): Promise<string | undefined>
}

export async function resolveShell(host: ShellHost): Promise<ModShell | null> {
  return (await resolveShells(host))[0] ?? null
}

export async function resolveShells(host: ShellHost): Promise<ModShell[]> {
  if ((await host.env('OS')) !== 'Windows_NT') return (await host.exists('/bin/sh')) ? [POSIX_SHELL] : []
  const choice = (await host.env('PLANNOTATOR_MOD_SHELL'))?.trim().toLowerCase()
  const shells: ModShell[] = []
  if (choice !== 'powershell') {
    const bash = await findGitBash(host)
    if (bash) shells.push(gitBashShell(bash))
    if (choice === 'sh') return shells
  }
  for (const windows of [await host.env('SYSTEMROOT'), await host.env('WINDIR')]) {
    const path = windows && `${windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    if (path && (await host.exists(path))) {
      shells.push(powerShellShell(path))
      break
    }
  }
  return shells
}

export const PROBE_SCRIPT = "printf 'ok\\n'"

type RunResult = { exitCode: number; stdout: string } | undefined

export async function shellRuns(shell: ModShell, run: (argv: string[]) => Promise<RunResult>): Promise<boolean> {
  const result = await run(shell.argv('probe', PROBE_SCRIPT, 'plannotator-probe', [])).catch(() => undefined)
  return result?.exitCode === 0 && result.stdout.replace(/\r?\n$/, '') === 'ok'
}

export interface ShellPickIo {
  readPin(): Promise<string | null>
  writePin(shell: ModShell): Promise<void>
  run(argv: string[]): Promise<RunResult>
}

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
