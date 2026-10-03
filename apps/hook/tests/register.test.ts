// Run with `claude plugin test apps/hook` (Claude Code's mod harness: the
// engine's own `$`, this plugin loaded as it ships). Not a bun test: bun skips
// this folder (bunfig.toml pathIgnorePatterns). The logic is covered by the
// bun tests beside the sources in hooks/mod/.
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

/** What the engine names a plugin's registered tool (the mock answers with this). */
const TOOL_PREFIX = 'mcp__plugin_plannotator_tools__'
const TOOL = `${TOOL_PREFIX}plannotator`

/** The world beneath the mod: a session, a file map, and a CLI that comes up at once. */
function world(on: any, options: { files?: Map<string, string>; enabled?: boolean } = {}) {
  const files = options.files ?? new Map<string, string>()
  const runs: string[][] = []
  const submits: string[] = []
  const logs: string[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.list', () => ({ value: [{ name: 'plannotator-review', description: 'skill', source: 'user' }] }))
  const registered: string[] = []
  on('command.register', ($: any, e: any) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  const tools: { name: string; inputSchema: any }[] = []
  on('tool.register', ($: any, e: any) => {
    tools.push({ name: e.name, inputSchema: e.inputSchema })
    return { value: { tool: `${TOOL_PREFIX}${e.name}` } }
  })
  // The mod is opt-in; most tests turn it on through the env knob.
  mock.env(on, options.enabled === false ? { HOME: '/home/me' } : { HOME: '/home/me', PLANNOTATOR_CLAUDE_MOD: '1' })
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
  return { files, runs, submits, logs, clock, env, registered, tools }
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

  test('knob off: inert. ExitPlanMode and the skills reach the classic flow; nothing is registered or set', async ($: any, on: any) => {
    const w = world(on, { enabled: false })
    on('tool.call', () => ({ result: 'the classic flow ran' }))
    on('command.run', () => ({ text: 'the skill ran' }))
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n' })
    const { text } = await $.command.run({ command: 'plannotator-review', args: '', origin: { kind: 'composer' } })

    expect(answer.result).toBe('the classic flow ran')
    expect(text).toBe('the skill ran')
    expect(w.runs).toEqual([])
    expect(w.registered).toEqual([])
    expect(w.tools).toEqual([])
    expect(w.env.size).toBe(0)
  })

  test('the plannotator tool is registered and a call opens the session detached and returns at once', async ($: any, on: any) => {
    const w = world(on)
    await $.session.start(SESSION)

    expect(w.tools.map((tool) => tool.name)).toEqual(['plannotator'])
    expect(w.tools[0]?.inputSchema.required).toEqual(['action'])

    const answer = await $.tool.call({ tool: TOOL, action: 'annotate', target: 'notes.md', gate: true })

    expect(answer.result).toContain('http://localhost:4321')
    expect(answer.result).toContain('End your turn')
    const launch = w.runs.find((argv) => argv[3] === 'plannotator-launch')
    expect(launch?.slice(5)).toEqual(['plannotator', 'annotate', 'notes.md', '--gate'])
  })

  test('a bad tool call is an error result and launches nothing', async ($: any, on: any) => {
    const w = world(on)
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: TOOL, action: 'annotate' })

    expect(answer.deny).toContain('needs a target')
    expect(w.runs.some((argv) => argv[3] === 'plannotator-launch')).toBe(false)
  })

  test('a subagent cannot annotate the main session\'s last message through the tool', async ($: any, on: any) => {
    const w = world(on)
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: TOOL, agentId: 'sub-1', action: 'last' })

    expect(answer.deny).toContain('subagent')
    expect(w.runs.some((argv) => argv[3] === 'plannotator-launch')).toBe(false)
  })

  test('the tool-opened review delivers its feedback later as a plugin turn', async ($: any, on: any) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: TOOL, action: 'annotate', target: 'notes.md' })
    const dir = w.runs.find((argv) => argv[3] === 'plannotator-launch')?.[4]
    w.files.set(`${dir}/result.json`, JSON.stringify({ v: 1, surface: 'annotate', decision: 'annotated', message: 'fix line 3', noop: false, annotationCount: 1 }))

    await w.clock.advance(1_000)

    expect(w.submits).toHaveLength(1)
    expect(w.submits[0]).toContain('fix line 3')
  })

  test('knob on through config.json in the data dir', async ($: any, on: any) => {
    const files = new Map<string, string>([['/home/me/.plannotator', ''], ['/home/me/.plannotator/config.json', '{"claudeCodeMod": true}']])
    const w = world(on, { enabled: false, files })
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n\n1. Ship.\n' })

    expect(answer.deny).toContain('NOT approved')
    expect(w.runs.some((argv) => argv[3] === 'plannotator-launch')).toBe(true)
  })

  test('a -p session keeps the classic flow: ExitPlanMode is not touched', async ($: any, on: any) => {
    const w = world(on)
    on('tool.call', () => ({ result: 'the classic flow ran' }))
    await $.session.start({ ...SESSION, surface: null, isInteractive: false })

    const answer = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n' })

    expect(answer.result).toBe('the classic flow ran')
    // No plannotator tool either: a later plugin turn would have nowhere to land.
    expect(w.tools).toEqual([])
  })
})
