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
 * - a code review open across `/clear` or an in-process `/resume` is ended
 *   under the live process, or its decision goes to the new conversation
 *   instead of waiting for the one that asked;
 * - the review the CLI ended for a gone session is reported as a crash.
 */
import { describe, expect, test } from 'bun:test'
import { REVIEW_AGENT_GONE_MOD_LOG } from '@plannotator/shared/review-agent-gone-words'
import { AGENT_GONE_EXIT_CODE, MOD_LEASE_STALE_MS, modLeaseAgentWatch } from '../../server/review-agent-watch'
import { LEASE_STALE_MS, PlannotatorMod, REVIEW_AGENT_GONE_EXIT_CODE } from './controller'
import { LOCAL_CHANGES_SUBJECT } from './launch'
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
  // The review stays with the conversation that asked for it: the new
  // conversation never gets its decision, and the CLI never ends it while the
  // Claude Code process runs. Resuming the first conversation delivers it.
  test('is not ended, is not handed to the new conversation, and lands when its own session is resumed', async () => {
    const host = fakeHost()
    serve(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.runCommand('review', '')
    await ticks(host, 6)
    const dir = dirOf(host)

    // register.ts: session.end disposes, then currentMod makes the new conversation's instance.
    first.dispose()
    await Bun.sleep(0)
    const second = new PlannotatorMod(host, { ...SESSION, sessionId: 'session-2' })
    second.carryQueued(first)
    await second.restore()
    expect(lease(host, dir)).toMatchObject({ owner: null, pid: 777 })

    // The CLI's 10 s looks for 3 minutes: the lease stays still, the process runs.
    let now = 0
    const watch = modLeaseAgentWatch({ readLease: () => host.files.get(`${dir}/watcher.json`) ?? null, now: () => now, pidAlive: (pid) => pid === 777 })
    for (let look = 0; look < 18; look += 1) {
      now += 10_000
      expect(watch.ended()).toBe(false)
    }
    expect(watch.presence()).toBe('here')

    host.files.set(`${dir}/result.json`, JSON.stringify({ v: 1, surface: 'review', decision: 'annotated', message: 'Rename a.', noop: false }))
    await ticks(host, 2)
    expect(host.submits.join('\n')).not.toContain('Rename a.')

    // `/resume` back to the first conversation: its decision lands there.
    second.dispose()
    const resumed = new PlannotatorMod(host, SESSION)
    await resumed.restore()
    await ticks(host, 2)
    expect(host.submits.join('\n')).toContain('Rename a.')
    resumed.dispose()
  })
})

describe('the review the CLI ended because its session was gone (exit 3)', () => {
  test('is reported as ended with its draft kept, not as a crash, and nothing is delivered', async () => {
    const host = fakeHost()
    serve(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('review', '')
    host.files.set(`${dirOf(host)}/exit`, String(AGENT_GONE_EXIT_CODE))
    await host.tick()
    expect(host.submits).toEqual([])
    // The mod's own copy of the owner's line, word for word (this folder cannot import packages/shared).
    expect(host.logs).toContain(REVIEW_AGENT_GONE_MOD_LOG(LOCAL_CHANGES_SUBJECT))
    expect(host.logs.join('\n')).not.toContain('without a decision')
    mod.dispose()
  })
})

// The mod is its own bundle and keeps copies of the CLI's numbers: a drift
// reads exit 3 as a crash, or makes Send and the mod disagree on a stale lease.
describe('the numbers the mod and the review CLI share', () => {
  test('the exit code and the stale-lease time are the same on both sides', () => {
    expect(REVIEW_AGENT_GONE_EXIT_CODE).toBe(AGENT_GONE_EXIT_CODE)
    expect(LEASE_STALE_MS).toBe(MOD_LEASE_STALE_MS)
  })
})
