import { describe, expect, test } from 'bun:test'
import { PlannotatorMod, STORE_LAUNCHES } from './controller'
import { PLAN_APPROVAL_NEXT_STEP } from './delivery'
import { CLASSIC_PLAN_REVIEW_TEXT } from './plan'
import { PLANNOTATOR_BUNDLE_HINT_LINE, PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT } from './tool'
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

  // Version skew: the plugin installs from main and the binary updates on its
  // own, so a mod can meet a CLI with no claude-mod-plan. What those CLIs
  // print, observed by running them: 0.27.25 (0.27.11+) and 0.27.10 (older
  // CLIs read an unknown subcommand as the classic hook).
  for (const [cli, stderr] of [
    ['0.27.11 to 0.27.25', "Unknown command: claude-mod-plan\n\nRun 'plannotator --help' for the list of commands.\n"],
    ['before 0.27.11', 'No plan content in hook event\n'],
  ] as const) {
    test(`a CLI without claude-mod-plan (${cli}): every plan takes the classic review, said once, nothing left behind`, async () => {
      const host = fakeHost()
      host.onRun = (call) => {
        if (isLaunch(call)) {
          host.files.set(`${launchDirOf(call)}/stderr`, stderr)
          host.files.set(`${launchDirOf(call)}/exit`, '1')
        }
      }
      const mod = new PlannotatorMod(host, SESSION)

      expect(await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })).toEqual({ pass: true })
      expect(await mod.onPlanCall({ tool_use_id: 't2', plan: `${PLAN}2. More.\n` })).toEqual({ pass: true })

      // One probe, then no more launches; one explanation, not an error per plan.
      expect(launches(host)).toHaveLength(1)
      expect(host.logs).toHaveLength(1)
      expect(host.logs[0]).toContain('classic review')
      expect(host.logs[0]).not.toContain('could not open')
      // The plan copy on stdin is removed; nothing is waiting or watched.
      const dir = launchDirOf(launches(host)[0]!)
      expect(host.runs.some((call) => call.argv[3] === 'plannotator-cleanup' && call.argv[4] === dir)).toBe(true)
      expect(host.store.get(STORE_LAUNCHES)).toEqual([])
      expect(mod.onPlanPermission('t2', { plan: PLAN })).toBeNull()
    })
  }

  test('an old CLI that exits while the hook waits is reported once, by the hook, even when the timer ticks then', async () => {
    const host = fakeHost()
    let dir = ''
    host.onRun = (call) => {
      if (isLaunch(call)) dir = launchDirOf(call)
    }
    host.onWait = () => {
      if (!dir || host.files.has(`${dir}/exit`)) return
      host.files.set(`${dir}/stderr`, 'Unknown command: claude-mod-plan\n')
      host.files.set(`${dir}/exit`, '1')
      // The 1 s timer fires in the same moment the CLI exits.
      void host.tick()
    }
    const mod = new PlannotatorMod(host, SESSION)

    expect(await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })).toEqual({ pass: true })
    await host.tick()

    expect(host.logs).toEqual([CLASSIC_PLAN_REVIEW_TEXT])
    expect(host.submits).toEqual([])
  })

  test('an old CLI that refuses only after the hook stopped waiting: Claude is asked to call ExitPlanMode again', async () => {
    const host = fakeHost()
    const mod = new PlannotatorMod(host, SESSION)

    // Nothing within the hook's 15 s: Claude is told the review is open.
    const answer = await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })
    expect('deny' in answer && answer.deny).toContain('NOT approved')

    const dir = launchDirOf(launches(host)[0]!)
    host.files.set(`${dir}/stderr`, 'Unknown command: claude-mod-plan\n')
    host.files.set(`${dir}/exit`, '1')
    await host.tick()

    expect(host.logs).toEqual([CLASSIC_PLAN_REVIEW_TEXT])
    expect(host.submits).toHaveLength(1)
    expect(host.submits[0]).toContain('Call ExitPlanMode again')
    // The call it asks for goes to the classic review without another launch.
    expect(await mod.onPlanCall({ tool_use_id: 't2', plan: PLAN })).toEqual({ pass: true })
    expect(launches(host)).toHaveLength(1)
    expect(host.store.get(STORE_LAUNCHES)).toEqual([])
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

  test('annotate refuses strict-gate and hook flags instead of launching a session whose decision nothing reads', async () => {
    for (const [words, flag] of [
      ['notes.md --gate --json --require-approval', '--require-approval'],
      ['notes.md --gate --json --result-file out.json', '--result-file'],
      ['notes.md --hook', '--hook'],
    ] as const) {
      const host = fakeHost()
      serveOnLaunch(host)
      const mod = new PlannotatorMod(host, SESSION)

      const text = await mod.runCommand('annotate', words)

      expect(text).toContain(flag)
      expect(text).toContain('in a terminal')
      expect(launches(host)).toEqual([])
      expect(host.store.get(STORE_LAUNCHES)).toBeUndefined()
    }
  })

  test('a word that merely mentions a strict flag inside a quoted path still opens', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)

    await mod.runCommand('annotate', '"notes --hook.md" --gate')

    expect(launches(host)[0]?.argv.slice(5)).toEqual(['plannotator', 'annotate', 'notes --hook.md', '--gate'])
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
    // One message: nothing to pick, so the launch is exactly the old one.
    expect(host.files.has(`${launchDirOf(launch!)}/messages.json`)).toBe(false)
    expect(launch?.env?.PLANNOTATOR_HOST_MESSAGES_FILE).toBeUndefined()
  })

  // The regression: under the mod only the newest text reached the CLI, so
  // the picker never showed and an earlier message could not be annotated.
  test('last hands the CLI the recent assistant messages, newest first, for the picker', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.transcript = [
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'First answer.' },
      { role: 'user', text: 'second question' },
      { role: 'assistant', text: '' }, // a tool-use row: no text
      { role: 'user', text: '' }, // its tool result
      { role: 'assistant', text: 'Second answer, part one.' },
      { role: 'assistant', text: 'Part two.' }, // same response, next block
      { role: 'user', text: 'third question' },
      { role: 'assistant', text: '' },
    ]
    const mod = new PlannotatorMod(host, SESSION)

    const opened = await mod.runCommand('last', '')

    const [launch] = launches(host)
    const dir = launchDirOf(launch!)
    expect(launch?.argv.slice(5)).toEqual(['plannotator', 'annotate-last', '--stdin'])
    // stdin still carries the newest text: all an older CLI reads.
    expect(host.files.get(`${dir}/stdin`)).toBe('Second answer, part one.\nPart two.')
    expect(launch?.env?.PLANNOTATOR_HOST_MESSAGES_FILE).toBe(`${dir}/messages.json`)
    const payload = JSON.parse(host.files.get(`${dir}/messages.json`) ?? '{}') as { v: number; messages: { messageId: string; text: string }[] }
    expect(payload.v).toBe(1)
    expect(payload.messages.map((message) => message.text)).toEqual(['Second answer, part one.\nPart two.', 'First answer.'])
    expect(new Set(payload.messages.map((message) => message.messageId)).size).toBe(2)
    expect(opened).toContain("Claude's recent messages")

    // The decision names what the reviewer could pick from, not "the last message".
    decide(host, launch!, { surface: 'annotate-last', decision: 'annotated', message: '# Message Annotations\n\nfix it', noop: false, annotationCount: 1 })
    await host.tick()
    expect(host.submits[0]).toStartWith("Plannotator: Claude's recent messages (pn-ababab) — Feedback · 1 comment.")
  })

  test('a message keeps its picker id as newer messages arrive, and the list stops at 25', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    const turns = (count: number) => Array.from({ length: count }, (_, index) => [
      { role: 'user' as const, text: `q${index}` },
      { role: 'assistant' as const, text: `answer ${index}` },
    ]).flat()
    const idOf = (call: RunCall, text: string) => {
      const payload = JSON.parse(host.files.get(`${launchDirOf(call)}/messages.json`) ?? '{}') as { messages: { messageId: string; text: string }[] }
      return { ids: payload.messages, id: payload.messages.find((message) => message.text === text)?.messageId }
    }

    host.transcript = turns(10)
    await mod.runCommand('last', '')
    host.transcript = turns(30)
    await mod.runCommand('last', '')

    const [first, second] = launches(host)
    expect(idOf(second!, 'answer 7').id).toBeDefined()
    expect(idOf(second!, 'answer 7').id).toBe(idOf(first!, 'answer 7').id)
    const list = idOf(second!, 'answer 29').ids
    expect(list).toHaveLength(25)
    expect(list[0]?.text).toBe('answer 29')
    expect(list[24]?.text).toBe('answer 5')
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
    expect(host.submits[0]).toStartWith('Plannotator: a.md (pn-ababab) — Feedback · 2 comments.')
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

describe('the plannotator tool', () => {
  // The failure: the tool forks the launch (different argv, no result file,
  // no bridge token) or tells Claude something other than "end your turn".
  test('a call launches exactly what the slash command launches and returns at once', async () => {
    const host = fakeHost()
    serveOnLaunch(host, 6060)
    const mod = new PlannotatorMod(host, SESSION)

    const answer = await mod.runTool({ action: 'annotate', target: 'docs/my notes.md', gate: true })
    await mod.runCommand('annotate', '"docs/my notes.md" --gate')

    const [byTool, byCommand] = launches(host)
    expect(byTool?.argv.slice(5)).toEqual(['plannotator', 'annotate', 'docs/my notes.md', '--gate'])
    expect(byTool?.argv.slice(5)).toEqual(byCommand?.argv.slice(5))
    expect(Object.keys(byTool?.env ?? {}).sort()).toEqual(Object.keys(byCommand?.env ?? {}).sort())
    expect('text' in answer && answer.text).toContain('http://localhost:6060')
    expect('text' in answer && answer.text).toContain('End your turn')
  })

  test('review maps the target and base; last reads the transcript', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.transcript = [{ role: 'assistant', text: 'Here is the design.' }]
    const mod = new PlannotatorMod(host, SESSION)

    await mod.runTool({ action: 'review', target: '../wt', options: { base: 'feature/part-1' } })
    await mod.runTool({ action: 'last' })

    const [review, last] = launches(host)
    expect(review?.argv.slice(5)).toEqual(['plannotator', 'review', '--base', 'feature/part-1', '../wt'])
    expect(last?.argv.slice(5)).toEqual(['plannotator', 'annotate-last', '--stdin'])
    expect(host.files.get(`${launchDirOf(last!)}/stdin`)).toBe('Here is the design.')
  })

  test('a bad call and a startup failure are error results, and nothing stays open', async () => {
    const host = fakeHost()
    host.onRun = (call) => {
      if (isLaunch(call)) {
        host.files.set(`${launchDirOf(call)}/stderr`, 'File not found: nope.md')
        host.files.set(`${launchDirOf(call)}/exit`, '1')
      }
    }
    const mod = new PlannotatorMod(host, SESSION)

    const bad = await mod.runTool({ action: 'annotate', target: '--hook' })
    expect(launches(host)).toHaveLength(0)
    expect('deny' in bad && bad.deny).toContain('Invalid plannotator call')

    const failed = await mod.runTool({ action: 'annotate', target: 'nope.md' })
    expect('deny' in failed && failed.deny).toContain('File not found: nope.md')
    expect(host.store.get(STORE_LAUNCHES)).toEqual([])
  })

  test('a gated approval reaches Claude; an ungated Done does not', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runTool({ action: 'annotate', target: 'spec.md', gate: true })
    await mod.runTool({ action: 'annotate', target: 'notes.md' })
    const [gated, plain] = launches(host)

    decide(host, gated!, { surface: 'annotate', decision: 'approved', message: 'The user approved.', noop: true, annotationCount: 0 })
    decide(host, plain!, { surface: 'annotate', decision: 'annotated', message: '', noop: true, annotationCount: 0 })
    await host.tick()

    expect(host.submits).toHaveLength(1)
    expect(host.submits[0]).toStartWith('Plannotator: spec.md (pn-ababab) — Approved.')
    expect(host.submits[0]).toContain('The user approved.')
    expect(host.logs.some((line) => line.includes('notes.md closed with no annotations'))).toBe(true)
  })

  test('the slash command keeps a bare gated approval as a log line', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'spec.md --gate')

    decide(host, launches(host)[0]!, { surface: 'annotate', decision: 'approved', message: 'The user approved.', noop: true })
    await host.tick()

    expect(host.submits).toEqual([])
  })
})

describe('a CLI older than the host result file', () => {
  test('its printed feedback is still delivered, and an empty close is not', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'a.md')
    await mod.runCommand('annotate', 'b.md')
    const [first, second] = launches(host)
    host.files.set(`${launchDirOf(first!)}/stdout`, 'Line 3: wrong date\n')
    host.files.set(`${launchDirOf(first!)}/exit`, '0')
    host.files.set(`${launchDirOf(second!)}/stdout`, '')
    host.files.set(`${launchDirOf(second!)}/exit`, '0')

    await host.tick()

    expect(host.submits).toHaveLength(1)
    expect(host.submits[0]).toContain('Line 3: wrong date')
    expect(host.logs.some((line) => line.includes('b.md closed with no annotations'))).toBe(true)
  })

  // #1701: what such a CLI prints for an annotate Done with nothing to send.
  test('its printed zero-feedback sentence starts no turn', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'notes.md')
    const [launch] = launches(host)
    host.files.set(`${launchDirOf(launch!)}/stdout`, 'User reviewed the document and has no feedback.\n')
    host.files.set(`${launchDirOf(launch!)}/exit`, '0')

    await host.tick()

    expect(host.submits).toEqual([])
    expect(host.logs.some((line) => line.includes('notes.md closed with no annotations'))).toBe(true)
  })
})

// #1701, end to end over the record the CLI builds: the editor's Done posts the
// zero-state sentence as feedback, marked nothingToSend; the session must not
// receive a "please address the annotation feedback" turn.
describe('annotate Done with nothing to send (CLI record → mod)', () => {
  test('logs, never submits', async () => {
    const { annotateHostResult } = await import('../../server/host-result')
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'notes.md')
    const record = annotateHostResult(
      { feedback: 'User reviewed the document and has no feedback.', annotations: [], nothingToSend: true },
      { kind: 'file', target: '/repo/notes.md' },
    )
    decide(host, launches(host)[0]!, record as unknown as Record<string, unknown>)

    await host.tick()

    expect(host.submits).toEqual([])
    expect(host.logs.some((line) => line.includes('notes.md closed with no annotations'))).toBe(true)
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

describe('session boundaries and launch hygiene', () => {
  // The failure: after /clear (session.start does not fire, the process goes
  // on under another session id) the old instance's timer delivered a review
  // decision into the new, unrelated session.
  test('a disposed instance delivers nothing; the session reattaches it when resumed', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const old = new PlannotatorMod(host, SESSION)
    await old.runCommand('annotate', 'notes.md')
    const call = launches(host)[0]!

    old.dispose()
    decide(host, call, { surface: 'annotate', decision: 'annotated', message: 'please fix', noop: false })
    await host.tick()
    expect(host.submits).toEqual([])

    const resumed = new PlannotatorMod(host, SESSION)
    await resumed.restore()
    await host.tick()
    expect(host.submits.filter((text) => text.includes('please fix'))).toHaveLength(1)
  })

  test('the launch directory is made owner-only before stdin is written, and cleaned after delivery', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const order: string[] = []
    const write = host.writeFile
    host.writeFile = async (path, text) => {
      order.push(`write ${path.slice(path.lastIndexOf('/') + 1)}`)
      return write(path, text)
    }
    const onRun = host.onRun
    host.onRun = (call) => {
      order.push(String(call.argv[3]))
      return onRun(call)
    }
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'notes.md')
    expect(order.slice(0, 3)).toEqual(['plannotator-mkdir', 'write stdin', 'plannotator-launch'])
    expect(host.runs[0]?.argv[2]).toContain('umask 077')

    decide(host, launches(host)[0]!, { surface: 'annotate', decision: 'annotated', message: 'x'.repeat(13 * 1024), noop: false })
    await host.tick()
    const cleanup = host.runs.find((call) => call.argv[3] === 'plannotator-cleanup')
    expect(cleanup?.argv).toContain('stdin')
    expect(cleanup?.argv).toContain('result.json')
    // Oversized feedback stays for Claude to Read.
    expect(cleanup?.argv).not.toContain('feedback.md')
    expect(order.indexOf('plannotator-cleanup')).toBeGreaterThan(order.indexOf('write feedback.md'))
  })
})

describe('the plannotator tool: list and close (contract v2)', () => {
  /** Answers the host-control endpoints of every launched server; records what was asked. */
  function serveHostControl(host: FakeHost, unsent: number) {
    const calls: string[] = []
    host.onFetch = (url) => {
      calls.push(url)
      if (url.endsWith('/api/host/status')) return { status: 200, ok: true, text: JSON.stringify({ kind: 'annotate', documents: [], unsentAnnotations: unsent, decided: false }) }
      if (url.endsWith('/api/host/close')) return { status: 200, ok: true, text: JSON.stringify({ unsentAnnotations: unsent }) }
      return { status: 404, ok: false, text: '' }
    }
    return calls
  }

  function sessionIdIn(answer: { text: string } | { deny: string }): string {
    return /Session: (pn-[0-9a-f]{6})/.exec('text' in answer ? answer.text : '')?.[1] ?? ''
  }

  function textOf(answer: { text: string } | { deny: string }): string {
    return 'text' in answer ? answer.text : `DENY ${answer.deny}`
  }

  test('each open gets its own session id, and list reports them with the unsent counts', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    serveHostControl(host, 2)
    const mod = new PlannotatorMod(host, SESSION)

    const idA = sessionIdIn(await mod.runTool({ action: 'annotate', target: 'a.md' }))
    const idB = sessionIdIn(await mod.runTool({ action: 'annotate', target: 'b.md' }))
    expect(idA).toMatch(/^pn-[0-9a-f]{6}$/)
    expect(idB).toMatch(/^pn-[0-9a-f]{6}$/)
    expect(idB).not.toBe(idA)

    const lines = textOf(await mod.runTool({ action: 'list' })).split('\n')
    expect(lines.find((line) => line.startsWith(idA))).toContain('unsent: 2')
    expect(lines.find((line) => line.startsWith(idB))).toContain('b.md')
  })

  // The failure: one conversation closes (or sees) a review another one opened.
  test('another Claude session neither lists nor closes these reviews', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const calls = serveHostControl(host, 0)
    const mine = new PlannotatorMod(host, SESSION)
    const id = sessionIdIn(await mine.runTool({ action: 'annotate', target: 'a.md' }))

    const other = new PlannotatorMod(host, { ...SESSION, sessionId: 'session-2' })
    await other.restore()
    expect(textOf(await other.runTool({ action: 'list' }))).not.toContain(id)
    const close = await other.runTool({ action: 'close', session: id })
    expect('deny' in close && close.deny).toContain(id)
    expect(calls.some((url) => url.endsWith('/api/host/close'))).toBe(false)
  })

  test('close asks the server, reports the saved count, and delivers nothing when the server exits', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const calls = serveHostControl(host, 3)
    const mod = new PlannotatorMod(host, SESSION)
    const id = sessionIdIn(await mod.runTool({ action: 'annotate', target: 'a.md' }))
    const [launch] = launches(host)

    const closed = await mod.runTool({ action: 'close', session: id })
    expect(textOf(closed)).toContain('3 unsent comments')
    expect(calls.filter((url) => url.endsWith('/api/host/close'))).toHaveLength(1)

    // The CLI publishes its dismissal and exits.
    decide(host, launch!, { surface: 'annotate', decision: 'dismissed', message: '', noop: true, closedBy: 'agent', unsentAnnotations: 3 })
    host.files.set(`${launchDirOf(launch!)}/exit`, '0')
    await host.tick()
    expect(host.submits).toHaveLength(0)
    expect(textOf(await mod.runTool({ action: 'list' }))).not.toContain(id)
  })

  test('an older CLI without the endpoint is stopped with TERM instead', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    // 0.24+ answers an unknown /api/* path with a JSON 404.
    host.onFetch = (url) => ({ status: 404, ok: false, text: JSON.stringify({ error: 'Not found', path: new URL(url).pathname }) })
    const mod = new PlannotatorMod(host, SESSION)
    const id = sessionIdIn(await mod.runTool({ action: 'annotate', target: 'a.md' }))
    const [launch] = launches(host)
    host.files.set(`${launchDirOf(launch!)}/pid`, '4242\n')

    expect(textOf(await mod.runTool({ action: 'close', session: id }))).toContain('Closed a.md')
    const stop = host.runs.find((call) => call.argv[3] === 'plannotator-stop')
    // The pid, then the files whose presence means the reviewer already decided.
    expect(stop?.argv.slice(4)).toEqual(['4242', `${launchDirOf(launch!)}/result.json`, `${launchDirOf(launch!)}/exit`])

    host.files.set(`${launchDirOf(launch!)}/exit`, '143')
    await host.tick()
    expect(host.submits).toHaveLength(0)
    // Not reported as a crash: Claude asked for it.
    expect(host.logs.some((line) => line.includes('without a decision'))).toBe(false)
  })

  test('close all skips a plan review', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const calls = serveHostControl(host, 0)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.onPlanCall({ tool_use_id: 't1', plan: PLAN })
    await mod.runTool({ action: 'annotate', target: 'a.md' })

    const text = textOf(await mod.runTool({ action: 'close', session: 'all' }))
    expect(text).toMatch(/Not closed: Plan v1/)
    expect(text).toMatch(/Closed a\.md/)
    expect(calls.filter((url) => url.endsWith('/api/host/close'))).toHaveLength(1)
  })

  // The failure (#1709 review): a CLI before the /api/* 404 guard serves its
  // app page with 200 for POST /api/host/close; read as "closed", the
  // reviewer's later feedback was swallowed as Claude's close.
  test('an app page (200 text/html) is not a close; it is an older CLI, stopped only after the checks', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.onFetch = () => ({ status: 200, ok: true, text: '<!DOCTYPE html><html><body>Plannotator</body></html>' })
    const mod = new PlannotatorMod(host, SESSION)
    const id = sessionIdIn(await mod.runTool({ action: 'annotate', target: 'a.md' }))
    const [launch] = launches(host)
    host.files.set(`${launchDirOf(launch!)}/pid`, '4242\n')
    // The stop script finds the reviewer's decision already on disk (exit 3).
    const onRun = host.onRun
    host.onRun = (call) => (call.argv[3] === 'plannotator-stop' ? { exitCode: 3, stdout: '', stderr: '' } : onRun(call))

    const answer = await mod.runTool({ action: 'close', session: id })
    expect(textOf(answer)).toContain('already decided')

    // Not marked closed: the reviewer's decision is delivered.
    decide(host, launch!, { surface: 'annotate', decision: 'annotated', message: 'fix line 3', noop: false, annotationCount: 1 })
    await host.tick()
    expect(host.submits).toHaveLength(1)
    expect(host.submits[0]).toContain('fix line 3')
  })

  test('nothing answering on the port: no TERM (the pid may be stale or reused)', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.onFetch = () => {
      throw new Error('ECONNREFUSED')
    }
    const mod = new PlannotatorMod(host, SESSION)
    const id = sessionIdIn(await mod.runTool({ action: 'annotate', target: 'a.md' }))
    host.files.set(`${launchDirOf(launches(host)[0]!)}/pid`, '4242\n')

    const answer = await mod.runTool({ action: 'close', session: id })
    expect('deny' in answer).toBe(true)
    expect(host.runs.some((call) => call.argv[3] === 'plannotator-stop')).toBe(false)
  })

  // A current CLI in remote mode turns /api/host/* off: its 404 is not an
  // older CLI's, and its process must not be signalled.
  test('host control turned off (remote mode): no TERM, the close says to use the tab', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.onFetch = () => ({ status: 404, ok: false, text: JSON.stringify({ error: 'Not found', code: 'host_control_disabled' }) })
    const mod = new PlannotatorMod(host, SESSION)
    const id = sessionIdIn(await mod.runTool({ action: 'annotate', target: 'a.md' }))
    host.files.set(`${launchDirOf(launches(host)[0]!)}/pid`, '4242\n')

    const answer = await mod.runTool({ action: 'close', session: id })
    expect('deny' in answer && answer.deny).toContain('remote mode')
    expect(host.runs.some((call) => call.argv[3] === 'plannotator-stop')).toBe(false)
    expect(textOf(await mod.runTool({ action: 'list' }))).toContain(id)
  })

  test('ps cannot verify the pid: not closed, and the close says it was left running', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.onFetch = (url) => ({ status: 404, ok: false, text: JSON.stringify({ error: 'Not found', path: new URL(url).pathname }) })
    const onRun = host.onRun
    host.onRun = (call) => (call.argv[3] === 'plannotator-stop' ? { exitCode: 6, stdout: '', stderr: '' } : onRun(call))
    const mod = new PlannotatorMod(host, SESSION)
    const id = sessionIdIn(await mod.runTool({ action: 'annotate', target: 'a.md' }))
    host.files.set(`${launchDirOf(launches(host)[0]!)}/pid`, '4242\n')

    const answer = await mod.runTool({ action: 'close', session: id })
    expect('deny' in answer && answer.deny).toContain('left running')
    expect(textOf(await mod.runTool({ action: 'list' }))).toContain(id)
  })

  // The race a TERM can lose: the reviewer decided just before it, and the
  // older CLI publishes the decision anyway. A record without closedBy is the
  // reviewer's, not Claude's close.
  test('after a TERM close, a decision record without closedBy is delivered, not swallowed', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.onFetch = (url) => ({ status: 404, ok: false, text: JSON.stringify({ error: 'Not found', path: new URL(url).pathname }) })
    const mod = new PlannotatorMod(host, SESSION)
    const id = sessionIdIn(await mod.runTool({ action: 'annotate', target: 'a.md' }))
    const [launch] = launches(host)
    host.files.set(`${launchDirOf(launch!)}/pid`, '4242\n')
    expect(textOf(await mod.runTool({ action: 'close', session: id }))).toContain('Closed a.md')

    decide(host, launch!, { surface: 'annotate', decision: 'annotated', message: 'fix line 3', noop: false, annotationCount: 1 })
    await host.tick()

    expect(host.submits).toHaveLength(1)
    expect(host.submits[0]).toContain('fix line 3')
  })

  test('reply is not an action: refused as an invalid call, nothing launches', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)

    const refused = await mod.runTool({ action: 'reply', session: 'pn-ababab', comment: 'c1', text: 'done' })
    expect('deny' in refused && refused.deny).toContain('Invalid plannotator call')
    expect(launches(host)).toHaveLength(0)

    // A one-file list is the plain call.
    await mod.runTool({ action: 'annotate', target: ['a.md'] })
    expect(launches(host)[0]?.argv.slice(5)).toEqual(['plannotator', 'annotate', 'a.md'])
  })
})

// Reviews of several files (bundles). The failures: a list launched as
// something other than the CLI's bundle invocation (re-split, reordered), the
// decision heading naming one file of several, or an older CLI's "pick one"
// error shown to Claude as if its call were wrong.
describe('the plannotator tool: several files', () => {
  test('a list launches one CLI with the files in order, and the result and decision name the bundle', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)

    const answer = await mod.runTool({ action: 'annotate', target: ['spec.md', 'ui/mock.html', 'notes.md'], gate: true })

    expect('text' in answer && answer.text).toContain('Opened 3 files: spec.md, mock.html, notes.md in Plannotator')
    const [launch] = launches(host)
    expect(launch?.argv.slice(5)).toEqual(['plannotator', 'annotate', 'spec.md', 'ui/mock.html', 'notes.md', '--gate'])

    decide(host, launch!, { surface: 'annotate', decision: 'annotated', message: 'two notes', noop: false, annotationCount: 2 })
    await host.tick()
    expect(host.submits[0]).toStartWith('Plannotator: 3 files: spec.md, mock.html, notes.md (pn-')
  })

  test('an older CLI refusing several paths reads as "update Plannotator", for the tool and the slash command', async () => {
    const olderRefusal = [
      'Ambiguous annotate arguments: 2 of them each resolve to an existing target.',
      '  a.md -> /r/a.md',
      '  b.md -> /r/b.md',
      'Re-run with exactly one target: plannotator annotate <file.md | file.txt | file.html | https://... | folder/>',
    ].join('\n')
    const host = fakeHost()
    host.onRun = (call) => {
      if (isLaunch(call)) {
        host.files.set(`${launchDirOf(call)}/stderr`, olderRefusal)
        host.files.set(`${launchDirOf(call)}/exit`, '1')
      }
    }
    const mod = new PlannotatorMod(host, SESSION)

    const answer = await mod.runTool({ action: 'annotate', target: ['a.md', 'b.md'] })
    expect('deny' in answer && answer.deny).toBe(PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT)
    expect(await mod.runCommand('annotate', 'a.md b.md')).toBe(PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT)
    // Prose around two paths is the user's own ambiguity, shown as the CLI said it.
    expect(await mod.runCommand('annotate', 'compare a.md and b.md')).toContain('Ambiguous annotate arguments')
  })

  test("a current CLI's ambiguity error (a URL among the files) is shown as it is", async () => {
    const host = fakeHost()
    host.onRun = (call) => {
      if (isLaunch(call)) {
        host.files.set(
          `${launchDirOf(call)}/stderr`,
          `Ambiguous annotate arguments: 2 of them each resolve to an existing target.\n${PLANNOTATOR_BUNDLE_HINT_LINE}`,
        )
        host.files.set(`${launchDirOf(call)}/exit`, '1')
      }
    }
    const mod = new PlannotatorMod(host, SESSION)
    const answer = await mod.runTool({ action: 'annotate', target: ['a.md', 'https://example.com'] })
    expect('deny' in answer && answer.deny).toContain(PLANNOTATOR_BUNDLE_HINT_LINE)
  })

  test('the slash command names several file paths as a bundle', async () => {
    const host = fakeHost()
    serveOnLaunch(host, 5555)
    const mod = new PlannotatorMod(host, SESSION)
    const text = await mod.runCommand('annotate', 'spec.md notes.md')
    expect(text).toContain('2 files: spec.md, notes.md')
    expect(launches(host)[0]?.argv.slice(5)).toEqual(['plannotator', 'annotate', 'spec.md', 'notes.md'])
  })
})

describe('Ask this session survives a server that stops answering', () => {
  const POLL = '/api/ai/bridge/poll'

  /** Counts polls; while `silent`, every request fails like `$.http.fetch` timing out; otherwise a poll stays open. */
  function pausableServer(host: FakeHost) {
    const state = { silent: false, polls: 0 }
    host.onFetch = (url) => {
      if (!url.endsWith(POLL)) return { status: 200, ok: true, text: '{}' }
      state.polls += 1
      if (state.silent) throw new Error('The operation timed out.')
      // A long poll the server holds open: the loop waits here.
      return new Promise<never>(() => undefined)
    }
    return state
  }

  // The failure: the loop gave up after ~3 minutes of a paused server (a
  // sleeping laptop) and nothing ever started another, so the page said the
  // session was gone for good while decisions still arrived.
  test('a bridge that gave up is started again after a backoff, which grows while the server stays silent', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const server = pausableServer(host)
    server.silent = true
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'notes.md')

    await host.tick()
    const firstLoop = server.polls
    expect(firstLoop).toBe(6)

    // Not again at once.
    await host.tick()
    expect(server.polls).toBe(firstLoop)

    // 5 s later a new loop starts; still silent, so it gives up too.
    host.clock += 5_000
    await host.tick()
    expect(server.polls).toBe(firstLoop * 2)

    // The next wait has doubled: nothing at 5 s, a new loop at 10 s.
    host.clock += 5_000
    await host.tick()
    expect(server.polls).toBe(firstLoop * 2)
    host.clock += 5_000
    server.silent = false
    await host.tick()
    // The server answers again: the new loop's poll is open, and stays the only one.
    expect(server.polls).toBe(firstLoop * 2 + 1)
    host.clock += 120_000
    await host.tick()
    expect(server.polls).toBe(firstLoop * 2 + 1)
  })

  test('a CLI without the bridge (404) is never polled again', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    let polls = 0
    host.onFetch = (url) => {
      if (url.endsWith(POLL)) polls += 1
      return { status: 404, ok: false, text: '{"error":"Not found"}' }
    }
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'notes.md')

    await host.tick()
    expect(polls).toBe(1)
    for (let index = 0; index < 5; index += 1) {
      host.clock += 60_000
      await host.tick()
    }
    expect(polls).toBe(1)
  })
})

describe('two Claude Code processes on one session (claude --continue while the first runs)', () => {
  /** A second process: same disk and store, its own timers, clock and instance id; started `later` ms after the first. */
  function secondProcess(host: FakeHost, later = 1_000): FakeHost {
    const other = fakeHost()
    other.files = host.files
    other.store = host.store
    other.clock = host.clock + later
    other.randomHex = (bytes) => 'cd'.repeat(bytes)
    return other
  }

  async function bothTick(a: FakeHost, b: FakeHost) {
    await a.tick()
    await b.tick()
  }

  function feedback(text: string) {
    return { surface: 'annotate', decision: 'annotated', message: text, noop: false }
  }

  const delivered = (hosts: FakeHost[], text: string) => hosts.flatMap((h) => h.submits).filter((submit) => submit.includes(text))

  // The failure: the old process kept the reviews and received the decision
  // while the person worked in the new one (and plan review broke there).
  test('the process that restored later watches and delivers; the first forgets the review quietly', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.runCommand('annotate', 'notes.md')
    await host.tick()
    const other = secondProcess(host)
    const second = new PlannotatorMod(other, SESSION)
    await second.restore()
    await bothTick(other, host)

    decide(host, launches(host)[0]!, feedback('please fix'))
    // The first process looks first, with its lease answer cached from before: it must not deliver.
    await bothTick(host, other)
    await bothTick(host, other)

    expect(delivered([other], 'please fix')).toHaveLength(1)
    expect(host.submits).toEqual([])
    expect(host.statuses.at(-1)).toBeUndefined()
    expect(host.logs.filter((line) => line.includes('stopped') || line.includes('no longer running'))).toEqual([])
  })

  test('typing in the first process takes the reviews back there', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.runCommand('annotate', 'notes.md')
    const other = secondProcess(host)
    const second = new PlannotatorMod(other, SESSION)
    await second.restore()
    await bothTick(other, host)

    host.clock = other.clock + 1_000
    first.onPromptEntered({ text: 'back here', fromUs: false, originKind: 'composer' })
    await bothTick(host, other)
    decide(host, launches(host)[0]!, feedback('please fix'))
    await bothTick(other, host)
    await bothTick(other, host)

    expect(delivered([host], 'please fix')).toHaveLength(1)
    expect(other.submits).toEqual([])
  })

  test('a plan approval reaches the process the person works in, and its next ExitPlanMode passes', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.onPlanCall({ tool_use_id: 't1', plan: PLAN })
    await host.tick()
    const other = secondProcess(host)
    const second = new PlannotatorMod(other, SESSION)
    await second.restore()

    decide(host, launches(host)[0]!, { surface: 'plan', decision: 'approved', message: 'Plan approved.', noop: false, approvedPlan: PLAN })
    await bothTick(host, other)
    await bothTick(host, other)


    expect(delivered([other], PLAN_APPROVAL_NEXT_STEP)).toHaveLength(1)
    expect(host.submits).toEqual([])
    expect(await second.onPlanCall({ tool_use_id: 't2', plan: PLAN })).toEqual({ pass: true })
  })

  test('an approval the other process received still lets this one pass its ExitPlanMode', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const other = secondProcess(host, 0)
    const second = new PlannotatorMod(other, SESSION)
    await second.restore()
    const first = new PlannotatorMod(host, SESSION)
    await first.onPlanCall({ tool_use_id: 't1', plan: PLAN })
    decide(host, launches(host)[0]!, { surface: 'plan', decision: 'approved', message: 'Plan approved.', noop: false, approvedPlan: PLAN })
    await host.tick()
    expect(delivered([host], PLAN_APPROVAL_NEXT_STEP)).toHaveLength(1)

    expect(await second.onPlanCall({ tool_use_id: 't2', plan: PLAN })).toEqual({ pass: true })
    // Consumed: the first process does not pass the same approval again.
    expect('deny' in (await first.onPlanCall({ tool_use_id: 't3', plan: PLAN }))).toBe(true)
  })

  // The failure (reproduced on the per-file claim): one process claimed the
  // result record while the other, finding no record, claimed the exit code
  // and delivered the stdout copy too.
  test('a decision on disk as both a record and an exit code is delivered once when both check at once', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.runCommand('annotate', 'notes.md')
    const other = secondProcess(host, 0)
    const second = new PlannotatorMod(other, SESSION)
    await second.restore()
    const dir = launchDirOf(launches(host)[0]!)

    decide(host, launches(host)[0]!, feedback('please fix'))
    host.files.set(`${dir}/exit`, '0\n')
    host.files.set(`${dir}/stdout`, 'please fix (printed)')
    await Promise.all([host.tick(), other.tick()])
    await bothTick(host, other)

    expect(delivered([host, other], 'please fix')).toHaveLength(1)
  })

  test("the other process's claim stops this one whichever file it finds", async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'notes.md')
    const dir = launchDirOf(launches(host)[0]!)
    host.files.set(`${dir}/settled`, '')
    host.files.set(`${dir}/settled/by`, 'another-process')
    host.files.set(`${dir}/exit`, '0\n')
    host.files.set(`${dir}/stdout`, 'please fix (printed)')

    await host.tick()

    expect(host.submits).toEqual([])
    expect(host.logs.filter((line) => line.includes('stopped'))).toEqual([])
    expect(host.statuses.at(-1)).toBeUndefined()
  })

  // The failure: a claim made by a process call whose answer timed out read as
  // someone else's next tick, so the decision was never delivered.
  test('a claim whose answer was lost is retried by its claimant and delivered once', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'notes.md')
    const run = host.run
    let lost = 1
    host.run = async (argv, init) => {
      const answer = await run(argv, init)
      if (argv[3] === 'plannotator-claim' && lost-- > 0) throw new Error('process.run timed out')
      return answer
    }
    decide(host, launches(host)[0]!, feedback('please fix'))

    await host.tick()
    expect(host.submits).toEqual([])
    await host.tick()

    expect(delivered([host], 'please fix')).toHaveLength(1)
  })

  // The failure: the 1 s timer does not wait for a slow check, so a second
  // check of the same launch ran beside it; the claim names this instance,
  // so both checks won it and the decision went to Claude twice.
  test('overlapping ticks check a launch once', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'notes.md')
    const dir = launchDirOf(launches(host)[0]!)
    const exists = host.exists
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let stalls = 1
    host.exists = async (path) => {
      // The first check stalls on a slow file system call.
      if (path === `${dir}/settled` && stalls-- > 0) await held
      return exists(path)
    }
    decide(host, launches(host)[0]!, feedback('please fix'))

    await host.tick()
    await host.tick()
    release()
    await host.tick()
    await host.tick()

    expect(delivered([host], 'please fix')).toHaveLength(1)
  })

  test('when the watching process goes away, the other takes over and delivers', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.runCommand('annotate', 'notes.md')
    // Started at the same moment: a tie, which the first watcher keeps.
    const other = secondProcess(host, 0)
    const second = new PlannotatorMod(other, SESSION)
    await second.restore()
    await bothTick(host, other)

    // The first process is killed: no more ticks, no release. Its lease goes stale.
    other.clock += 25_000
    for (let index = 0; index < 5; index += 1) await other.tick()
    decide(host, launches(host)[0]!, feedback('please fix'))
    await other.tick()

    expect(delivered([other], 'please fix')).toHaveLength(1)
    expect(host.submits).toEqual([])
  })

  test('a process that exits hands its reviews over at once', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.runCommand('annotate', 'notes.md')
    const other = secondProcess(host, 0)
    const second = new PlannotatorMod(other, SESSION)
    await second.restore()
    await bothTick(host, other)

    first.dispose()
    for (let index = 0; index < 5; index += 1) await other.tick()
    decide(host, launches(host)[0]!, feedback('please fix'))
    await other.tick()

    expect(delivered([other], 'please fix')).toHaveLength(1)
  })

  test('a review the other process launched stays in the store when this one settles its own', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const first = new PlannotatorMod(host, SESSION)
    const other = secondProcess(host)
    serveOnLaunch(other)
    const second = new PlannotatorMod(other, SESSION)
    await second.restore()
    other.randomHex = (bytes) => 'ef'.repeat(bytes)
    await second.runCommand('annotate', 'theirs.md')
    await first.runCommand('annotate', 'mine.md')
    decide(host, launches(host)[0]!, feedback('done'))
    await host.tick()

    const stored = (host.store.get(STORE_LAUNCHES) as { subject: string }[]).map((record) => record.subject)
    expect(stored).toEqual(['theirs.md'])
  })
})

describe('stored launch records are pruned', () => {
  const record = (id: string, sessionId: string, startedAt: number) => ({
    id,
    sessionId,
    kind: 'annotate',
    dir: `/data/claude-code-mod/${sessionId}/${id}`,
    subject: `${id}.md`,
    startedAt,
  })

  test('after restore, off its path: what the script names is dropped; young records are not probed; records added meanwhile stay', async () => {
    const host = fakeHost()
    const old = host.clock - 10 * 60_000
    const ancient = host.clock - 30 * 24 * 60 * 60_000
    host.store.set(STORE_LAUNCHES, [
      record('cleaned', 'session-2', old),
      record('dead', 'session-2', old),
      record('live', 'session-2', old),
      record('forgotten', 'session-3', ancient),
      record('young', 'session-2', host.clock - 1_000),
      record('mine', 'session-1', old),
    ])
    const probes: (readonly string[])[] = []
    host.onRun = (call) => {
      if (call.argv[3] !== 'plannotator-prune') return
      probes.push(call.argv.slice(4))
      // Another process records a launch while the probe runs.
      const stored = host.store.get(STORE_LAUNCHES) as unknown[]
      host.store.set(STORE_LAUNCHES, [...stored, record('meanwhile', 'session-4', host.clock)])
      return {
        exitCode: 0,
        stdout: ['cleaned', 'dead', 'forgotten'].map((id) => `/data/claude-code-mod/${id === 'forgotten' ? 'session-3' : 'session-2'}/${id}`).join('\n'),
        stderr: '',
      }
    }

    const mod = new PlannotatorMod(host, SESSION)
    await mod.restore()
    await mod.pruning

    // This session's records only when cleaned up; others' also when dead; a long-unresumed session's also with a decision.
    expect(probes).toEqual([
      [
        '--cleaned',
        '/data/claude-code-mod/session-1/mine',
        '--dead',
        '/data/claude-code-mod/session-2/cleaned',
        '/data/claude-code-mod/session-2/dead',
        '/data/claude-code-mod/session-2/live',
        '--expired',
        '/data/claude-code-mod/session-3/forgotten',
      ],
    ])
    const kept = (host.store.get(STORE_LAUNCHES) as { id: string }[]).map((entry) => entry.id)
    expect(kept).toEqual(['live', 'young', 'mine', 'meanwhile'])
  })
})

// $.prompt.submit waits for Claude to be idle, so a claimed decision can wait
// as long as Claude's current turn runs. A claimant that quits meanwhile must
// not leave the decision stranded with nobody saying where it is.
describe('a decision claimed but never delivered', () => {
  const UNDELIVERED = "arrived but wasn't delivered"

  function secondProcess(host: FakeHost, later = 1_000): FakeHost {
    const other = fakeHost()
    other.files = host.files
    other.store = host.store
    other.clock = host.clock + later
    other.randomHex = (bytes) => 'cd'.repeat(bytes)
    return other
  }

  /** A process whose $.prompt.submit waits (Claude mid-turn) until `finish()`. */
  async function claimantWaitingForIdle() {
    const host = fakeHost()
    serveOnLaunch(host)
    let finish: () => void = () => undefined
    host.submit = (text) =>
      new Promise<void>((resolve) => {
        finish = () => {
          host.submits.push(text)
          resolve()
        }
      })
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('annotate', 'notes.md')
    const dir = launchDirOf(launches(host)[0]!)
    decide(host, launches(host)[0]!, { surface: 'annotate', decision: 'annotated', message: 'please fix', noop: false })
    await host.tick()
    return { host, mod, dir, finish: () => finish() }
  }

  test('a claimant that quit while Claude was busy: the next restore reports where the decision is, once, and delivers nothing', async () => {
    const { host, mod, dir } = await claimantWaitingForIdle()
    // The record stays while the decision waits.
    expect((host.store.get(STORE_LAUNCHES) as unknown[]).length).toBe(1)
    mod.dispose()

    const other = secondProcess(host)
    await new PlannotatorMod(other, SESSION).restore()

    const reports = other.logs.filter((line) => line.includes(UNDELIVERED))
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain(`${dir}/result.json`)
    expect(other.toasts).toHaveLength(1)
    expect(other.submits).toEqual([])

    const third = secondProcess(host, 2_000)
    third.randomHex = (bytes) => 'ef'.repeat(bytes)
    await new PlannotatorMod(third, SESSION).restore()
    expect(third.logs.filter((line) => line.includes(UNDELIVERED))).toEqual([])
  })

  test('a claimant still waiting is not reported; once it delivers, nothing is said', async () => {
    const { host, dir, finish } = await claimantWaitingForIdle()
    const other = secondProcess(host)
    await new PlannotatorMod(other, SESSION).restore()
    for (let index = 0; index < 10; index += 1) {
      host.clock += 1_000
      other.clock += 1_000
      await host.tick()
      await other.tick()
    }
    expect(other.logs.filter((line) => line.includes(UNDELIVERED))).toEqual([])

    finish()
    await host.tick()
    expect(host.submits.filter((text) => text.includes('please fix'))).toHaveLength(1)
    expect(host.files.has(`${dir}/settled/delivered`)).toBe(true)
    expect(host.store.get(STORE_LAUNCHES)).toEqual([])
    other.clock += 120_000
    for (let index = 0; index < 10; index += 1) await other.tick()
    expect(other.logs.filter((line) => line.includes(UNDELIVERED))).toEqual([])
  })

  test('a claimant killed while Claude was busy: the process watching it reports once its lease goes stale', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const first = new PlannotatorMod(host, SESSION)
    await first.runCommand('annotate', 'notes.md')
    const other = secondProcess(host)
    const second = new PlannotatorMod(other, SESSION)
    await second.restore()
    // The person works in the first process again; it claims, and Claude is mid-turn there.
    host.clock = other.clock + 1_000
    host.submit = () => new Promise<void>(() => undefined)
    first.onPromptEntered({ text: 'back here', fromUs: false, originKind: 'composer' })
    await host.tick()
    decide(host, launches(host)[0]!, { surface: 'annotate', decision: 'annotated', message: 'please fix', noop: false })
    await host.tick()
    expect(host.files.get(`${launchDirOf(launches(host)[0]!)}/settled/by`)).toBe('abababababababab')
    await other.tick()
    expect(other.logs.filter((line) => line.includes(UNDELIVERED))).toEqual([])

    // Killed: no ticks, no release. Its heartbeat stops.
    other.clock = host.clock + 61_000
    for (let index = 0; index < 10; index += 1) await other.tick()

    expect(other.logs.filter((line) => line.includes(UNDELIVERED))).toHaveLength(1)
    expect(other.submits).toEqual([])
  })
})
