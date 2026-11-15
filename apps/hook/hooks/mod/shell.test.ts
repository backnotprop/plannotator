import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { findGitBash, gitBashShell } from './git-bash'
import { powerShellShell } from './powershell'
import { pickShell, resolveShell, shellRuns, type ShellHost } from './shell'

const BASH = 'D:\\Apps\\Git\\bin\\bash.exe'
const POWERSHELL = 'E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

async function shellOn(env: Record<string, string>, files: string[]): Promise<string | null> {
  const host: ShellHost = { exists: async (path) => files.includes(path), env: async (name) => env[name] }
  const shell = await resolveShell(host)
  return shell ? (shell.argv('alive', 'kill -0 "$1"', 'plannotator-alive', ['1'])[0] as string) : null
}

describe('which Windows shell the mod picks', () => {
  // Windows and Git on other drives, so nothing passes by matching C:\.
  const windows = { OS: 'Windows_NT', SYSTEMROOT: 'E:\\Win', PROGRAMFILES: 'D:\\Apps' }

  test('Git Bash when it is there, Windows PowerShell when it is not', async () => {
    expect(await shellOn(windows, [BASH, POWERSHELL])).toBe(BASH)
    expect(await shellOn(windows, [POWERSHELL])).toBe(POWERSHELL)
  })

  test('PLANNOTATOR_MOD_SHELL holds Windows to one shell', async () => {
    expect(await shellOn({ ...windows, PLANNOTATOR_MOD_SHELL: 'powershell' }, [BASH, POWERSHELL])).toBe(POWERSHELL)
    expect(await shellOn({ ...windows, PLANNOTATOR_MOD_SHELL: 'PowerShell ' }, [BASH, POWERSHELL])).toBe(POWERSHELL)
    expect(await shellOn({ ...windows, PLANNOTATOR_MOD_SHELL: 'sh' }, [BASH, POWERSHELL])).toBe(BASH)
    // Asked for sh where there is none: inert, never PowerShell in its place.
    expect(await shellOn({ ...windows, PLANNOTATOR_MOD_SHELL: 'sh' }, [POWERSHELL])).toBeNull()
  })

  test('both Windows shells mark the host as Windows, so typed backslashes stay', async () => {
    const host = (files: string[]): ShellHost => ({ exists: async (path) => files.includes(path), env: async (name) => (windows as Record<string, string>)[name] })
    expect((await resolveShell(host([BASH])))?.windows).toBe(true)
    expect((await resolveShell(host([POWERSHELL])))?.windows).toBe(true)
  })

  test('elsewhere the variable changes nothing: /bin/sh', async () => {
    expect(await shellOn({ PLANNOTATOR_MOD_SHELL: 'powershell' }, ['/bin/sh'])).toBe('/bin/sh')
  })
})

describe('the shell a session keeps (pin) and the probe', () => {
  const windows = { OS: 'Windows_NT', SYSTEMROOT: 'E:\\Win', PROGRAMFILES: 'D:\\Apps' }
  const both = [BASH, POWERSHELL]

  /** A pick against fake shells: `broken` fail the probe; `pin` is the session's pin file. */
  async function pick(env: Record<string, string>, files: string[], options: { pin?: string; broken?: string[] } = {}) {
    const written: string[] = []
    const probed: string[] = []
    const host: ShellHost = { exists: async (path) => files.includes(path), env: async (name) => env[name] }
    const shell = await pickShell(host, {
      readPin: async () => options.pin ?? null,
      writePin: async (chosen) => void written.push(chosen.name as string),
      run: async (argv) => {
        probed.push(argv[0] as string)
        return (options.broken ?? []).includes(argv[0] as string) ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: 'ok\n' }
      },
    })
    return { shell: shell ? (shell.argv('alive', '', 't', [])[0] as string) : null, written, probed }
  }

  test('the first process pins what it picked; a later one keeps that pin over its own PLANNOTATOR_MOD_SHELL', async () => {
    expect(await pick(windows, both)).toEqual({ shell: BASH, written: ['sh'], probed: [BASH] })
    const later = await pick({ ...windows, PLANNOTATOR_MOD_SHELL: 'sh' }, both, { pin: 'powershell\n' })
    expect(later).toEqual({ shell: POWERSHELL, written: [], probed: [POWERSHELL] })
    // Pinned to Git Bash, which is gone: inert, never PowerShell in its place.
    expect((await pick(windows, [POWERSHELL], { pin: 'sh' })).shell).toBeNull()
    // A pin file that holds anything else is ignored.
    expect((await pick(windows, both, { pin: 'cmd' })).shell).toBe(BASH)
  })

  test('a shell that fails the probe gives way to the next; none left keeps the mod off', async () => {
    expect(await pick(windows, both, { broken: [BASH] })).toEqual({ shell: POWERSHELL, written: ['powershell'], probed: [BASH, POWERSHELL] })
    expect(await pick(windows, both, { broken: both })).toEqual({ shell: null, written: [], probed: both })
  })

  test('macOS and Linux: /bin/sh, with no probe and no pin', async () => {
    expect(await pick({}, ['/bin/sh'])).toEqual({ shell: '/bin/sh', written: [], probed: [] })
  })
})

// Both real Windows shells pass the probe on a machine that allows them.
const REAL_POWERSHELL = process.platform === 'win32' && process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : ''
describe.skipIf(!REAL_POWERSHELL || !existsSync(REAL_POWERSHELL))('the probe, run for real', () => {
  const run = async (argv: string[]) => {
    const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', windowsHide: true })
    return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout) }
  }

  test('Windows PowerShell passes it, and so does Git Bash where it is installed', async () => {
    expect(await shellRuns(powerShellShell(REAL_POWERSHELL), run)).toBe(true)
    const bash = await findGitBash({ exists: async (path) => existsSync(path), env: async (name) => process.env[name] })
    if (bash) expect(await shellRuns(gitBashShell(bash), run)).toBe(true)
  }, 30_000)

  test('a shell that cannot start fails it', async () => {
    expect(await shellRuns(powerShellShell(`${REAL_POWERSHELL}.missing`), run)).toBe(false)
  })
})
