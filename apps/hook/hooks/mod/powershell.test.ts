import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inboxClaimArgv, inboxProjectDirArgv, inboxReleaseArgv, TRANSCRIPT_TITLE_SCRIPT, transcriptTitleOf } from './inbox'
import {
  aliveArgv,
  CLAIM_EXIT,
  claimArgv,
  cleanupArgv,
  DEBUG_LOG_MAX_BYTES,
  debugAppendArgv,
  launchArgv,
  LAUNCH_FILES,
  privateDirArgv,
  pruneArgvs,
  pruneArgv,
  removeFileArgv,
  SETTLED_BY,
  SETTLED_DIR,
  STOP_EXIT,
  stopArgv,
  waitArgv,
} from './launch'
import { encodePowerShell, powerShellScript, powerShellShell } from './powershell'
import { POSIX_SHELL, resolveShell, shellArgv, useShell, type ShellHost } from './shell'

describe('the PowerShell shell, on any host', () => {
  test('-EncodedCommand is UTF-16LE base64, non-ASCII and surrogate pairs included', () => {
    for (const text of ['', 'a', 'ab', 'abc', "Write-Output 'é ✓ 😀'", 'C:\\Users\\Zoë\\repo']) {
      expect(encodePowerShell(text)).toBe(Buffer.from(text, 'utf16le').toString('base64'))
    }
  })

  test("it uses launch.ts's names: the claim folder, the overflow file and the debug log's cap", () => {
    // powershell.ts imports nothing from launch.ts, so a rename there must reach here.
    expect(SETTLED_BY).toBe(`${SETTLED_DIR}/by`)
    expect(powerShellScript('claim', [])).toContain(`'${SETTLED_DIR}'`)
    expect(powerShellScript('cleanup', [])).toContain(`'${LAUNCH_FILES.overflow}'`)
    expect(powerShellScript('debug-append', [])).toContain(`-gt ${DEBUG_LOG_MAX_BYTES}`)
  })

  test('prune splits into calls that each fit a Windows command line, every folder in its group', () => {
    const dirs = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `C:\\Users\\someone-with-a-long-name\\.plannotator\\claude-code-mod\\${tag}-session-${i}\\1794089445458-1-e1bfda`)
    const groups = { cleaned: dirs(50, 'c'), dead: dirs(50, 'd'), expired: dirs(50, 'e') }
    useShell(powerShellShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
    try {
      const calls = pruneArgvs(groups)
      expect(calls.length).toBeGreaterThan(1)
      for (const argv of calls) expect(argv.join(' ').length).toBeLessThan(32_767)
    } finally {
      useShell(POSIX_SHELL)
    }
    // Under /bin/sh the words are readable: with a small budget, the batches hold every folder once, under its own flag.
    const seen = { cleaned: [] as string[], dead: [] as string[], expired: [] as string[] }
    const calls = pruneArgvs(groups, 4_000)
    expect(calls.length).toBeGreaterThan(1)
    for (const argv of calls) {
      let mode: keyof typeof seen = 'cleaned'
      for (const word of argv.slice(4)) {
        if (word.startsWith('--')) mode = word.slice(2) as keyof typeof seen
        else seen[mode].push(word)
      }
    }
    expect(seen).toEqual(groups)
    expect(pruneArgvs({ cleaned: ['/a'], dead: [], expired: [] })).toHaveLength(1)
  })

  test('Windows takes powershell.exe, never a file that happens to sit at /bin/sh; elsewhere /bin/sh stays', async () => {
    const host = (env: Record<string, string>, files: string[]): ShellHost => ({ exists: async (p) => files.includes(p), env: async (n) => env[n] })
    // Windows on another drive, so nothing passes by matching C:\Windows.
    const ps = 'E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const shell = await resolveShell(host({ OS: 'Windows_NT', SYSTEMROOT: 'E:\\Win' }, ['/bin/sh', ps]))
    expect(shell?.argv('alive', '', 'plannotator-alive', ['1'])[0]).toBe(ps)
    // No SYSTEMROOT: WINDIR names the same folder.
    expect((await resolveShell(host({ OS: 'Windows_NT', WINDIR: 'E:\\Win' }, [ps])))?.argv('alive', '', 't', ['1'])[0]).toBe(ps)
    // Neither: no folder to look in, so no shell, never a guessed C:\Windows.
    expect(await resolveShell(host({ OS: 'Windows_NT' }, [ps, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']))).toBeNull()
    expect(await resolveShell(host({ OS: 'Windows_NT' }, ['/bin/sh']))).toBeNull()
    expect(await resolveShell(host({}, ['/bin/sh']))).toBe(POSIX_SHELL)
  })
})

const WINDOWS = process.platform === 'win32' ? (process.env.SystemRoot ?? process.env.windir ?? '') : ''
const POWERSHELL = WINDOWS && join(WINDOWS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

// Every script's twin, run for real. Each contract below is the POSIX script's.
// Every call starts a fresh powershell.exe (about 0.2 s idle, seconds under load), and a test makes up to ten.
setDefaultTimeout(30_000)

describe.skipIf(!POWERSHELL || !existsSync(POWERSHELL))('the PowerShell twins of the scripts', () => {
  const dirs: string[] = []
  const pids: string[] = []
  afterEach(() => {
    useShell(POSIX_SHELL)
    // inbox-guard: own child (a renamed copy of ping this test started, never an Inbox)
    for (const pid of pids.splice(0)) Bun.spawnSync(['taskkill', '/F', '/PID', pid])
    for (const dir of dirs.splice(0)) {
      // The hidden watcher writes `exit` after its CLI ends and holds the stream files until then.
      for (let i = 0; i < 50 && existsSync(join(dir, 'pid')) && !existsSync(join(dir, 'exit')); i++) Bun.sleepSync(100)
      for (let i = 0; i < 20; i++) {
        try {
          rmSync(dir, { recursive: true, force: true })
          break
        } catch {
          Bun.sleepSync(100)
        }
      }
    }
  })
  // Not named after the CLI: the stop check looks for "plannotator" in the whole command line.
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-ps-'))
    dirs.push(dir)
    return dir
  }
  // windowsHide: no console, as under Claude Code. With one, stdin and stdout
  // decode in the console's code page, which can hide an encoding bug.
  const run = (argv: string[], stdin?: string) => {
    useShell(powerShellShell(POWERSHELL))
    const result = Bun.spawnSync(argv, { stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe', windowsHide: true })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  const ps = () => {
    useShell(powerShellShell(POWERSHELL))
  }

  test('claim: one winner; the same claimant again wins; another loses; a cleaned-up launch or a missing one loses', () => {
    ps()
    const dir = scratch()
    writeFileSync(join(dir, 'stdin'), '')
    expect(run(claimArgv(dir, 'me')).code).toBe(CLAIM_EXIT.won)
    expect(readFileSync(join(dir, SETTLED_BY), 'utf8')).toBe('me')
    expect(run(claimArgv(dir, 'me')).code).toBe(CLAIM_EXIT.won)
    expect(run(claimArgv(dir, 'other')).code).toBe(CLAIM_EXIT.lost)
    const cleaned = scratch()
    expect(run(claimArgv(cleaned, 'me')).code).toBe(CLAIM_EXIT.lost)
    expect(run(claimArgv(join(cleaned, 'gone'), 'me')).code).toBe(CLAIM_EXIT.lost)
  })

  test("Inbox claim and release: one winner, and only the winner's undelivered claim is released", () => {
    ps()
    const claim = join(scratch(), 'claims', 'msg_1')
    expect(run(inboxClaimArgv(claim, 'me')).code).toBe(0)
    expect(run(inboxClaimArgv(claim, 'me')).code).toBe(0)
    expect(run(inboxClaimArgv(claim, 'other')).code).toBe(3)
    expect(run(inboxReleaseArgv(claim, 'other')).code).toBe(0)
    expect(existsSync(claim)).toBe(true)
    writeFileSync(join(claim, 'delivered'), '')
    run(inboxReleaseArgv(claim, 'me'))
    expect(existsSync(claim)).toBe(true)
    rmSync(join(claim, 'delivered'))
    run(inboxReleaseArgv(claim, 'me'))
    expect(existsSync(claim)).toBe(false)
  })

  test('prune: cleaned up or delivered goes; a live or decided one stays until its mode allows', () => {
    ps()
    const base = scratch()
    const make = (name: string, files: string[]) => {
      const d = join(base, name)
      mkdirSync(join(d, SETTLED_DIR), { recursive: true })
      for (const f of files) writeFileSync(join(d, f), f === 'pid' ? '999999' : '')
      return d
    }
    const cleaned = join(base, 'cleaned')
    mkdirSync(cleaned)
    const delivered = make('delivered', ['stdin', 'result.json', `${SETTLED_DIR}/delivered`])
    const claimedUndelivered = make('claimed', ['stdin', 'result.json'])
    rmSync(join(base, 'claimed', SETTLED_DIR), { recursive: true })
    mkdirSync(join(base, 'claimed', SETTLED_DIR))
    const deadDecided = join(base, 'dead-decided')
    mkdirSync(deadDecided)
    for (const f of ['stdin', 'pid', 'exit']) writeFileSync(join(deadDecided, f), f === 'pid' ? '999999' : '')
    const deadUndecided = join(base, 'dead-undecided')
    mkdirSync(deadUndecided)
    for (const f of ['stdin', 'pid']) writeFileSync(join(deadUndecided, f), '999999')
    const lines = (out: string) => out.split('\n').map((l) => l.trim()).filter(Boolean).sort()
    const all = [cleaned, delivered, claimedUndelivered, deadDecided, deadUndecided]
    expect(lines(run(pruneArgv({ cleaned: all, dead: [], expired: [] })).out)).toEqual([cleaned, delivered].sort())
    expect(lines(run(pruneArgv({ cleaned: [], dead: all, expired: [] })).out)).toEqual([cleaned, delivered, deadUndecided].sort())
    expect(lines(run(pruneArgv({ cleaned: [], dead: [], expired: all })).out)).toEqual(all.slice().sort())
  })

  test('launch returns at once; the CLI is alive, stop ends it, and its exit code lands', () => {
    ps()
    const dir = scratch()
    const exe = join(dir, 'plannotator.exe')
    copyFileSync(join(WINDOWS, 'System32', 'PING.EXE'), exe)
    writeFileSync(join(dir, 'stdin'), '')
    const started = Date.now()
    expect(run(launchArgv(dir, [exe, '-n', '30', '127.0.0.1'])).code).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
    for (let i = 0; i < 100 && !existsSync(join(dir, 'pid')); i++) Bun.sleepSync(100)
    const pid = readFileSync(join(dir, 'pid'), 'utf8').trim()
    pids.push(pid)
    expect(run(aliveArgv(pid)).code).toBe(0)
    expect(run(stopArgv(pid, [join(dir, 'result.json')])).code).toBe(STOP_EXIT.stopped)
    for (let i = 0; i < 100 && !existsSync(join(dir, 'exit')); i++) Bun.sleepSync(100)
    expect(existsSync(join(dir, 'exit'))).toBe(true)
    expect(run(aliveArgv(pid)).code).not.toBe(0)
  })

  test("stop refuses a pid that is not plannotator, and a decided review's", () => {
    ps()
    const dir = scratch()
    const exe = join(dir, 'not-the-cli.exe')
    copyFileSync(join(WINDOWS, 'System32', 'PING.EXE'), exe)
    writeFileSync(join(dir, 'stdin'), '')
    run(launchArgv(dir, [exe, '-n', '30', '127.0.0.1']))
    for (let i = 0; i < 100 && !existsSync(join(dir, 'pid')); i++) Bun.sleepSync(100)
    const pid = readFileSync(join(dir, 'pid'), 'utf8').trim()
    pids.push(pid)
    expect(run(stopArgv(pid, [])).code).toBe(STOP_EXIT.notPlannotator)
    writeFileSync(join(dir, 'result.json'), '{}')
    expect(run(stopArgv(pid, [join(dir, 'result.json')])).code).toBe(STOP_EXIT.decided)
  })

  test('an argument with quotes, spaces, a trailing backslash or nothing at all reaches the CLI whole', () => {
    ps()
    const dir = scratch()
    writeFileSync(join(dir, 'stdin'), 'from stdin')
    const node = Bun.which('node')
    if (!node) return
    const script = join(dir, 'echo.js')
    writeFileSync(script, "process.argv.slice(2).forEach((a) => console.log(JSON.stringify(a))); let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => console.log(JSON.stringify(s)))")
    const args = ['plain', 'has space', 'quote"inside', "it's", 'trailing\\', '']
    run(launchArgv(dir, [node, script, ...args]))
    for (let i = 0; i < 100 && !existsSync(join(dir, 'exit')); i++) Bun.sleepSync(100)
    const seen = readFileSync(join(dir, 'stdout'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(seen).toEqual([...args, 'from stdin'])
    expect(readFileSync(join(dir, 'exit'), 'utf8').trim()).toBe('0')
  })

  test('wait, mkdir, rm and cleanup', () => {
    ps()
    const dir = scratch()
    expect(run(waitArgv([join(dir, 'never')], 300)).code).toBe(1)
    writeFileSync(join(dir, 'ready'), '')
    expect(run(waitArgv([join(dir, 'never'), join(dir, 'ready')], 300)).code).toBe(0)
    const made = run(privateDirArgv(join(dir, 'a', 'b')))
    expect(made.code).toBe(0)
    expect(existsSync(join(dir, 'a', 'b'))).toBe(true)
    expect(made.out).toBe(`${process.cwd()}\n`)
    run(removeFileArgv(join(dir, 'ready')))
    expect(existsSync(join(dir, 'ready'))).toBe(false)
    const launch = join(dir, 'launch')
    mkdirSync(join(launch, SETTLED_DIR), { recursive: true })
    for (const f of ['stdin', 'pid', 'exit', SETTLED_BY]) writeFileSync(join(launch, f), '')
    expect(run(cleanupArgv(launch)).code).toBe(0)
    expect(existsSync(launch)).toBe(false)
  })

  test('debug append: stdin is appended, as UTF-8', () => {
    ps()
    const log = join(scratch(), 'logs', 'debug.log')
    run(debugAppendArgv(log), 'one ✓\n')
    run(debugAppendArgv(log), 'two\n')
    expect(readFileSync(log, 'utf8')).toBe('one ✓\ntwo\n')
  })

  test("transcript title: the region's titles and counts read as the POSIX script's", () => {
    ps()
    const path = join(scratch(), 'session.jsonl')
    const title = JSON.stringify({ type: 'custom-title', customTitle: 'Windows ✓', sessionId: 's1' })
    const text = `{"type":"user"}\n${title}\n{"type":"assistant","partial":`
    writeFileSync(path, text)
    const length = Buffer.byteLength(text)
    const result = run(shellArgv('transcript-title', TRANSCRIPT_TITLE_SCRIPT, 'sh', ['1', path, String(length)]))
    expect(result.code).toBe(0)
    const found = transcriptTitleOf(result.out, 's1', 0, length)
    expect(found?.title).toBe('Windows ✓')
    // The last line had no newline yet: the next read starts at it.
    expect(found?.next).toBe(length - Buffer.byteLength('{"type":"assistant","partial":'))
  })

  test('the project folder: absolute, relative or missing, as a path Windows opens', () => {
    ps()
    const dir = scratch()
    mkdirSync(join(dir, 'sub'))
    expect(run(inboxProjectDirArgv(tmpdir(), dir))).toMatchObject({ code: 0, out: `${dir}\n` })
    expect(run(inboxProjectDirArgv(dir, 'sub'))).toMatchObject({ code: 0, out: `${join(dir, 'sub')}\n` })
    expect(run(inboxProjectDirArgv(dir, 'missing')).code).toBe(3)
  })

  // PowerShell reads ‘ ’ ‚ ‛ as single quotes too, so an argument holding one
  // could end a quoted string and run what follows.
  test('an argument with any kind of quote is data, never code', () => {
    ps()
    const dir = scratch()
    for (const quote of ["'", '‘', '’', '‚', '‛']) {
      const attack = `x${quote}) ; Write-Line PWNED ; $z = @(${quote}y`
      expect(run(inboxProjectDirArgv(dir, attack))).toMatchObject({ code: 3, out: '' })
    }
    const named = join(dir, 'Max’s notes')
    expect(run(privateDirArgv(named)).code).toBe(0)
    expect(existsSync(named)).toBe(true)
    expect(run(inboxProjectDirArgv(dir, 'Max’s notes'))).toMatchObject({ code: 0, out: `${named}\n` })
  })
})
