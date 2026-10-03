// Run with `claude plugin test apps/hook` (Claude Code's mod harness: the
// engine's own `$`, this plugin loaded as it ships). Not a bun test: bun skips
// this folder (bunfig.toml pathIgnorePatterns). The logic is covered by the
// bun tests beside the sources in hooks/mod/.
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

/** The world beneath the mod: a session, a file map, and a CLI that comes up at once. */
function world(on: any, options: { files?: Map<string, string> } = {}) {
  const files = options.files ?? new Map<string, string>()
  const runs: string[][] = []
  const submits: string[] = []
  const logs: string[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.list', () => ({ value: [{ name: 'plannotator-review', description: 'skill', source: 'user' }] }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  mock.env(on, { HOME: '/home/me' })
  const env = new Map<string, string | undefined>()
  on('env.set', ($: any, e: any) => {
    env.set(e.name, e.value)
    return { value: undefined }
  })
  mock.store(on, {})
  const clock = mock.clock(on)
  on('fs.exists', ($: any, e: any) => ({ value: files.has(e.path) || e.path === '/bin/sh' }))
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($: any, e: any) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = [...e.argv]
    runs.push(argv)
    if (argv[3] === 'plannotator-launch') {
      files.set(`${argv[4]}/ready`, `${JSON.stringify({ url: 'http://localhost:4321', isRemote: false, port: 4321 })}\n`)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('prompt.submit', ($: any, e: any) => {
    submits.push(e.text)
    return { text: e.text, origin: e.origin }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  // The bridge: no server answers (an older binary), so the loop stops.
  on('http.fetch', () => ({ value: { status: 404, ok: false, headers: {}, text: '' } }))
  return { files, runs, submits, logs, clock, env }
}

describe('register', () => {
  test('ExitPlanMode is answered with deny at once and the review starts detached', async ($: any, on: any) => {
    const w = world(on)
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n\n1. Ship.\n' })

    expect(answer.deny).toContain('NOT approved')
    // The session tag every process the session starts inherits.
    expect(w.env.get('PLANNOTATOR_SESSION_TAG')).toBe('claude-code:session-1')
    const launch = w.runs.find((argv) => argv[3] === 'plannotator-launch')
    expect(launch?.slice(5)).toEqual(['plannotator', 'claude-mod-plan'])
  })

  test('the decision arrives later as a plugin turn', async ($: any, on: any) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n\n1. Ship.\n' })
    const dir = w.runs.find((argv) => argv[3] === 'plannotator-launch')?.[4]
    w.files.set(
      `${dir}/result.json`,
      JSON.stringify({ v: 1, surface: 'plan', decision: 'denied', message: 'YOUR PLAN WAS NOT APPROVED.\n\nadd tests', noop: false }),
    )

    await w.clock.advance(1_000)

    expect(w.submits).toHaveLength(1)
    expect(w.submits[0]).toContain('add tests')
  })

  test("the user's /plannotator-review skill is answered by the mod and returns at once", async ($: any, on: any) => {
    const w = world(on)
    await $.session.start(SESSION)

    const { text } = await $.command.run({ command: 'plannotator-review', args: '', origin: { kind: 'composer' } })

    expect(text).toContain('http://localhost:4321')
    expect(w.runs.some((argv) => argv.includes('review'))).toBe(true)
  })

  test('a -p session keeps the classic flow: ExitPlanMode is not touched', async ($: any, on: any) => {
    world(on)
    on('tool.call', () => ({ result: 'the classic flow ran' }))
    await $.session.start({ ...SESSION, surface: null, isInteractive: false })

    const answer = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n' })

    expect(answer.result).toBe('the classic flow ran')
  })
})
