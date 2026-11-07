import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findGitBash, gitBashShell } from './git-bash'
import { inboxProjectDirArgv } from './inbox'
import { launchArgv, privateDirArgv, STOP_EXIT, stopArgv } from './launch'
import { POSIX_SHELL, resolveShell, useShell, type ShellHost } from './shell'

function fakeHost(env: Record<string, string>, files: readonly string[]): ShellHost {
  return { exists: async (path) => files.includes(path), env: async (name) => env[name] }
}

describe('which shell the mod runs its scripts in', () => {
  // Installs on other drives and in other folders, so nothing passes by matching C:\Program Files.
  const windows = { OS: 'Windows_NT', PROGRAMFILES: 'D:\\Apps', LOCALAPPDATA: 'E:\\Profiles\\me\\AppData\\Local' }
  const machineWide = 'D:\\Apps\\Git\\bin\\bash.exe'
  const perUser = 'E:\\Profiles\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'

  test('Windows takes Git Bash, never a file that happens to sit at /bin/sh', async () => {
    const shell = await resolveShell(fakeHost(windows, ['/bin/sh', machineWide]))
    expect(shell?.argv('alive', 'kill -0 "$1"', 'plannotator-alive', ['1'])[0]).toBe(machineWide)
  })

  test('Windows without Git Bash has no shell, so the mod stays inert', async () => {
    expect(await resolveShell(fakeHost(windows, ['/bin/sh']))).toBeNull()
  })

  test('CLAUDE_CODE_GIT_BASH_PATH wins, then the git on PATH, then the machine-wide install, then the per-user one', async () => {
    const onPath = 'F:\\Tools\\PortableGit\\bin\\bash.exe'
    const env = { ...windows, PATH: 'C:\\Windows\\System32;"F:\\Tools\\PortableGit\\cmd\\"' }
    const all = ['G:\\bash.exe', onPath, 'F:\\Tools\\PortableGit\\cmd\\git.exe', machineWide, perUser]
    expect(await findGitBash(fakeHost({ ...env, CLAUDE_CODE_GIT_BASH_PATH: 'G:\\bash.exe' }, all))).toBe('G:\\bash.exe')
    expect(await findGitBash(fakeHost(env, all))).toBe(onPath)
    expect(await findGitBash(fakeHost(env, [machineWide, perUser]))).toBe(machineWide)
    expect(await findGitBash(fakeHost(env, [perUser]))).toBe(perUser)
    // Named but missing: the search goes on rather than trusting it.
    expect(await findGitBash(fakeHost({ ...env, CLAUDE_CODE_GIT_BASH_PATH: 'G:\\gone.exe' }, all))).toBe(onPath)
  })

  test("a PATH folder counts only in a Git for Windows install, so WSL's, Cygwin's and MSYS2's bash are never taken", async () => {
    const env = { OS: 'Windows_NT', PATH: 'C:\\Windows\\System32;D:\\Git\\mingw64\\bin' }
    expect(await findGitBash(fakeHost(env, ['C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\bin\\bash.exe']))).toBeNull()
    expect(await findGitBash(fakeHost(env, ['D:\\Git\\cmd\\git.exe', 'D:\\Git\\bin\\bash.exe']))).toBe('D:\\Git\\bin\\bash.exe')
    const cygwin = { OS: 'Windows_NT', PATH: 'C:\\cygwin64\\bin;C:\\msys64\\usr\\bin' }
    const others = ['C:\\cygwin64\\bin\\git.exe', 'C:\\cygwin64\\bin\\bash.exe', 'C:\\msys64\\usr\\bin\\git.exe', 'C:\\msys64\\usr\\bin\\bash.exe']
    expect(await findGitBash(fakeHost(cygwin, others))).toBeNull()
  })

  test('macOS and Linux keep /bin/sh', async () => {
    expect(await resolveShell(fakeHost({}, ['/bin/sh']))).toBe(POSIX_SHELL)
    expect(await resolveShell(fakeHost({}, []))).toBeNull()
  })
})

// The scripts that differ under Git Bash, run for real where it is installed, found as the mod finds it.
const GIT_BASH =
  process.platform === 'win32'
    ? ((await findGitBash({ exists: async (path) => existsSync(path), env: async (name) => process.env[name] })) ?? undefined)
    : undefined

describe.skipIf(!GIT_BASH)("Git Bash's own variants of the scripts", () => {
  const dirs: string[] = []
  const pids: string[] = []
  afterEach(() => {
    useShell(POSIX_SHELL)
    // inbox-guard: own child (a renamed copy of ping this test started, never an Inbox)
    for (const pid of pids.splice(0)) Bun.spawnSync(['taskkill', '/F', '/PID', pid])
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const scratch = () => {
    // Not named after the CLI: the stop check looks for "plannotator" in the whole command line.
    const dir = mkdtempSync(join(tmpdir(), 'pn-git-bash-'))
    dirs.push(dir)
    return dir
  }
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
    return { code: result.exitCode, out: result.stdout.toString().trim() }
  }

  /** A long-running native process named like the CLI, started the way the mod starts the CLI, with its MSYS pid. */
  function launchStandIn(name: string): { dir: string; pid: string } {
    const dir = scratch()
    const exe = join(dir, `${name}.exe`)
    copyFileSync(join(process.env.SystemRoot ?? process.env.windir ?? '', 'System32', 'PING.EXE'), exe)
    writeFileSync(join(dir, 'stdin'), '')
    useShell(gitBashShell(GIT_BASH as string))
    run(launchArgv(dir.replaceAll('\\', '/'), [exe, '-n', '30', '127.0.0.1']))
    for (let i = 0; i < 50 && !existsSync(join(dir, 'pid')); i++) Bun.sleepSync(100)
    const pid = readFileSync(join(dir, 'pid'), 'utf8').trim()
    const winpid = run([GIT_BASH as string, '-c', 'cat "/proc/$1/winpid"', 'x', pid]).out
    if (winpid) pids.push(winpid)
    return { dir, pid }
  }

  test('stop ends a running plannotator by its MSYS pid', () => {
    const { dir, pid } = launchStandIn('plannotator')
    expect(run(stopArgv(pid, [join(dir, 'result.json')])).code).toBe(STOP_EXIT.stopped)
    Bun.sleepSync(500)
    expect(run([GIT_BASH as string, '-c', 'kill -0 "$1" 2>/dev/null', 'x', pid]).code).not.toBe(0)
  })

  test('stop refuses a pid that is not plannotator, and leaves a decided review alone', () => {
    const other = launchStandIn('not-the-cli')
    expect(run(stopArgv(other.pid, [])).code).toBe(STOP_EXIT.notPlannotator)
    const decided = launchStandIn('plannotator')
    writeFileSync(join(decided.dir, 'result.json'), '{}')
    expect(run(stopArgv(decided.pid, [join(decided.dir, 'result.json')])).code).toBe(STOP_EXIT.decided)
  })

  test('the project folder and the launch folder come back as C:/… paths a native program can open', () => {
    useShell(gitBashShell(GIT_BASH as string))
    const dir = scratch()
    mkdirSync(join(dir, 'sub'))
    const want = dir.replaceAll('\\', '/')
    expect(run(inboxProjectDirArgv(tmpdir(), dir))).toEqual({ code: 0, out: want })
    expect(run(inboxProjectDirArgv(dir, 'sub'))).toEqual({ code: 0, out: `${want}/sub` })
    expect(run(inboxProjectDirArgv(dir, 'missing')).code).toBe(3)
    expect(run(privateDirArgv(join(dir, 'private'))).out).toMatch(/^[A-Za-z]:\//)
  })
})
