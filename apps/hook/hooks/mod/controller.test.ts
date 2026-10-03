import { describe, expect, test } from 'bun:test'
import { PlannotatorMod, STORE_LAUNCHES } from './controller'
import { PLAN_APPROVAL_NEXT_STEP } from './delivery'
import { fakeHost, type FakeHost, type RunCall } from './testing/fake-host'

const SESSION = { sessionId: 'session-1', dataDir: '/data', interactive: true }

/** The launch directory the detached launcher was handed ($1 after the script). */
function launchDirOf(call: RunCall): string {
  return call.argv[4] as string
}

function isLaunch(call: RunCall): boolean {
  return call.argv[0] === '/bin/sh' && call.argv[3] === 'plannotator-launch'
}

/** Simulate the CLI coming up on `port` for every detached launch. */
function serveOnLaunch(host: FakeHost, port = 4321) {
  host.onRun = (call) => {
    if (isLaunch(call)) host.files.set(`${launchDirOf(call)}/ready`, `${JSON.stringify({ url: `http://localhost:${port}`, isRemote: false, port })}\n`)
  }
}

function launches(host: FakeHost): RunCall[] {
  return host.runs.filter(isLaunch)
}

function decide(host: FakeHost, call: RunCall, record: Record<string, unknown>) {
  host.files.set(`${launchDirOf(call)}/result.json`, JSON.stringify({ v: 1, ...record }))
}

const PLAN = '# Ship it\n\n1. Do the thing.\n'

describe('plan review', () => {
  test('ExitPlanMode is denied at once and the review starts detached with the plan on stdin', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)

    const answer = await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })

    expect('deny' in answer && answer.deny).toContain('NOT approved')
    const [launch] = launches(host)
    expect(launch?.argv.slice(5)).toEqual(['plannotator', 'claude-mod-plan'])
    expect(launch?.env?.PLANNOTATOR_HOST_RESULT_FILE).toBe(`${launchDirOf(launch!)}/result.json`)
    expect(launch?.env?.PLANNOTATOR_SESSION_BRIDGE_TOKEN?.length).toBeGreaterThanOrEqual(32)
    const stdin = JSON.parse(host.files.get(`${launchDirOf(launch!)}/stdin`) ?? '{}')
    expect(stdin.plan).toBe(PLAN)
  })

  test('the plan file wins over a stale inline plan (#1667)', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.files.set('/plans/p.md', '# Edited plan\n')
    const mod = new PlannotatorMod(host, SESSION)

    await mod.onPlanCall({ tool_use_id: 't1', plan: '# Stale snapshot\n', planFilePath: '/plans/p.md' })

    const stdin = JSON.parse(host.files.get(`${launchDirOf(launches(host)[0]!)}/stdin`) ?? '{}')
    expect(stdin.plan).toBe('# Edited plan\n')
  })

  test('denied: the denied prompt is submitted once, and a resubmission opens a new round', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })

    decide(host, launches(host)[0]!, { surface: 'plan', decision: 'denied', message: 'YOUR PLAN WAS NOT APPROVED.\n\nfix step 1', noop: false })
    await host.tick()

    expect(host.submits).toHaveLength(1)
    expect(host.submits[0]).toContain('Changes requested')
    expect(host.submits[0]).toContain('fix step 1')

    const again = await mod.onPlanCall({ tool_use_id: 't2', plan: `${PLAN}2. And more.\n` })
    expect('deny' in again).toBe(true)
    expect(launches(host)).toHaveLength(2)
  })

  test('approved: the next ExitPlanMode with the approved text passes and is allowed with the chosen mode', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })

    decide(host, launches(host)[0]!, {
      surface: 'plan',
      decision: 'approved',
      message: 'Plan approved.',
      noop: false,
      approvedPlan: PLAN,
      permissionMode: 'acceptEdits',
    })
    await host.tick()
    expect(host.submits[0]).toContain(PLAN_APPROVAL_NEXT_STEP)

    const pass = await mod.onPlanCall({ tool_use_id: 't2', plan: `${PLAN}\n\n` })
    expect(pass).toEqual({ pass: true })
    const decision = mod.onPlanPermission('t2', { plan: 'whatever the engine filled in', planFilePath: '/p.md' })
    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { plan: PLAN, planFilePath: '/p.md' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    // No second review was started for the approved call.
    expect(launches(host)).toHaveLength(1)
  })

  test('approved, then a different plan: a new review instead of passing', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })
    decide(host, launches(host)[0]!, { surface: 'plan', decision: 'approved', message: 'ok', noop: false, approvedPlan: PLAN })
    await host.tick()

    const answer = await mod.onPlanCall({ tool_use_id: 't2', plan: '# Something else\n' })

    expect('deny' in answer).toBe(true)
    expect(mod.onPlanPermission('t2', {})).toBeNull()
    expect(launches(host)).toHaveLength(2)
  })

  test('a revision while the review is open goes into the same tab', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })
    const dir = launchDirOf(launches(host)[0]!)
    host.onWait = (paths) => {
      const ack = paths.find((path) => path.endsWith('revision.json.ack'))
      if (ack) host.files.set(ack, JSON.stringify({ seq: 1, accepted: true, revision: 1, version: 2, unchanged: false }))
    }

    const answer = await mod.onPlanCall({ tool_use_id: 't2', plan: `${PLAN}2. Revised.\n` })

    expect(JSON.parse(host.files.get(`${dir}/revision.json`) ?? '{}')).toEqual({ seq: 1, plan: `${PLAN}2. Revised.\n` })
    expect('deny' in answer && answer.deny).toContain('Plan v2 replaced v1')
    expect(launches(host)).toHaveLength(1)
  })

  test('a revision refused because a decision is being recorded tells Claude to wait', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })
    host.onWait = (paths) => {
      const ack = paths.find((path) => path.endsWith('revision.json.ack'))
      if (ack) host.files.set(ack, JSON.stringify({ seq: 1, accepted: false }))
    }

    const answer = await mod.onPlanCall({ tool_use_id: 't2', plan: `${PLAN}2. Revised.\n` })

    expect('deny' in answer && answer.deny).toContain('recording a decision')
  })

  test('a plan server that fails to start falls back to the classic flow', async () => {
    const host = fakeHost()
    host.onRun = (call) => {
      if (isLaunch(call)) {
        host.files.set(`${launchDirOf(call)}/stderr`, 'claude-mod-plan: unknown subcommand')
        host.files.set(`${launchDirOf(call)}/exit`, '1')
      }
    }
    const mod = new PlannotatorMod(host, SESSION)

    expect(await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })).toEqual({ pass: true })
    expect(host.logs.join('\n')).toContain('unknown subcommand')
  })
})

describe('commands', () => {
  test('review opens detached with the words as typed and returns the URL at once', async () => {
    const host = fakeHost()
    serveOnLaunch(host, 5555)
    const mod = new PlannotatorMod(host, SESSION)

    const text = await mod.runCommand('review', 'https://github.com/o/r/pull/412 --base "feature one"')

    expect(text).toContain('PR #412')
    expect(text).toContain('http://localhost:5555')
    expect(launches(host)[0]?.argv.slice(5)).toEqual(['plannotator', 'review', 'https://github.com/o/r/pull/412', '--base', 'feature one'])
  })

  test('a startup failure shows what the CLI printed and leaves nothing open', async () => {
    const host = fakeHost()
    host.onRun = (call) => {
      if (isLaunch(call)) {
        host.files.set(`${launchDirOf(call)}/stderr`, 'File not found: nope.md')
        host.files.set(`${launchDirOf(call)}/exit`, '1')
      }
    }
    const mod = new PlannotatorMod(host, SESSION)

    const text = await mod.runCommand('annotate', 'nope.md')

    expect(text).toContain('File not found: nope.md')
    expect(host.store.get(STORE_LAUNCHES)).toEqual([])
  })

  test('last sends the last assistant message on stdin', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.transcript = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'The answer is 42.' },
      { role: 'assistant', text: '' },
    ]
    const mod = new PlannotatorMod(host, SESSION)

    await mod.runCommand('last', '')

    const [launch] = launches(host)
    expect(launch?.argv.slice(5)).toEqual(['plannotator', 'annotate-last', '--stdin'])
    expect(host.files.get(`${launchDirOf(launch!)}/stdin`)).toBe('The answer is 42.')
  })

  test('feedback is submitted; Done with nothing to send only logs', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'a.md')
    await mod.runCommand('annotate', 'b.md')
    const [first, second] = launches(host)

    decide(host, first!, { surface: 'annotate', decision: 'annotated', message: '# Markdown Annotations\n\nfix it', noop: false, annotationCount: 2 })
    decide(host, second!, { surface: 'annotate', decision: 'annotated', message: '', noop: true, annotationCount: 0 })
    await host.tick()

    expect(host.submits).toHaveLength(1)
    expect(host.submits[0]).toStartWith('Plannotator: a.md — Feedback · 2 comments.')
    expect(host.logs.some((line) => line.includes('b.md closed with no annotations'))).toBe(true)
  })

  test('a server that exits without a decision is reported, not delivered', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('review', '')
    host.files.set(`${launchDirOf(launches(host)[0]!)}/exit`, '137')

    await host.tick()

    expect(host.submits).toEqual([])
    expect(host.logs.join('\n')).toContain('stopped (exit 137)')
  })
})

describe('restore', () => {
  test('open reviews of this session reattach and still deliver', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.runCommand('annotate', 'notes.md')
    const call = launches(host)[0]!

    // A new process for the same session (restart / --resume): same disk and store, new timers.
    const restarted = fakeHost()
    restarted.files = host.files
    restarted.store = host.store
    const second = new PlannotatorMod(restarted, SESSION)
    await second.restore()
    decide(restarted, call, { surface: 'annotate', decision: 'annotated', message: 'please fix', noop: false })
    await restarted.tick()

    expect(restarted.logs.some((line) => line.includes('Reattached 1 open session'))).toBe(true)
    expect(restarted.submits.filter((text) => text.includes('please fix'))).toHaveLength(1)
  })

  test("another session's reviews are left alone", async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    await new PlannotatorMod(host, SESSION).runCommand('annotate', 'notes.md')

    const other = new PlannotatorMod(host, { ...SESSION, sessionId: 'session-2' })
    await other.restore()

    expect(host.logs.some((line) => line.includes('Reattached'))).toBe(false)
  })
})
