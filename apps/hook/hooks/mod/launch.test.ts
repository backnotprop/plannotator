import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAIM_EXIT, claimArgv, cleanupArgv, DEBUG_LOG_MAX_BYTES, debugAppendArgv, pruneArgv, STOP_EXIT, stopArgv } from './launch'

// The TERM fallback for an older CLI runs this script for real. The failures
// it guards: signalling a pid that no longer belongs to Plannotator (reused
// after a reboot or crash), or killing a CLI whose decision is already on disk.
describe('stopArgv (TERM for a CLI without host close)', () => {
  const children: ReturnType<typeof Bun.spawn>[] = []
  const dirs: string[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function spawn(script: string) {
    const child = Bun.spawn(['/bin/sh', '-c', script], { stdout: 'ignore', stderr: 'ignore' })
    children.push(child)
    return child
  }

  async function stop(pid: number, decidedFiles: string[]): Promise<number> {
    const proc = Bun.spawn(stopArgv(String(pid), decidedFiles), { stdout: 'ignore', stderr: 'ignore' })
    return proc.exited
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'plannotator-stop-'))
    dirs.push(dir)
    return dir
  }

  test('a plannotator process is stopped', async () => {
    const child = spawn('sleep 30; : plannotator review')
    const dir = tempDir()
    expect(await stop(child.pid, [join(dir, 'result.json'), join(dir, 'exit')])).toBe(STOP_EXIT.stopped)
    await child.exited
    expect(alive(child.pid)).toBe(false)
  })

  test('a pid that is not plannotator is left alone', async () => {
    const child = spawn('sleep 30; : something-else')
    expect(await stop(child.pid, [])).toBe(STOP_EXIT.notPlannotator)
    expect(alive(child.pid)).toBe(true)
  })

  // No ps (Debian slim without procps; BusyBox's has no -p): the pid cannot be
  // verified, so nothing is signalled and the close says so.
  test('a system whose ps cannot verify the pid: nothing is signalled', async () => {
    const child = spawn('sleep 30; : plannotator review')
    const emptyPath = tempDir()
    const proc = Bun.spawn(stopArgv(String(child.pid), []), { stdout: 'ignore', stderr: 'ignore', env: { PATH: emptyPath } })
    expect(await proc.exited).toBe(STOP_EXIT.cannotVerify)
    expect(alive(child.pid)).toBe(true)
  })

  test('a decision already on disk wins: nothing is signalled', async () => {
    const child = spawn('sleep 30; : plannotator review')
    const dir = tempDir()
    writeFileSync(join(dir, 'result.json'), '{}')
    expect(await stop(child.pid, [join(dir, 'result.json'), join(dir, 'exit')])).toBe(STOP_EXIT.decided)
    expect(alive(child.pid)).toBe(true)
  })
})

// These scripts are what keeps two Claude Code processes on one session from
// delivering a decision twice, the store from growing forever, and a shared
// debug log from being clobbered; they run for real here.
describe('the scripts several Claude Code processes share', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'plannotator-mod-'))
    dirs.push(dir)
    return dir
  }

  async function run(argv: string[], stdin?: string): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(argv, {
      stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const stdout = await new Response(proc.stdout).text()
    return { code: await proc.exited, stdout }
  }

  function launchDir(root: string, name: string, files: Record<string, string>): string {
    mkdirSync(join(root, name))
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, name, file), text)
    return join(root, name)
  }

  test('a launch has exactly one claim, even when two processes claim at once; the claimant wins again on retry', async () => {
    const dir = launchDir(tempDir(), 'launch', { stdin: '', 'result.json': '{"v":1}', exit: '0' })
    const answers = await Promise.all([run(claimArgv(dir, 'process-a')), run(claimArgv(dir, 'process-b'))])
    expect(answers.map((answer) => answer.code).sort()).toEqual([CLAIM_EXIT.won, CLAIM_EXIT.lost])
    const winner = readFileSync(join(dir, 'settled', 'by'), 'utf8')
    // A timed-out call whose claim was made: the same claimant wins again, the other still loses.
    expect((await run(claimArgv(dir, winner))).code).toBe(CLAIM_EXIT.won)
    expect((await run(claimArgv(dir, winner === 'process-a' ? 'process-b' : 'process-a'))).code).toBe(CLAIM_EXIT.lost)
  })

  test('a claim made after cleanup loses, and the claim outlives cleanup while feedback.md keeps the directory', async () => {
    const root = tempDir()
    const kept = launchDir(root, 'kept', { stdin: '', 'result.json': '{}', 'feedback.md': 'for Claude' })
    expect((await run(claimArgv(kept, 'process-a'))).code).toBe(CLAIM_EXIT.won)
    expect((await run(cleanupArgv(kept))).code).toBe(0)
    expect(existsSync(join(kept, 'feedback.md'))).toBe(true)
    expect(existsSync(join(kept, 'settled', 'by'))).toBe(true)
    expect((await run(claimArgv(kept, 'process-b'))).code).toBe(CLAIM_EXIT.lost)

    const removed = launchDir(root, 'removed', { stdin: '', 'result.json': '{}' })
    expect((await run(claimArgv(removed, 'process-a'))).code).toBe(CLAIM_EXIT.won)
    writeFileSync(join(removed, 'settled', 'delivered'), '1')
    await run(cleanupArgv(removed))
    expect(existsSync(removed)).toBe(false)
    expect((await run(claimArgv(removed, 'process-b'))).code).toBe(CLAIM_EXIT.lost)

    // Cleanup started (stdin gone) before anyone claimed: too late to deliver.
    const late = launchDir(root, 'late', { 'result.json': '{}', 'feedback.md': 'for Claude' })
    expect((await run(claimArgv(late, 'process-b'))).code).toBe(CLAIM_EXIT.lost)
  })

  test('prune: settled or cleaned launches always, dead servers without a decision for other sessions, anything but a live server once expired', async () => {
    const root = tempDir()
    const cleaned = launchDir(root, 'cleaned', { 'feedback.md': 'kept for Claude' })
    const removed = join(root, 'removed')
    // A claim on a server that stopped without a decision, and a delivered claim: done.
    const settled = launchDir(root, 'settled-own', { stdin: '', pid: '999995' })
    mkdirSync(join(settled, 'settled'))
    const delivered = launchDir(root, 'delivered', { stdin: '', pid: '999994', 'result.json': '{}' })
    mkdirSync(join(delivered, 'settled'))
    writeFileSync(join(delivered, 'settled', 'delivered'), '1')
    // Claimed but never marked delivered (its claimant quit while Claude was busy): kept for its session to report.
    const stranded = launchDir(root, 'stranded', { stdin: '', pid: '999993', 'result.json': '{}' })
    mkdirSync(join(stranded, 'settled'))
    const ownDead = launchDir(root, 'own-dead', { stdin: '', pid: '999999' })
    const live = launchDir(root, 'live', { stdin: '', pid: String(process.pid) })
    const dead = launchDir(root, 'dead', { stdin: '', pid: '999998' })
    const decided = launchDir(root, 'decided', { stdin: '', pid: '999997', 'result.json': '{}' })
    const exited = launchDir(root, 'exited', { stdin: '', exit: '0' })
    const expiredDecided = launchDir(root, 'expired-decided', { stdin: '', pid: '999996', 'result.json': '{}' })
    const expiredExited = launchDir(root, 'expired-exited', { stdin: '', exit: '1' })
    const expiredLive = launchDir(root, 'expired-live', { stdin: '', pid: String(process.pid), 'result.json': '{}' })

    const { code, stdout } = await run(
      pruneArgv({
        cleaned: [cleaned, removed, settled, delivered, stranded, ownDead],
        dead: [live, dead, decided, exited],
        expired: [expiredDecided, expiredExited, expiredLive],
      }),
    )

    expect(code).toBe(0)
    expect(stdout.trim().split('\n').sort()).toEqual([cleaned, dead, delivered, expiredDecided, expiredExited, removed, settled].sort())
  })

  test('debug lines from several writers are appended, never overwritten', async () => {
    const log = join(tempDir(), 'claude-code-mod', 'debug.log')
    await Promise.all([run(debugAppendArgv(log), 'one\n'), run(debugAppendArgv(log), 'two\n')])
    await run(debugAppendArgv(log), 'three\n')
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    expect(lines.sort()).toEqual(['one', 'three', 'two'])
  })

  // The failure: two writers past the limit both rotated, the second moving
  // the fresh log over the first's debug.log.1, which lost the old log. The
  // window is narrow, so this checks the invariant (old log kept, no line
  // lost, no lock left behind) rather than reproducing the race every run.
  test('two writers past the limit rotate once: the old log survives as debug.log.1', async () => {
    const dir = join(tempDir(), 'claude-code-mod')
    mkdirSync(dir)
    const log = join(dir, 'debug.log')
    const old = `${'x'.repeat(99)}\n`.repeat(Math.ceil((DEBUG_LOG_MAX_BYTES + 1_000) / 100))
    writeFileSync(log, old)
    await Promise.all([run(debugAppendArgv(log), 'one\n'), run(debugAppendArgv(log), 'two\n')])
    const rotated = readFileSync(`${log}.1`, 'utf8')
    expect(rotated.startsWith(old)).toBe(true)
    // A line appended while the other writer rotated lands in either file; none is lost.
    const fresh = [...rotated.slice(old.length).split('\n'), ...readFileSync(log, 'utf8').split('\n')].filter(Boolean)
    expect(fresh.sort()).toEqual(['one', 'two'])
    expect(existsSync(`${log}.rotating`)).toBe(false)
  })
})
