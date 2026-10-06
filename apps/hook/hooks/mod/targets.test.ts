import { describe, expect, test } from 'bun:test'
import { PlannotatorMod } from './controller'
import { fakeHost, type FakeHost, type RunCall } from './testing/fake-host'

// The failure these guard (a real report): an approval for
// releases-2026-10-04/QUESTIONS.md arrived as "Plannotator: QUESTIONS.md —
// Approved." with no path, and the agent took the File: line of an earlier
// decision about a DIFFERENT QUESTIONS.md and acted on the wrong file.

const SESSION = { sessionId: 'session-1', dataDir: '/data', interactive: true }
const NEW = '/work/releases-2026-10-04/QUESTIONS.md'
const OLD = '/work/releases-2026-09-20/QUESTIONS.md'

function isLaunch(call: RunCall): boolean {
  return call.argv[0] === '/bin/sh' && call.argv[3] === 'plannotator-launch'
}

function dirOf(call: RunCall): string {
  return call.argv[4] as string
}

/** The CLI comes up for each launch on its own port, naming `targets[i]` (or nothing: an older CLI). */
function serve(host: FakeHost, targets: (string | string[] | undefined)[], cwd = '/work') {
  let index = 0
  host.onRun = (call) => {
    if (call.argv[3] === 'plannotator-mkdir') return { exitCode: 0, stdout: `${cwd}\n`, stderr: '' }
    if (!isLaunch(call)) return undefined
    const target = targets[index]
    const port = 4000 + index
    index += 1
    host.files.set(
      `${dirOf(call)}/ready`,
      `${JSON.stringify({ url: `http://localhost:${port}`, isRemote: false, port, ...(target ? { target } : {}) })}\n`,
    )
    return undefined
  }
}

function launches(host: FakeHost): RunCall[] {
  return host.runs.filter(isLaunch)
}

function decide(host: FakeHost, call: RunCall, record: Record<string, unknown>) {
  host.files.set(`${dirOf(call)}/result.json`, JSON.stringify({ v: 1, ...record }))
}

const APPROVED = { surface: 'annotate', decision: 'approved', message: 'The user approved.', noop: true }

describe('decision targets (two files named QUESTIONS.md)', () => {
  test('each decision names its own full path, and the subjects are told apart', async () => {
    const host = fakeHost()
    serve(host, [OLD, NEW])
    const mod = new PlannotatorMod(host, SESSION)

    const first = await mod.runTool({ action: 'annotate', target: 'releases-2026-09-20/QUESTIONS.md', gate: true })
    const second = await mod.runTool({ action: 'annotate', target: 'releases-2026-10-04/QUESTIONS.md', gate: true })

    // The tool's own text names the full path the server opened.
    expect('text' in second && second.text).toContain(`Target: ${NEW}`)
    expect('text' in first && first.text).toContain(`Target: ${OLD}`)
    // Two open reviews of a QUESTIONS.md: the status line tells them apart.
    expect(host.statuses.at(-1)).toContain('releases-2026-09-20/QUESTIONS.md')
    expect(host.statuses.at(-1)).toContain('releases-2026-10-04/QUESTIONS.md')

    const [oldLaunch, newLaunch] = launches(host)
    decide(host, oldLaunch!, { surface: 'annotate', decision: 'annotated', message: `File: ${OLD}\n\nfix it`, noop: false, target: OLD })
    await host.tick()
    decide(host, newLaunch!, { ...APPROVED, target: NEW })
    await host.tick()

    expect(host.submits).toHaveLength(2)
    expect(host.submits[0]).toContain(`Target: ${OLD}`)
    // The bare approval: the heading names the right file in full, and never the other one.
    const approval = host.submits[1] as string
    expect(approval.split('\n')[0]).toContain('releases-2026-10-04/QUESTIONS.md')
    expect(approval.split('\n')[0]).toContain('Approved')
    expect(approval).toContain(`Target: ${NEW}`)
    expect(approval).not.toContain(OLD)
  })

  test('an older CLI (no target anywhere): an absolute path the agent named is the Target', async () => {
    const host = fakeHost()
    serve(host, [undefined])
    const mod = new PlannotatorMod(host, SESSION)

    const opened = await mod.runTool({ action: 'annotate', target: NEW, gate: true })
    expect('text' in opened && opened.text).toContain(`Target: ${NEW}`)
    decide(host, launches(host)[0]!, APPROVED)
    await host.tick()

    expect(host.submits[0]).toContain(`Target: ${NEW}`)
    expect(host.logs.join('\n')).not.toContain('as recorded when it opened')
  })

  // The CLI may find a bare or relative name elsewhere in the project, so the
  // mod must not assert a path it only guessed: no Target line beats a wrong one.
  test('an older CLI with a relative or bare name: no guessed Target line, in the opened text or the decision', async () => {
    for (const word of ['releases-2026-10-04/QUESTIONS.md', 'QUESTIONS.md']) {
      const host = fakeHost()
      serve(host, [undefined])
      const mod = new PlannotatorMod(host, SESSION)

      const opened = await mod.runTool({ action: 'annotate', target: word, gate: true })
      expect('text' in opened && opened.text).not.toContain('Target:')
      decide(host, launches(host)[0]!, APPROVED)
      await host.tick()
      expect(host.submits[0]).not.toContain('Target:')
    }
  })

  test('review prose is never read as a directory; a review with no words names the session directory', async () => {
    const host = fakeHost()
    serve(host, [undefined, undefined])
    const mod = new PlannotatorMod(host, SESSION)

    await mod.runCommand('review', 'please look at the auth changes')
    await mod.runCommand('review', '')
    const [prose, bare] = launches(host)
    decide(host, prose!, { surface: 'review', decision: 'annotated', message: 'fix', noop: false })
    await host.tick()
    decide(host, bare!, { surface: 'review', decision: 'annotated', message: 'fix', noop: false })
    await host.tick()

    expect(host.submits[0]).not.toContain('Target:')
    expect(host.submits[1]).toContain('Target: /work\n')
  })

  test('a review switched in place to another PR is headed and targeted as that PR', async () => {
    const host = fakeHost()
    serve(host, ['https://github.com/o/r/pull/12'])
    const mod = new PlannotatorMod(host, SESSION)

    await mod.runTool({ action: 'review', target: 'https://github.com/o/r/pull/12' })
    decide(host, launches(host)[0]!, {
      surface: 'review',
      decision: 'annotated',
      message: 'fix the handler',
      noop: false,
      target: 'https://github.com/o/r/pull/13',
    })
    await host.tick()

    expect(host.submits[0]?.split('\n').slice(0, 2)).toEqual([
      expect.stringContaining('Plannotator: PR #13 ('),
      'Target: https://github.com/o/r/pull/13',
    ])
  })

  test('the target and the told-apart subject survive a restart (reattach from the store)', async () => {
    const host = fakeHost()
    serve(host, [OLD, NEW])
    const first = new PlannotatorMod(host, SESSION)
    await first.runTool({ action: 'annotate', target: 'releases-2026-09-20/QUESTIONS.md', gate: true })
    await first.runTool({ action: 'annotate', target: 'releases-2026-10-04/QUESTIONS.md', gate: true })
    first.dispose()

    const second = new PlannotatorMod(host, SESSION)
    await second.restore()
    decide(host, launches(host)[1]!, APPROVED)
    await host.tick()
    await host.tick()

    const approval = host.submits.find((text) => text.includes('Approved')) ?? ''
    expect(approval.split('\n')[0]).toContain('releases-2026-10-04/QUESTIONS.md')
    expect(approval).toContain(`Target: ${NEW}`)
  })

  test("the record's target wins over the launch's, and a difference is said", async () => {
    const host = fakeHost()
    serve(host, [NEW])
    const mod = new PlannotatorMod(host, SESSION)

    await mod.runTool({ action: 'annotate', target: 'releases-2026-10-04/QUESTIONS.md', gate: true })
    decide(host, launches(host)[0]!, { ...APPROVED, target: OLD })
    await host.tick()

    expect(host.submits[0]).toContain(`Target: ${OLD}`)
    expect(host.submits[0]).not.toContain(`Target: ${NEW}`)
    expect(host.logs.join('\n')).toContain('as recorded when it opened')
  })

  test('the launch passes its pn- id to the CLI for the sessions registry', async () => {
    const host = fakeHost()
    serve(host, [NEW])
    const mod = new PlannotatorMod(host, SESSION)

    const opened = await mod.runTool({ action: 'annotate', target: NEW })

    const id = /Session: (pn-[0-9a-f]{6})/.exec('text' in opened ? opened.text : '')?.[1]
    expect(id).toBeDefined()
    expect(launches(host)[0]?.env?.PLANNOTATOR_HOST_REVIEW_ID).toBe(id)
  })
})

// `/plannotator-annotate . a.md` opens a.md alone (the CLI's shared selection
// drops the stray `.`), but the subject used to come from the typed words:
// "2 files: ., a.md" in the command reply, status line and decision heading.
describe('subjects come from what the CLI opened', () => {
  test('a stray `.` beside a file: the subject is the file the CLI opened', async () => {
    const host = fakeHost()
    serve(host, ['/work/a.md'])
    const mod = new PlannotatorMod(host, SESSION)

    const reply = await mod.runCommand('annotate', '. a.md')
    expect(reply).toContain('Opened a.md in Plannotator')
    expect(reply).not.toContain('2 files')
    expect(host.statuses.at(-1)).toBe('a.md · waiting for you')

    decide(host, launches(host)[0]!, { surface: 'annotate', decision: 'annotated', message: 'fix it', noop: false, target: '/work/a.md' })
    await host.tick()
    expect(host.submits[0]?.split('\n').slice(0, 2)).toEqual([expect.stringMatching(/^Plannotator: a\.md \(pn-[0-9a-f]{6}\) — /), 'Target: /work/a.md'])
  })

  test('a bundle typed with prose words names only the files the CLI opened', async () => {
    const host = fakeHost()
    serve(host, [['/work/docs/spec.md', '/work/mock.html']])
    const mod = new PlannotatorMod(host, SESSION)

    const reply = await mod.runCommand('annotate', 'docs/spec.md and mock.html please')
    expect(reply).toContain('Opened 2 files: spec.md, mock.html in Plannotator')
    expect(host.statuses.at(-1)).toBe('2 files: spec.md, mock.html · waiting for you')
  })

  test('the tool: a bundle is named by the resolved files, the full paths only in the Target lines', async () => {
    const host = fakeHost()
    serve(host, [['/work/docs/spec.md', '/work/mock.html']])
    const mod = new PlannotatorMod(host, SESSION)

    const opened = await mod.runTool({ action: 'annotate', target: ['spec.md', 'mock.html'] })
    const text = 'text' in opened ? opened.text : ''
    expect(text).toContain('Opened 2 files: spec.md, mock.html in Plannotator')
    expect(text).toContain('Targets:\n- /work/docs/spec.md\n- /work/mock.html')
  })

  test('review prose: named by the directory the CLI reviewed; no words stays "local changes"', async () => {
    const host = fakeHost()
    serve(host, ['/work/repo', '/work/repo'])
    const mod = new PlannotatorMod(host, SESSION)

    expect(await mod.runCommand('review', 'please look at this')).toContain('Opened changes in repo in Plannotator')
    expect(await mod.runCommand('review', '')).toContain('Opened local changes in Plannotator')
  })

  test('an older CLI that reports no target keeps the subject from the typed words', async () => {
    const host = fakeHost()
    serve(host, [undefined])
    const mod = new PlannotatorMod(host, SESSION)

    expect(await mod.runCommand('annotate', 'docs/spec.md mock.html')).toContain('Opened 2 files: spec.md, mock.html in Plannotator')
    expect(host.statuses.at(-1)).toBe('2 files: spec.md, mock.html · waiting for you')
  })
})
