import { describe, expect, test } from 'bun:test'
import { PlannotatorMod } from './controller'
import { answerShellCall, shellTakeOver } from './take-over'
import { fakeHost, type FakeHost, type RunCall } from './testing/fake-host'

const SESSION = { sessionId: 'session-1', dataDir: '/data', interactive: true }

function isLaunch(call: RunCall): boolean {
  return call.argv[0] === '/bin/sh' && call.argv[3] === 'plannotator-launch'
}

function serveOnLaunch(host: FakeHost, port = 4321) {
  host.onRun = (call) => {
    if (isLaunch(call)) host.files.set(`${call.argv[4]}/ready`, `${JSON.stringify({ url: `http://localhost:${port}`, isRemote: false, port })}\n`)
  }
}

/** What register.ts does with a Bash call: the answer, or 'run' when the command runs as written. */
async function bashCall(mod: PlannotatorMod, command: string, agentId?: string) {
  const input = shellTakeOver(command, !!agentId)
  if (!input) return 'run' as const
  return answerShellCall(mod, input)
}

// The failure: Claude runs the CLI through Bash (the owner's case: annotate
// INDEX.html --gate --json), the session blocks, and Ask AI offers separate
// AIs because the server was started without the session's bridge token.
describe('Bash take-over', () => {
  test('an agent-run annotate opens through the tool launch, with the bridge, and answers with the tool text', async () => {
    const host = fakeHost()
    serveOnLaunch(host, 7070)
    const mod = new PlannotatorMod(host, SESSION)

    const answer = await bashCall(mod, 'plannotator annotate /work/INDEX.html --gate --json')
    const viaTool = await mod.runTool({ action: 'annotate', target: '/work/INDEX.html', gate: true })

    const [byBash, byTool] = host.runs.filter(isLaunch)
    expect(byBash?.argv.slice(5)).toEqual(['plannotator', 'annotate', '/work/INDEX.html', '--gate'])
    expect(byBash?.argv.slice(5)).toEqual(byTool?.argv.slice(5))
    expect(byBash?.env?.PLANNOTATOR_SESSION_BRIDGE_TOKEN?.length).toBeGreaterThanOrEqual(32)
    expect(byBash?.env?.PLANNOTATOR_HOST_RESULT_FILE).toBe(`${byBash?.argv[4]}/result.json`)
    // The Bash result is the tool's own text, in the Bash tool's record shape
    // (each launch names its own session id, so that line differs).
    const withoutSession = (text: string) => text.replace(/^Session: pn-[0-9a-f]{6}\n/, '')
    expect(answer).toEqual({ result: { stdout: expect.stringMatching(/^Session: pn-[0-9a-f]{6}\n/), stderr: '', interrupted: false } })
    const bashText = 'result' in answer ? answer.result.stdout : ''
    expect(withoutSession(bashText)).toBe(withoutSession('text' in viaTool ? viaTool.text : ''))
    expect(JSON.stringify(answer)).toContain('http://localhost:7070')
  })

  test('a gated agent-run annotate delivers the bare approval, as the tool does', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)
    await bashCall(mod, 'plannotator annotate spec.md --gate --json')

    const [launch] = host.runs.filter(isLaunch)
    host.files.set(`${launch?.argv[4]}/result.json`, JSON.stringify({ v: 1, surface: 'annotate', decision: 'approved', message: 'The user approved.', noop: true }))
    await host.tick()

    expect(host.submits).toHaveLength(1)
    expect(host.submits[0]).toContain('The user approved.')
  })

  test('a startup failure is an error result for the Bash call', async () => {
    const host = fakeHost()
    host.onRun = (call) => {
      if (isLaunch(call)) {
        host.files.set(`${call.argv[4]}/stderr`, 'File not found: nope.md')
        host.files.set(`${call.argv[4]}/exit`, '1')
      }
    }
    const mod = new PlannotatorMod(host, SESSION)

    const answer = await bashCall(mod, 'plannotator annotate nope.md')
    expect('deny' in (answer as object) && (answer as { deny: string }).deny).toContain('File not found: nope.md')
  })

  test('strict gates, pipelines and compound commands run as written, and nothing launches', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)

    for (const command of [
      'plannotator annotate a.md --gate --json --require-approval',
      'plannotator annotate a.md --gate --json --result-file out.json',
      'plannotator annotate a.md --gate --json | jq .decision',
      'cd docs && plannotator annotate a.md',
      'git status',
    ]) {
      expect([command, await bashCall(mod, command)]).toEqual([command, 'run'])
    }
    expect(host.runs.filter(isLaunch)).toHaveLength(0)
  })

  // The failure: a subagent working in its own worktree runs `plannotator
  // review` and the mod, launching in the session's cwd, opens the wrong diff.
  test('a subagent\'s command always runs as written', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    host.transcript = [{ role: 'assistant', text: 'Main session answer.' }]
    const mod = new PlannotatorMod(host, SESSION)

    for (const command of ['plannotator review', 'plannotator annotate notes.md --gate --json', 'plannotator last']) {
      expect([command, await bashCall(mod, command, 'agent-7')]).toEqual([command, 'run'])
    }
    expect(host.runs.filter(isLaunch)).toHaveLength(0)
  })

  test('a dev build run by path runs for real', async () => {
    const host = fakeHost()
    serveOnLaunch(host)
    const mod = new PlannotatorMod(host, SESSION)

    expect(await bashCall(mod, './plannotator review')).toBe('run')
    expect(await bashCall(mod, '/tmp/dev/plannotator annotate x.md')).toBe('run')
    expect(host.runs.filter(isLaunch)).toHaveLength(0)
  })
})
