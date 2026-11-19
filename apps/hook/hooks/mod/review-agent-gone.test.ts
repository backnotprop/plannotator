/**
 * The Claude Code mod's side of "a review ends when its agent is gone"
 * (apps/hook/server/review-agent-watch.ts reads what this writes).
 *
 * What regresses if this fails:
 * - the lease stops naming the Claude Code process, so the CLI can no longer
 *   tell a quit session from a live one (every mod review then lives forever),
 *   or names a per-call helper whose death ends a live session's review;
 * - a launch timer the engine ended is never armed again: no lease renewal and
 *   no delivery until the session's next restore;
 * - a code review open across `/clear` or an in-process `/resume` is left with
 *   nobody watching it, and its decision never reaches the new session;
 * - the review the CLI ended for a gone session is reported as a crash.
 */
import { describe, expect, test } from 'bun:test'
import { PlannotatorMod, STORE_LAUNCHES } from './controller'
import { fakeHost, type FakeHost, type RunCall } from './testing/fake-host'

const SESSION = { sessionId: 'session-1', dataDir: '/data', interactive: true }

const isLaunch = (call: RunCall) => call.argv[0] === '/bin/sh' && call.argv[3] === 'plannotator-launch'
const dirOf = (host: FakeHost, index = 0) => String(host.runs.filter(isLaunch)[index]!.argv[4])

/** The CLI comes up for every launch; the shell answers the host-pid script with `pids` in turn. */
function serve(host: FakeHost, pids: string[] = ['777\n']) {
  let asked = 0
  host.onRun = (call) => {
    if (isLaunch(call)) host.files.set(`${call.argv[4]}/ready`, `${JSON.stringify({ url: 'http://localhost:4321', isRemote: false, port: 4321 })}\n`)
    if (call.argv[3] === 'plannotator-host-pid') return { exitCode: 0, stdout: pids[Math.min(asked++, pids.length - 1)]!, stderr: '' }
    return undefined
  }
}

async function ticks(host: FakeHost, count: number, ms = 1_000) {
  for (let i = 0; i < count; i += 1) {
    host.clock += ms
    await host.tick()
  }
}

const lease = (host: FakeHost, dir: string) => JSON.parse(host.files.get(`${dir}/watcher.json`) ?? 'null') as Record<string, unknown> | null

describe('the lease names the Claude Code process', () => {
  test('the pid its shell reports, asked twice, stays in the lease when it is released', async () => {
    const host = fakeHost()
    serve(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('review', '')
    await ticks(host, 10)
    const dir = dirOf(host)
    expect(lease(host, dir)).toMatchObject({ pid: 777 })
    expect(host.runs.filter((call) => call.argv[3] === 'plannotator-host-pid')).toHaveLength(2)
    mod.dispose()
    await Bun.sleep(0)
    expect(lease(host, dir)).toMatchObject({ owner: null, pid: 777 })
  })

  test('two runs that disagree (a per-call helper, not Claude Code): no pid, so the CLI never ends it on its own', async () => {
    const host = fakeHost()
    serve(host, ['777\n', '778\n'])
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('review', '')
    await ticks(host, 10)
    expect(lease(host, dirOf(host))).not.toHaveProperty('pid')
    mod.dispose()
  })
})

describe('a launch timer the engine ended', () => {
  test('is armed again by the next hook look, and the lease is renewed again', async () => {
    const host = fakeHost()
    serve(host)
    // An engine that can end an interval behind the mod's back.
    const realEvery = host.every
    const ended = new Set<() => void>()
    let armed = 0
    host.every = (ms, fn) => {
      armed += 1
      const wrapped = () => {
        if (!ended.has(wrapped)) fn()
      }
      if (armed === 1) setTimeout(() => ended.add(wrapped), 0)
      return realEvery(ms, wrapped)
    }
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('review', '')
    await Bun.sleep(1)
    const dir = dirOf(host)
    const stale = lease(host, dir)?.at
    // Nothing renews it while the timer is ended.
    await ticks(host, 20)
    expect(lease(host, dir)?.at).toBe(stale)

    await mod.ensureLaunchTicking()
    expect(armed).toBe(2)
    await ticks(host, 10)
    expect(lease(host, dir)?.at).not.toBe(stale)
    // A live timer is left alone.
    await mod.ensureLaunchTicking()
    expect(armed).toBe(2)
    mod.dispose()
  })
})

describe('a code review open across /clear or an in-process /resume', () => {
  test('the new session takes it over: it holds the lease and its decision lands there', async () => {
    const host = fakeHost()
    serve(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.runCommand('review', '')
    await ticks(host, 6)
    const dir = dirOf(host)

    // register.ts: session.end disposes, then currentMod makes the new session's instance.
    first.dispose()
    const second = new PlannotatorMod(host, { ...SESSION, sessionId: 'session-2' })
    second.carryQueued(first)
    expect(await second.takeOverReviews(first)).toBe(1)
    await second.restore()

    const records = host.store.get(STORE_LAUNCHES) as { sessionId: string }[]
    expect(records.map((record) => record.sessionId)).toEqual(['session-2'])
    expect(lease(host, dir)?.owner).toEqual(expect.any(String))

    host.files.set(`${dir}/result.json`, JSON.stringify({ v: 1, surface: 'review', decision: 'annotated', message: 'Rename a.', noop: false }))
    await ticks(host, 2)
    expect(host.submits.join('\n')).toContain('Rename a.')
    second.dispose()
  })
})

describe('the review the CLI ended because its session was gone (exit 3)', () => {
  test('is reported as ended with its draft kept, not as a crash, and nothing is delivered', async () => {
    const host = fakeHost()
    serve(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('review', '')
    host.files.set(`${dirOf(host)}/exit`, '3')
    await host.tick()
    expect(host.submits).toEqual([])
    const log = host.logs.join('\n')
    expect(log).toContain('ended while no Claude Code session was open for it')
    expect(log).not.toContain('stopped (exit 3)')
    mod.dispose()
  })
})
