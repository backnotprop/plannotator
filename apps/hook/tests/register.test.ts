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
function world(on: any, options: { files?: Map<string, string>; modEnv?: string; cliStderr?: string; fetch?: (e: any) => any } = {}) {
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
  // The mod is on by default: no knob set unless a test opts out.
  mock.env(on, options.modEnv === undefined ? { HOME: '/home/me' } : { HOME: '/home/me', PLANNOTATOR_CLAUDE_MOD: options.modEnv })
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
    if (argv[3] === 'plannotator-launch' && options.cliStderr !== undefined) {
      // A CLI that refuses the subcommand and exits at once.
      files.set(`${argv[4]}/stderr`, options.cliStderr)
      files.set(`${argv[4]}/exit`, '1\n')
    } else if (argv[3] === 'plannotator-launch') {
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
  on('http.fetch', ($: any, e: any) => ({ value: options.fetch?.(e) ?? { status: 404, ok: false, headers: {}, text: '' } }))
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

  // command.run is matched by name (#1740): every Plannotator command must
  // still reach the mod, the skill-held one (the world's command.list gives
  // the user a plannotator-review skill) and the two the mod registers alike;
  // a name the matcher missed would run the user's blocking skill instead.
  test('all three commands are answered by the mod, skill-held and registered; another plugin\'s command is not touched', async ($: any, on: any) => {
    const w = world(on)
    on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Here is the plan I wrote.' }] }))
    const reachedBeneath: string[] = []
    on('command.run', ($: any, e: any) => {
      reachedBeneath.push(e.command)
      return { text: `${e.command} ran beneath` }
    })
    await $.session.start(SESSION)

    expect(w.registered.sort()).toEqual(['plannotator-annotate', 'plannotator-last'])
    for (const [command, args, subcommand] of [
      ['plannotator-review', '', 'review'],
      ['plannotator-annotate', 'notes.md', 'annotate'],
      ['plannotator-last', '', 'annotate-last'],
    ]) {
      const { text } = await $.command.run({ command, args, origin: { kind: 'composer' } })
      expect(text).toContain('http://localhost:4321')
      expect(w.runs.some((argv) => argv[3] === 'plannotator-launch' && argv[6] === subcommand)).toBe(true)
    }
    const other = await $.command.run({ command: 'frontend-status', args: '', origin: { kind: 'composer' } })

    expect(other.text).toBe('frontend-status ran beneath')
    expect(reachedBeneath).toEqual(['frontend-status'])
  })

  test('knob off (PLANNOTATOR_CLAUDE_MOD=0): inert. ExitPlanMode and the skills reach the classic flow; nothing is registered or set', async ($: any, on: any) => {
    const w = world(on, { modEnv: '0' })
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

  test('knob off through config.json in the data dir', async ($: any, on: any) => {
    const files = new Map<string, string>([['/home/me/.plannotator', ''], ['/home/me/.plannotator/config.json', '{"claudeCodeMod": false}']])
    const w = world(on, { files })
    on('tool.call', () => ({ result: 'the classic flow ran' }))
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n\n1. Ship.\n' })

    expect(answer.result).toBe('the classic flow ran')
    expect(w.runs).toEqual([])
    expect(w.tools).toEqual([])
  })

  // The agent tool switch turns off ONLY the tool: a user who wants it out of
  // Claude's tool list keeps the slash commands, non-blocking plan review and
  // the Bash take-over (which adds nothing to Claude's context).
  test('agentTool off in config.json: no plannotator tool; plan review, commands and the Bash take-over still run', async ($: any, on: any) => {
    const files = new Map<string, string>([['/home/me/.plannotator', ''], ['/home/me/.plannotator/config.json', '{"agentTool": false}']])
    const w = world(on, { files })
    const ran: string[] = []
    on('tool.call', ($: any, e: any) => {
      ran.push(e.tool)
      return { result: 'the classic flow ran' }
    })
    await $.session.start(SESSION)

    expect(w.tools).toEqual([])
    const plan = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n\n1. Ship.\n' })
    expect(plan.deny).toContain('NOT approved')
    const command = await $.command.run({ command: 'plannotator-review', args: '', origin: { kind: 'composer' } })
    expect(command.text).toContain('http://localhost:4321')
    const bash = await $.tool.call({ tool: 'Bash', command: 'plannotator annotate /work/a.md' })
    expect(bash.result.stdout).toContain('http://localhost:4321')
    expect(ran).toEqual([])
  })

  // Version skew: the plugin updates from main, the binary on its own. A CLI
  // with no claude-mod-plan (0.27.25 prints this) must leave plan review to the
  // classic flow, every time, instead of failing the call.
  test('a CLI without claude-mod-plan: ExitPlanMode reaches the classic flow, with one line saying why', async ($: any, on: any) => {
    const w = world(on, { cliStderr: "Unknown command: claude-mod-plan\n\nRun 'plannotator --help' for the list of commands.\n" })
    on('tool.call', () => ({ result: 'the classic flow ran' }))
    await $.session.start(SESSION)

    const first = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n\n1. Ship.\n' })
    const second = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n\n1. Ship.\n2. Test.\n' })

    expect(first.result).toBe('the classic flow ran')
    expect(second.result).toBe('the classic flow ran')
    expect(w.runs.filter((argv) => argv[3] === 'plannotator-launch')).toHaveLength(1)
    expect(w.logs.filter((line) => line.includes('classic review'))).toHaveLength(1)
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

  test('Claude running the CLI through Bash gets the tool: answered at once, the command never runs', async ($: any, on: any) => {
    const w = world(on)
    const ran: string[] = []
    on('tool.call', ($: any, e: any) => {
      ran.push(e.command)
      return { result: { stdout: 'the command ran', stderr: '', interrupted: false } }
    })
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: 'Bash', command: 'plannotator annotate /work/INDEX.html --gate --json' })

    expect(ran).toEqual([])
    expect(answer.result.stdout).toContain('http://localhost:4321')
    expect(answer.result.stdout).toContain('End your turn')
    const launch = w.runs.find((argv) => argv[3] === 'plannotator-launch')
    expect(launch?.slice(5)).toEqual(['plannotator', 'annotate', '/work/INDEX.html', '--gate'])
  })

  test('a list of files is one review: one launch, the paths in order, named as a bundle', async ($: any, on: any) => {
    const w = world(on)
    const ran: string[] = []
    on('tool.call', ($: any, e: any) => {
      ran.push(e.command)
      return { result: { stdout: 'the command ran', stderr: '', interrupted: false } }
    })
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: TOOL, action: 'annotate', target: ['spec.md', 'ui/mock.html'] })
    expect(answer.result).toContain('2 files: spec.md, mock.html')
    const launches = w.runs.filter((argv) => argv[3] === 'plannotator-launch')
    expect(launches).toHaveLength(1)
    expect(launches[0]?.slice(5)).toEqual(['plannotator', 'annotate', 'spec.md', 'ui/mock.html'])

    // The same through Bash: several file paths are taken over as the list.
    const bash = await $.tool.call({ tool: 'Bash', command: 'plannotator annotate a.md b.md --json' })
    expect(ran).toEqual([])
    expect(bash.result.stdout).toContain('2 files: a.md, b.md')
  })

  test('Bash commands the tool cannot represent run as written', async ($: any, on: any) => {
    const w = world(on)
    const ran: string[] = []
    on('tool.call', ($: any, e: any) => {
      ran.push(e.command)
      return { result: { stdout: 'the command ran', stderr: '', interrupted: false } }
    })
    await $.session.start(SESSION)
    const commands = [
      'plannotator annotate a.md --gate --json --require-approval',
      'plannotator annotate a.md --gate --json | jq .decision',
      'cd docs && plannotator annotate a.md',
      './plannotator review',
    ]

    for (const command of commands) await $.tool.call({ tool: 'Bash', command })
    // A subagent may work in its own cwd/worktree: its command runs for real.
    await $.tool.call({ tool: 'Bash', agentId: 'sub-1', command: 'plannotator review' })

    expect(ran).toEqual([...commands, 'plannotator review'])
    expect(w.runs.some((argv) => argv[3] === 'plannotator-launch')).toBe(false)
  })

  // list makes a GET through $.http.fetch with no body (the engine's real
  // fetch shape); close a POST. Both reach the review's server, nothing else.
  test('list and close go through $.http.fetch to the review\'s own server', async ($: any, on: any) => {
    const asked: { method: string; url: string; body: unknown }[] = []
    const w = world(on, {
      fetch: (e: any) => {
        asked.push({ method: e.init?.method, url: e.url, body: e.init?.body })
        if (e.url.endsWith('/api/host/status')) {
          return { status: 200, ok: true, headers: {}, text: JSON.stringify({ kind: 'annotate', documents: [], unsentAnnotations: 2, decided: false }) }
        }
        if (e.url.endsWith('/api/host/close')) return { status: 200, ok: true, headers: {}, text: JSON.stringify({ unsentAnnotations: 2 }) }
        return undefined
      },
    })
    await $.session.start(SESSION)
    const opened = await $.tool.call({ tool: TOOL, action: 'annotate', target: 'notes.md' })
    const id = /Session: (pn-[0-9a-f]{6})/.exec(opened.result)?.[1]
    expect(id).toBeDefined()

    const listed = await $.tool.call({ tool: TOOL, action: 'list' })
    expect(listed.result).toContain(`${id} · annotate`)
    expect(listed.result).toContain('unsent: 2')
    const status = asked.find((call) => call.url.endsWith('/api/host/status'))
    expect(status?.method).toBe('GET')
    // The engine's fetch is handed no body for a GET.
    expect(status?.body).toBeUndefined()

    const closed = await $.tool.call({ tool: TOOL, action: 'close', session: id })
    expect(closed.result).toContain('2 unsent comments')
    expect(asked.find((call) => call.url.endsWith('/api/host/close'))?.method).toBe('POST')
    expect(asked.every((call) => call.url.startsWith('http://127.0.0.1:4321/'))).toBe(true)
    expect(w.submits).toEqual([])
  })

  test('knob off (PLANNOTATOR_CLAUDE_MOD=0): a Bash plannotator command runs as written', async ($: any, on: any) => {
    const w = world(on, { modEnv: '0' })
    on('tool.call', () => ({ result: { stdout: 'the command ran', stderr: '', interrupted: false } }))
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: 'Bash', command: 'plannotator annotate a.md --gate --json' })

    expect(answer.result.stdout).toBe('the command ran')
    expect(w.runs).toEqual([])
  })
})
