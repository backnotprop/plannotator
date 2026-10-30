// Run with `claude plugin test apps/hook` (Claude Code's mod harness: the
// engine's own `$`, this plugin loaded as it ships). Not a bun test: bun skips
// this folder (bunfig.toml pathIgnorePatterns). The logic is covered by the
// bun tests beside the sources in hooks/mod/.
import { describe, expect, mock, test, tier } from 'claude-code/testing'
import { inboxReminderText } from '../hooks/mod/inbox-contract'

tier('user')

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

/** What the engine names a plugin's registered tool (the mock answers with this). */
const TOOL_PREFIX = 'mcp__plugin_plannotator_tools__'
const TOOL = `${TOOL_PREFIX}plannotator`

/** The world beneath the mod: a session, a file map, and a CLI that comes up at once. */
function world(
  on: any,
  options: {
    files?: Map<string, string>
    modEnv?: string
    env?: Record<string, string>
    cliStderr?: string
    /** Answers `$.http.fetch` (a value, or a promise of one: a slow Inbox). */
    fetch?: (e: any) => any
    sessionId?: () => string
    /** Tool names `$.tool.register` refuses, as a session without a tool registrar would. */
    refuseTools?: string[]
    /** Answers a process run itself (its result value), or undefined for the default. */
    run?: (argv: string[], files: Map<string, string>) => { exitCode: number; stdout: string; stderr: string } | undefined
    /** What the mod's `$.store` holds at the start. */
    store?: Record<string, unknown>
    /** Prompts the bottom drops (as a settings hook's block would), by their text. */
    dropPrompt?: (text: string) => boolean
  } = {},
) {
  const files = options.files ?? new Map<string, string>()
  const runs: string[][] = []
  const submits: string[] = []
  const logs: string[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: options.sessionId?.() ?? 'session-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('command.list', () => ({ value: [{ name: 'plannotator-review', description: 'skill', source: 'user' }] }))
  const registered: string[] = []
  on('command.register', ($: any, e: any) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  const tools: { name: string; inputSchema: any }[] = []
  on('tool.register', ($: any, e: any) => {
    if (options.refuseTools?.includes(e.name)) return { deny: `no tool registrar for ${e.name}` }
    tools.push({ name: e.name, inputSchema: e.inputSchema })
    return { value: { tool: `${TOOL_PREFIX}${e.name}` } }
  })
  // The mod is on by default: no knob set unless a test opts out.
  mock.env(on, { HOME: '/home/me', ...(options.modEnv === undefined ? {} : { PLANNOTATOR_CLAUDE_MOD: options.modEnv }), ...options.env })
  const env = new Map<string, string | undefined>()
  on('env.set', ($: any, e: any) => {
    env.set(e.name, e.value)
    return { value: undefined }
  })
  // The mod's $.store, in memory and readable by the test.
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
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
    const answered = options.run?.(argv, files)
    if (answered) return { value: answered }
    if (argv[3] === 'plannotator-launch' && options.cliStderr !== undefined) {
      // A CLI that refuses the subcommand and exits at once.
      files.set(`${argv[4]}/stderr`, options.cliStderr)
      files.set(`${argv[4]}/exit`, '1\n')
    } else if (argv[3] === 'plannotator-launch') {
      files.set(`${argv[4]}/ready`, `${JSON.stringify({ url: 'http://localhost:4321', isRemote: false, port: 4321 })}\n`)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  /** The context each prompt arrived with at the bottom, in order (null: none). */
  const contexts: (readonly string[] | null)[] = []
  on('prompt.submit', ($: any, e: any) => {
    submits.push(e.text)
    contexts.push(Array.isArray(e.context) ? e.context : null)
    if (options.dropPrompt?.(e.text)) return { drop: 'blocked beneath' }
    return { text: e.text, origin: e.origin, ...(Array.isArray(e.context) ? { context: e.context } : {}) }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  // The bridge: no server answers (an older binary), so the loop stops.
  on('http.fetch', async ($: any, e: any) => ({ value: (await options.fetch?.(e)) ?? { status: 404, ok: false, headers: {}, text: '' } }))
  return { files, runs, submits, contexts, logs, clock, env, registered, tools, store }
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

  // #2007: an organization's guard plugin (cc-plugin-sec-default) can send
  // classic.PermissionRequest past the mod, so the plugin's own command hook
  // gets the approved call. While the call runs, the approval is on disk for
  // it; once the call settles it is gone.
  test('approved: the approved call is recorded for the classic hook while it runs, then removed', async ($: any, on: any) => {
    const w = world(on, {
      run: (argv, files) => {
        if (argv[3] !== 'plannotator-rm') return undefined
        files.delete(argv[4]!)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    const plan = '# Plan\n\n1. Ship.\n'
    let during: any[] = []
    on('tool.call', ($: any, e: any) => {
      during = [...w.files.keys()].filter((path) => path.includes('/plan-approvals/')).map((path) => ({ path, ...JSON.parse(w.files.get(path)!) }))
      return { result: 'ExitPlanMode ran' }
    })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'ExitPlanMode', plan })
    const dir = w.runs.find((argv) => argv[3] === 'plannotator-launch')?.[4]
    w.files.set(
      `${dir}/result.json`,
      JSON.stringify({ v: 1, surface: 'plan', decision: 'approved', message: 'Plan approved.', noop: false, approvedPlan: plan, permissionMode: 'acceptEdits' }),
    )
    await w.clock.advance(1_000)

    const answer = await $.tool.call({ tool: 'ExitPlanMode', plan })

    expect(answer.result).toBe('ExitPlanMode ran')
    expect(during).toHaveLength(1)
    expect(during[0].path.startsWith('/home/me/.plannotator/claude-code-mod/session-1/plan-approvals/')).toBe(true)
    expect(during[0]).toMatchObject({ v: 1, plan, permissionMode: 'acceptEdits' })
    expect([...w.files.keys()].filter((path) => path.includes('/plan-approvals/'))).toEqual([])
  })

  // #2159: the mod's classic.PermissionRequest hook is matched on
  // ExitPlanMode, so the approved call still gets its allow from the mod...
  test('approved: the permission prompt of the approved ExitPlanMode is answered by the mod', async ($: any, on: any) => {
    const w = world(on)
    const plan = '# Plan\n\n1. Ship.\n'
    let bottomRan = false
    on('classic.PermissionRequest', () => {
      bottomRan = true
      return {}
    })
    let permission: any
    // The permission prompt Claude Code raises once the call reaches it,
    // raised through the test's engine (the outer `$`).
    on('tool.call', async (_: any, e: any) => {
      permission = await $.classic.PermissionRequest({ tool_name: 'ExitPlanMode', tool_use_id: e.tool_use_id, tool_input: { plan } })
      return { result: 'ExitPlanMode ran' }
    })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'ExitPlanMode', plan })
    const dir = w.runs.find((argv) => argv[3] === 'plannotator-launch')?.[4]
    w.files.set(
      `${dir}/result.json`,
      JSON.stringify({ v: 1, surface: 'plan', decision: 'approved', message: 'Plan approved.', noop: false, approvedPlan: plan, permissionMode: 'acceptEdits' }),
    )
    await w.clock.advance(1_000)

    const answer = await $.tool.call({ tool: 'ExitPlanMode', plan })

    expect(answer.result).toBe('ExitPlanMode ran')
    expect(bottomRan).toBe(false)
    expect(permission?.decision?.behavior).toBe('allow')
    expect(permission?.decision?.updatedInput?.plan).toBe(plan)
    expect(permission?.decision?.updatedPermissions).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
  })

  // ...while another tool's permission prompt is left to the hooks beneath.
  test("another tool's permission prompt goes past the mod untouched", async ($: any, on: any) => {
    world(on)
    const seen: any[] = []
    on('classic.PermissionRequest', ($: any, e: any) => {
      seen.push(e)
      return { decision: { behavior: 'deny', message: 'beneath' } }
    })
    await $.session.start(SESSION)

    const answer = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })

    expect(answer.decision).toEqual({ behavior: 'deny', message: 'beneath' })
    expect(seen).toHaveLength(1)
    expect(seen[0].tool_name).toBe('Bash')
    expect(seen[0].tool_input).toEqual({ command: 'ls' })
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
    const w = world(on, { run: (argv) => (argv[1] === 'inbox' ? { exitCode: 0, stdout: 'http://localhost:5555/\n', stderr: '' } : undefined) })
    on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Here is the plan I wrote.' }] }))
    const reachedBeneath: string[] = []
    on('command.run', ($: any, e: any) => {
      reachedBeneath.push(e.command)
      return { text: `${e.command} ran beneath` }
    })
    await $.session.start(SESSION)

    expect(w.registered.sort()).toEqual(['plannotator-annotate', 'plannotator-inbox', 'plannotator-last'])
    for (const [command, args, subcommand] of [
      ['plannotator-review', '', 'review'],
      ['plannotator-annotate', 'notes.md', 'annotate'],
      ['plannotator-last', '', 'annotate-last'],
    ]) {
      const { text } = await $.command.run({ command, args, origin: { kind: 'composer' } })
      expect(text).toContain('http://localhost:4321')
      expect(w.runs.some((argv) => argv[3] === 'plannotator-launch' && argv[6] === subcommand)).toBe(true)
    }
    // /plannotator-inbox opens the Inbox (plannotator inbox --open) and answers with its address.
    const inboxAnswer = await $.command.run({ command: 'plannotator-inbox', args: '', origin: { kind: 'composer' } })
    expect(w.runs.some((argv) => argv.join(' ') === 'plannotator inbox --open')).toBe(true)
    expect(inboxAnswer.text).toContain('http://localhost:5555/')
    // Opened: the model gets the Inbox briefing as the answer's hidden context (no turn).
    expect(inboxAnswer.context?.[0]).toContain('plannotator inbox --help')
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

    // plannotator_inbox first: registered before the instance, from the bundled list until an Inbox ran.
    expect(w.tools.map((tool) => tool.name)).toEqual(['plannotator_inbox', 'plannotator'])
    expect(w.tools.find((tool) => tool.name === 'plannotator')?.inputSchema.required).toEqual(['action'])
    // The mod registers the tailscale variant of the contract (#2166).
    expect(w.tools.find((tool) => tool.name === 'plannotator')?.inputSchema.properties.tailscale?.type).toBe('boolean')

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

    // The Inbox tool is its own switch (inboxTool), on by default.
    expect(w.tools.map((tool) => tool.name)).toEqual(['plannotator_inbox'])
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

  // --- The Plannotator Inbox (plannotator_inbox and the reply wake, inbox.ts) ---

  const INBOX_TOOL = `${TOOL_PREFIX}plannotator_inbox`
  const REGISTRY = JSON.stringify({ v: 1, pid: 777, port: 5150, url: 'http://localhost:5150/', version: '0.29.0', token: 't'.repeat(64), serverSession: 'srv-1', startedAt: '2026-10-07T00:00:00.000Z' })
  const tool = (name: string, properties: Record<string, unknown>) => ({ name, description: `${name}: what it does. More detail.`, inputSchema: { type: 'object', properties } })
  const TOOLS = [
    tool('send_message', { body: { type: 'string', description: 'The message.' }, project_path: { type: 'string' }, agent_session: { type: 'string' }, agent_host: { type: 'string' }, agent_name: { type: 'string' }, reply_to: { type: 'string' } }),
    tool('read_thread', { thread_id: { type: 'string' }, project_path: { type: 'string' }, agent_session: { type: 'string' } }),
    tool('wait_for_reply', { thread_id: { type: 'string' }, timeout_seconds: { type: 'number' }, agent_session: { type: 'string' } }),
    tool('resolve_message', { message_id: { type: 'string' } }),
  ]
  const GUIDE_TOOL = tool('submit_guide', { patch: { type: 'string' }, project_path: { type: 'string' } })

  /** An Inbox on port 5150 answering /mcp with `tools`, health, and the bridge from `bridge`. */
  function inbox(tools: unknown[], calls: { url: string; body: any }[], bridge: (path: string, body: any) => unknown = () => ({ commands: [] })) {
    return (e: any) => {
      const body = e.init?.body ? JSON.parse(e.init.body) : undefined
      calls.push({ url: e.url, body })
      const answer = (value: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(value) })
      if (e.url === 'http://127.0.0.1:5150/mcp' && body?.method === 'tools/list') return { status: 200, ok: true, headers: {}, text: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } })}\n\n` }
      if (e.url === 'http://127.0.0.1:5150/mcp' && body?.method === 'tools/call') {
        return answer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Sent to the Plannotator Inbox (thread msg_1).' }], structuredContent: { thread_id: 'msg_1' } } })
      }
      if (e.url === 'http://127.0.0.1:5150/api/inbox/health') return answer({ ok: true, app: 'plannotator-inbox', serverSession: 'srv-1', peek: true })
      if (e.url.startsWith('http://127.0.0.1:5150/api/inbox/bridge/')) return answer(bridge(e.url.slice('http://127.0.0.1:5150'.length), body))
      return { status: 404, ok: false, headers: {}, text: '' }
    }
  }

  const withRegistry = () => new Map<string, string>([['/home/me/.plannotator', ''], ['/home/me/.plannotator/inbox/inbox.json', REGISTRY]])

  test('no inbox/inbox.json yet: plannotator_inbox is registered from the bundled list, and nothing asks the Inbox or writes a file', async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    const w = world(on, { fetch: inbox(TOOLS, calls) })
    await $.session.start(SESSION)
    await w.clock.advance(5_000)

    expect(w.tools.map((t) => t.name)).toEqual(['plannotator_inbox', 'plannotator'])
    const registered = w.tools.find((t) => t.name === 'plannotator_inbox')
    // Every action a real Inbox offers, in the contract's order (INBOX_TOOL_ACTIONS).
    expect(registered?.inputSchema.properties.action.enum).toEqual(['send_message', 'read_thread', 'search', 'wait_for_reply', 'resolve_message', 'submit_guide', 'get_guide_brief'])
    expect(calls).toEqual([])
    expect([...w.files.keys()].filter((path) => path.includes('/inbox'))).toEqual([])
    expect(w.runs.filter((argv) => argv.includes('inbox'))).toEqual([])
  })

  test('the first plannotator_inbox call with no Inbox yet starts one with plannotator inbox --background', async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    const w = world(on, {
      fetch: inbox(TOOLS, calls),
      // `plannotator inbox --background` writes the registry, as the real one does.
      run: (argv, files) => {
        if (argv[0] !== 'plannotator' || argv[1] !== 'inbox') return undefined
        files.set('/home/me/.plannotator/inbox/inbox.json', REGISTRY)
        return { exitCode: 0, stdout: 'http://localhost:5150/\n', stderr: '' }
      },
    })
    await $.session.start(SESSION)
    const answer = await $.tool.call({ tool: INBOX_TOOL, action: 'send_message', body: 'Ship it?' })
    expect(answer.result).toContain('Sent to the Plannotator Inbox')
    expect(w.runs.some((argv) => argv.join(' ') === 'plannotator inbox --background')).toBe(true)
    expect(calls.some((c) => c.body?.method === 'tools/call')).toBe(true)
  })

  test('the reminder: one fixed block in the first message, only with plannotator_inbox and the switch on', async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []) })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    await $.session.start(SESSION)
    const base = [{ name: 'currentDate', text: '2026-10-12' }]
    const first = await $.prompt.context({ blocks: base })
    const again = await $.prompt.context({ blocks: base })
    expect(first.blocks.map((b: any) => b.name)).toEqual(['currentDate', 'plannotatorInbox'])
    // The tool by the full name the engine registered: tool search finds the deferred tool by it.
    expect(first.blocks[1].text).toBe(inboxReminderText(INBOX_TOOL))
    expect(first.blocks[1].text).toContain(`${INBOX_TOOL} send_message`)
    expect(again).toEqual(first)
    expect(w.tools.some((t) => t.name === 'plannotator_inbox')).toBe(true)
  })

  test('no reminder with { "inboxReminder": false }, and none without the tool', async ($: any, on: any) => {
    const files = withRegistry()
    files.set('/home/me/.plannotator/config.json', JSON.stringify({ inboxReminder: { 'claude-code': false } }))
    world(on, { files, fetch: inbox(TOOLS, []) })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    await $.session.start(SESSION)
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
  })

  // #2194: config.json `prompts.inbox`. Without a usable one, the bytes are today's.
  test('prompts.inbox unset (other prompts set, a blank reminder, another agent\'s own): the block and the variable are today\'s, byte for byte', async ($: any, on: any) => {
    const files = withRegistry()
    files.set('/home/me/.plannotator/config.json', JSON.stringify({ prompts: { review: { denied: 'Check.' }, inbox: { reminder: '  ', runtimes: { pi: { reminder: 'Pi only.' } } } } }))
    const w = world(on, { files, fetch: inbox(TOOLS, []) })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    await $.session.start(SESSION)
    const today = inboxReminderText(INBOX_TOOL)
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([{ name: 'plannotatorInbox', text: today }])
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(today)
  })

  test('prompts.inbox set: Claude Code\'s own text replaces the block, plannotator_inbox in it named as the engine registered it', async ($: any, on: any) => {
    const files = withRegistry()
    files.set('/home/me/.plannotator/config.json', JSON.stringify({ prompts: { inbox: { reminder: 'Shared.', runtimes: { 'claude-code': { reminder: 'Ask your upstream session first; plannotator_inbox only when it is gone.' } } } } }))
    const w = world(on, { files, fetch: inbox(TOOLS, []) })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    await $.session.start(SESSION)
    const own = `Ask your upstream session first; ${INBOX_TOOL} only when it is gone.`
    const first = await $.prompt.context({ blocks: [{ name: 'currentDate', text: '2026-10-26' }] })
    expect(first.blocks).toEqual([{ name: 'currentDate', text: '2026-10-26' }, { name: 'plannotatorInbox', text: own }])
    expect(await $.prompt.context({ blocks: [{ name: 'currentDate', text: '2026-10-26' }] })).toEqual(first)
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(own)
  })

  test('no inbox/inbox.json yet: the tool, but no reminder (it speaks only for an Inbox that has run here)', async ($: any, on: any) => {
    const w = world(on, { fetch: inbox(TOOLS, []) })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    await $.session.start(SESSION)
    expect(w.tools.some((t) => t.name === 'plannotator_inbox')).toBe(true)
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
  })

  test('a -p (non-interactive) session: no tool and no reminder', async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []) })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    await $.session.start({ ...SESSION, surface: null, isInteractive: false })
    expect(w.tools).toEqual([])
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
  })

  test('$.tool.register refused plannotator_inbox: no reminder naming a tool the session lacks', async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), refuseTools: ['plannotator_inbox'] })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    await $.session.start(SESSION)
    expect(w.tools.some((t) => t.name === 'plannotator_inbox')).toBe(false)
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
    expect(w.logs.some((line) => line.includes('plannotator_inbox tool is not available'))).toBe(true)
  })

  test('PLANNOTATOR_INBOX_TOOL=0: no tool and no reminder', async ($: any, on: any) => {
    world(on, { files: withRegistry(), env: { PLANNOTATOR_INBOX_TOOL: '0' }, fetch: inbox(TOOLS, []) })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    await $.session.start(SESSION)
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
  })

  // --- The reminder where a guard plugin skips prompt.context (#2159) ---
  //
  // Claude Code's cc-plugin-sec-default (Team/Enterprise) sits in the prepend
  // tier and sends prompt.context (and classic.*) past every user-tier hook.
  // The stand-in below does the same, so the mod's prompt.context hook never
  // runs; the reminder then goes as the first prompt's context.
  const GUARD = {
    name: 'sec-default-standin',
    tier: 'prepend' as const,
    register(on: any) {
      on('prompt.context', ($: any, e: any, next: any) => next.to(e, 'append'))
      on('classic.*', ($: any, e: any, next: any) => next.to(e, 'append'))
    },
  }
  const REMINDER = inboxReminderText(INBOX_TOOL)
  const firstTurn = { answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' as const }

  test('standard, prompt.context known to work: the block as today, no prompt.submit copy, the variable set', async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), store: { inboxReminderContextWorks: true } })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
    await $.session.start(SESSION)

    await $.prompt.submit({ text: 'Refactor the handler.' })
    const context = await $.prompt.context({ blocks: [{ name: 'currentDate', text: '2026-10-25' }] })
    await $.turn.complete({ turnId: 'turn-1', ...firstTurn })
    await $.prompt.submit({ text: 'And the tests.' })

    expect(context.blocks).toEqual([{ name: 'currentDate', text: '2026-10-25' }, { name: 'plannotatorInbox', text: REMINDER }])
    expect(w.contexts).toEqual([null, null])
    expect(w.store.get('inboxReminderContextWorks')).toBe(true)
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(REMINDER)
  })

  test('standard, nothing learned yet: the first prompt carries the copy once, prompt.context then teaches true, and the next conversation has none', async ($: any, on: any) => {
    let sessionId = 'session-1'
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), sessionId: () => sessionId })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
    await $.session.start(SESSION)

    await $.prompt.submit({ text: 'Refactor the handler.' })
    const context = await $.prompt.context({ blocks: [] })
    await $.turn.complete({ turnId: 'turn-1', ...firstTurn })
    await $.prompt.submit({ text: 'And the tests.' })
    // /clear: the same process goes on under a new session id.
    sessionId = 'session-2'
    await $.prompt.submit({ text: 'Something else.' })
    await $.prompt.context({ blocks: [] })

    expect(w.contexts).toEqual([[REMINDER], null, null])
    expect(context.blocks.map((b: any) => b.name)).toEqual(['plannotatorInbox'])
    expect(w.store.get('inboxReminderContextWorks')).toBe(true)
  })

  test('guarded: prompt.context is skipped, the first prompt carries the exact reminder, the first turn teaches false, and every new conversation gets it on its first prompt', { plugins: [GUARD] }, async ($: any, on: any) => {
    let sessionId = 'session-1'
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), sessionId: () => sessionId })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
    await $.session.start(SESSION)

    await $.prompt.submit({ text: 'Refactor the handler.' })
    const context = await $.prompt.context({ blocks: [] })
    await $.turn.complete({ turnId: 'turn-1', ...firstTurn })
    await $.prompt.submit({ text: 'And the tests.' })
    sessionId = 'session-2'
    await $.prompt.submit({ text: 'Something else.' })

    // The guard sent prompt.context past the mod: no block.
    expect(context.blocks).toEqual([])
    expect(w.contexts).toEqual([[REMINDER], null, [REMINDER]])
    expect(w.store.get('inboxReminderContextWorks')).toBe(false)
    // env.set is not guarded: the compaction hook has the text too.
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(REMINDER)
  })

  test('a machine that becomes guarded after learning true: the first prompt has none, the first turn teaches false, the second prompt carries it', { plugins: [GUARD] }, async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), store: { inboxReminderContextWorks: true } })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
    await $.session.start(SESSION)

    await $.prompt.submit({ text: 'Refactor the handler.' })
    await $.prompt.context({ blocks: [] })
    await $.turn.complete({ turnId: 'turn-1', ...firstTurn })
    await $.prompt.submit({ text: 'And the tests.' })
    await $.prompt.submit({ text: 'And the docs.' })

    expect(w.contexts).toEqual([null, [REMINDER], null])
    expect(w.store.get('inboxReminderContextWorks')).toBe(false)
  })

  test('guarded: an aborted first turn and a subagent turn teach nothing; the next completed main turn does', { plugins: [GUARD] }, async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), store: { inboxReminderContextWorks: true } })
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
    await $.session.start(SESSION)

    await $.turn.complete({ turnId: 'turn-1', ...firstTurn, isAborted: true, reason: 'aborted' })
    await $.turn.complete({ turnId: 'sub-1', ...firstTurn, agentId: 'agent-1' })
    expect(w.store.get('inboxReminderContextWorks')).toBe(true)
    await $.turn.complete({ turnId: 'turn-2', ...firstTurn })
    expect(w.store.get('inboxReminderContextWorks')).toBe(false)
  })

  // Live on 2.1.310 the engine ran prompt.context BEFORE the mod's
  // session.start had registered plannotator_inbox (#2167 review): the block
  // was missing from every process's first conversation, and the first turn
  // then taught false on a standard machine. prompt.context waits for
  // session.start's decision now.
  test('prompt.context while session.start is still registering the tool (a slow Inbox /mcp): the block lands and the store learns true', async ($: any, on: any) => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const answer = inbox(TOOLS, [])
    const w = world(on, {
      files: withRegistry(),
      fetch: async (e: any) => {
        await held
        return answer(e)
      },
    })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }))

    const starting = $.session.start(SESSION)
    const context = $.prompt.context({ blocks: [{ name: 'currentDate', text: '2026-10-25' }] })
    // Neither can finish while the Inbox has not answered.
    await w.clock.settle()
    expect(w.tools.some((t) => t.name === 'plannotator_inbox')).toBe(false)
    release()
    await starting
    const blocks = (await context).blocks
    await $.turn.complete({ turnId: 'turn-1', ...firstTurn })

    expect(blocks).toEqual([{ name: 'currentDate', text: '2026-10-25' }, { name: 'plannotatorInbox', text: REMINDER }])
    expect(w.store.get('inboxReminderContextWorks')).toBe(true)
  })

  test('a machine wrongly learned false by an older build: the next working prompt.context sets it back to true', async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), store: { inboxReminderContextWorks: false } })
    on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
    await $.session.start(SESSION)

    await $.prompt.submit({ text: 'Refactor the handler.' })
    await $.prompt.context({ blocks: [] })
    await $.turn.complete({ turnId: 'turn-1', ...firstTurn })

    // One accepted duplicate (the copy on the first prompt), then today's path.
    expect(w.contexts).toEqual([[REMINDER]])
    expect(w.store.get('inboxReminderContextWorks')).toBe(true)
  })

  test('a resumed session (started long before this process) teaches nothing from its first turn here', { plugins: [GUARD] }, async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), store: { inboxReminderContextWorks: true } })
    on('session.usage', () => ({ value: { startedAt: w.clock.now() - 3_600_000, context: { window: 200_000 }, rateLimits: [] } }))
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
    await $.session.start(SESSION)

    await $.turn.complete({ turnId: 'turn-1', ...firstTurn })

    expect(w.store.get('inboxReminderContextWorks')).toBe(true)
  })

  test('a session started by this process (startedAt just before its first session.start) still teaches false', { plugins: [GUARD] }, async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), store: { inboxReminderContextWorks: true } })
    on('session.usage', () => ({ value: { startedAt: w.clock.now() - 2_000, context: { window: 200_000 }, rateLimits: [] } }))
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
    await $.session.start(SESSION)

    await $.turn.complete({ turnId: 'turn-1', ...firstTurn })

    expect(w.store.get('inboxReminderContextWorks')).toBe(false)
  })

  test('a dropped prompt is not counted as reached: the next prompt carries the copy again', { plugins: [GUARD] }, async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), dropPrompt: (text) => text === 'refused' })
    await $.session.start(SESSION)

    await $.prompt.submit({ text: 'refused' }).catch(() => undefined)
    await $.prompt.submit({ text: 'Refactor the handler.' })
    await $.prompt.submit({ text: 'And the tests.' })

    expect(w.contexts).toEqual([[REMINDER], [REMINDER], null])
  })

  for (const [name, setup] of [
    ['{ "inboxReminder": false }', { config: { inboxReminder: { 'claude-code': false } } }],
    ['no inbox/inbox.json yet', { noRegistry: true }],
    ['plannotator_inbox refused by $.tool.register', { refuse: true }],
    ['PLANNOTATOR_INBOX_TOOL=0', { env: { PLANNOTATOR_INBOX_TOOL: '0' } }],
  ] as const) {
    test(`reminder off (${name}): no copy anywhere, even guarded, and the variable unset`, { plugins: [GUARD] }, async ($: any, on: any) => {
      const files = (setup as any).noRegistry ? new Map<string, string>() : withRegistry()
      if ((setup as any).config) files.set('/home/me/.plannotator/config.json', JSON.stringify((setup as any).config))
      const w = world(on, {
        files,
        fetch: inbox(TOOLS, []),
        ...((setup as any).env ? { env: (setup as any).env } : {}),
        ...((setup as any).refuse ? { refuseTools: ['plannotator_inbox'] } : {}),
      })
      on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
      await $.session.start(SESSION)

      await $.prompt.submit({ text: 'Refactor the handler.' })
      await $.turn.complete({ turnId: 'turn-1', ...firstTurn })
      await $.prompt.submit({ text: 'And the tests.' })

      expect(w.contexts).toEqual([null, null])
      expect(w.store.has('inboxReminderContextWorks')).toBe(false)
      expect(w.env.has('PLANNOTATOR_INBOX_REMINDER')).toBe(true)
      expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBeUndefined()
    })
  }

  test('the mod turned off (PLANNOTATOR_CLAUDE_MOD=0): no copy and nothing set', { plugins: [GUARD] }, async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []), modEnv: '0' })
    await $.session.start(SESSION)
    await $.prompt.submit({ text: 'Refactor the handler.' })
    expect(w.contexts).toEqual([null])
    expect(w.env.has('PLANNOTATOR_INBOX_REMINDER')).toBe(false)
  })

  test('a -p session: no copy and nothing set', { plugins: [GUARD] }, async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []) })
    await $.session.start({ ...SESSION, surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'Refactor the handler.' })
    expect(w.contexts).toEqual([null])
    expect(w.env.has('PLANNOTATOR_INBOX_REMINDER')).toBe(false)
  })

  // --- The session's open threads after a compaction and on a resume (the misfiled-thread AAR) ---
  //
  // The failure these catch: after a compaction the conversation holds only
  // the thread ids the model kept in its own summary, so the thread list must
  // come from the Inbox, fresh, every compaction; and it must never hold up or
  // break a compaction or a resume when the Inbox is not there.
  const TRANSCRIPT = [{ role: 'user', text: 'Ship the journey fixes.', toolUses: [] }]
  const SUMMARY = [{ role: 'user', text: 'Summary: the journey fixes shipped.', toolUses: [] }]
  const THREAD_ID = 'msg_01M5WQ58NAVGBFZS4QKFBE1TCC'
  const LIST = {
    content: [{ type: 'text', text: '1 thread in work.' }],
    structuredContent: {
      threads: [{ thread_id: THREAD_ID, subject: 'ML team journey', thread_name: null, questions: { open: 2, picked: 0 }, unread: true, last_author: 'person', last_at: '2026-10-27T06:24:00.000Z' }],
      total: 1,
    },
  }
  const THREADS = `Your open Plannotator Inbox threads in this project (1). Before reply_to into a thread you have not read in this context window, call ${INBOX_TOOL} read_thread with no id and match the subject. Their decisions stay in these threads: when the person writes in the chat, say what waits and link the thread, but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar).\n- ${THREAD_ID} · "ML team journey" · 2 open questions · the person wrote something you have not read · last the person 2026-10-27 06:24Z\nMore: read_thread with no id lists every thread (asked_by "anyone", include_resolved); search finds older ones by words (all_projects).`
  /**
   * The Inbox of `inbox()`, whose read_thread list answers LIST (once `listed`
   * is true) and records the peeks; `old`: an Inbox from before the peek mark
   * (no `peek` in its health), which would make a project for the folder.
   */
  function inboxWithThreads(peeks: any[], state: { listed: boolean; up: boolean; old?: boolean } = { listed: true, up: true }) {
    const base = inbox(TOOLS, [])
    return (e: any) => {
      if (!state.up && !e.url.endsWith('/mcp')) return { status: 0, ok: false, headers: {}, text: '' }
      if (state.old && e.url.endsWith('/api/inbox/health')) return { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, app: 'plannotator-inbox', serverSession: 'srv-1' }) }
      const body = e.init?.body ? JSON.parse(e.init.body) : undefined
      if (body?.method === 'tools/call' && body.params?.name === 'read_thread') {
        peeks.push(body.params)
        const result = state.listed ? LIST : { content: [{ type: 'text', text: '0 threads.' }], structuredContent: { threads: [], total: 0 } }
        return { status: 200, ok: true, headers: {}, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) }
      }
      return base(e)
    }
  }

  test("before a compaction installs, the reminder variable is made fresh: the reminder, then the session's open threads from a peek", async ($: any, on: any) => {
    const peeks: any[] = []
    const state = { listed: true, up: true }
    const w = world(on, { files: withRegistry(), fetch: inboxWithThreads(peeks, state) })
    on('session.compact', () => ({ messages: SUMMARY }))
    on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
    await $.session.start(SESSION)
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(REMINDER)

    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(`${REMINDER}\n\n${THREADS}`)
    // The session's own list, marked as a peek (no project made, not a read).
    expect(peeks[0]).toEqual({ name: 'read_thread', arguments: { project_path: '/work', agent_session: 'session-1', limit: 5 }, _meta: { 'ai.plannotator/inbox-peek': true } })
    // The ids and subjects leave the environment (every Bash child inherits it) once the hook has printed them.
    await $.turn.start({ text: 'Go on.', turnId: 'turn-9' })
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(REMINDER)
    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(`${REMINDER}\n\n${THREADS}`)
    // A subagent's turn is not the hook's moment: the list stays until the main loop moves on.
    await $.turn.start({ text: 'Explore.', turnId: 'turn-sub', agentId: 'agent-1' })
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(`${REMINDER}\n\n${THREADS}`)
    await $.turn.start({ text: 'And then.', turnId: 'turn-10' })
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(REMINDER)

    // The next compaction finds no open thread: the reminder alone again, never a stale list.
    state.listed = false
    await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(REMINDER)

    // An Inbox that stopped: the reminder alone, and the compaction goes on.
    state.listed = true
    state.up = false
    const done = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
    expect(done.messages).toEqual(SUMMARY)
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(REMINDER)
  })

  test('a precompute and a subagent compaction leave the variable alone; a guard that skips classic.* does not stop the list', { plugins: [GUARD] }, async ($: any, on: any) => {
    const peeks: any[] = []
    const w = world(on, { files: withRegistry(), fetch: inboxWithThreads(peeks) })
    on('session.compact', () => ({ messages: SUMMARY }))
    await $.session.start(SESSION)
    await $.session.compact({ trigger: 'precompute', messages: TRANSCRIPT })
    await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: TRANSCRIPT })
    expect(peeks).toEqual([])
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(REMINDER)
    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(`${REMINDER}\n\n${THREADS}`)
  })

  test('an Inbox from before the peek mark (no peek in its health): the list is never asked for, so it makes no project', async ($: any, on: any) => {
    const peeks: any[] = []
    const w = world(on, { files: withRegistry(), fetch: inboxWithThreads(peeks, { listed: true, up: true, old: true }) })
    on('session.compact', () => ({ messages: SUMMARY }))
    on('classic.SessionStart', () => ({}))
    await $.session.start(SESSION)
    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBe(REMINDER)
    expect((await $.classic.SessionStart({ source: 'resume' })).additionalContext).toBeUndefined()
    expect(peeks).toEqual([])
  })

  test('the reminder switched off: a compaction asks the Inbox nothing and sets nothing', async ($: any, on: any) => {
    const peeks: any[] = []
    const files = withRegistry()
    files.set('/home/me/.plannotator/config.json', JSON.stringify({ inboxReminder: false }))
    const w = world(on, { files, fetch: inboxWithThreads(peeks) })
    on('session.compact', () => ({ messages: SUMMARY }))
    await $.session.start(SESSION)
    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
    expect(peeks).toEqual([])
    expect(w.env.get('PLANNOTATOR_INBOX_REMINDER')).toBeUndefined()
  })

  test("a resume gets the session's open threads as SessionStart context; a startup or /clear asks nothing", async ($: any, on: any) => {
    const peeks: any[] = []
    world(on, { files: withRegistry(), fetch: inboxWithThreads(peeks) })
    on('classic.SessionStart', () => ({ additionalContext: ['beneath'] }))
    await $.session.start(SESSION)

    const startup = await $.classic.SessionStart({ source: 'startup' })
    const cleared = await $.classic.SessionStart({ source: 'clear' })
    expect(peeks).toEqual([])
    expect(startup.additionalContext).toEqual(['beneath'])
    expect(cleared.additionalContext).toEqual(['beneath'])

    const resumed = await $.classic.SessionStart({ source: 'resume', session_id: 'session-9', cwd: '/work' })
    expect(resumed.additionalContext).toEqual(['beneath', THREADS])
    expect(peeks[0].arguments.agent_session).toBe('session-9')
  })

  test('a resume with no Inbox running, or no open thread: the context is left as it was', async ($: any, on: any) => {
    const peeks: any[] = []
    const state = { listed: false, up: true }
    world(on, { files: withRegistry(), fetch: inboxWithThreads(peeks, state) })
    on('classic.SessionStart', () => ({}))
    await $.session.start(SESSION)
    expect((await $.classic.SessionStart({ source: 'resume' })).additionalContext).toBeUndefined()
    state.up = false
    state.listed = true
    expect((await $.classic.SessionStart({ source: 'resume' })).additionalContext).toBeUndefined()
  })

  test('an Inbox found: plannotator_inbox carries exactly the tools its /mcp offers, filled arguments left out', async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    const w = world(on, { files: withRegistry(), fetch: inbox([...TOOLS, GUIDE_TOOL], calls) })
    await $.session.start(SESSION)

    const registered = w.tools.find((t) => t.name === 'plannotator_inbox')
    expect(registered?.inputSchema.properties.action.enum).toEqual(['send_message', 'read_thread', 'wait_for_reply', 'resolve_message', 'submit_guide'])
    expect(Object.keys(registered?.inputSchema.properties)).not.toContain('agent_session')
    // project_path is the one filled argument the agent may set (optional): the folder a call is about.
    expect(registered?.inputSchema.properties.project_path?.type).toBe('string')
    expect(registered?.inputSchema.required).toEqual(['action'])
  })

  test('an older Inbox whose /mcp has no submit_guide: the tool is registered without it', async ($: any, on: any) => {
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, []) })
    await $.session.start(SESSION)

    const registered = w.tools.find((t) => t.name === 'plannotator_inbox')
    expect(registered?.inputSchema.properties.action.enum).toEqual(['send_message', 'read_thread', 'wait_for_reply', 'resolve_message'])
    const refused = await $.tool.call({ tool: INBOX_TOOL, action: 'submit_guide', patch: 'x' })
    expect(refused.deny).toContain('update Plannotator')
  })

  test('PLANNOTATOR_INBOX_TOOL=0: no plannotator_inbox even with an Inbox found', async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    const w = world(on, { files: withRegistry(), env: { PLANNOTATOR_INBOX_TOOL: '0' }, fetch: inbox(TOOLS, calls) })
    await $.session.start(SESSION)
    await w.clock.advance(5_000)

    expect(w.tools.map((t) => t.name)).toEqual(['plannotator'])
    expect(calls).toEqual([])
  })

  test("a call goes to the Inbox's /mcp with the session's folder and real id; after /clear, the new id", async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    let id = 'session-1'
    world(on, { files: withRegistry(), fetch: inbox(TOOLS, calls), sessionId: () => id })
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: INBOX_TOOL, action: 'send_message', body: 'Ship it?' })
    expect(answer.result).toContain('Sent to the Plannotator Inbox')
    const first = calls.find((c) => c.body?.method === 'tools/call')
    expect(first?.body.params).toEqual({
      name: 'send_message',
      arguments: { body: 'Ship it?', project_path: '/work', agent_session: 'session-1', agent_host: 'claude-code', agent_name: 'Claude Code' },
      // The mod's wake delivers the reply as a turn, so it marks the call (#1771):
      // the send tools then say to end the turn instead of waiting with wait_for_reply.
      _meta: { 'ai.plannotator/inbox-wakes': true },
    })

    await $.session.end({ reason: 'clear', sessionId: 'session-1' })
    id = 'session-2'
    await $.tool.call({ tool: INBOX_TOOL, action: 'send_message', body: 'And now?' })
    const second = calls.filter((c) => c.body?.method === 'tools/call').at(-1)
    expect(second?.body.params.arguments.agent_session).toBe('session-2')
    expect(second?.body.params._meta).toEqual({ 'ai.plannotator/inbox-wakes': true })
  })

  test("the person's Send arrives as one plugin turn: the stable header, the fixed line, the reply verbatim, then acknowledged", async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    let delivered = false
    const reply = { type: 'reply', id: 'msg_reply', thread_id: 'msg_1', reply_to: 'msg_1', subject: 'Ship it?', body: 'Yes.\n\nAfter the 3pm freeze.', url: 'http://localhost:5150/#thread=msg_1' }
    const w = world(on, {
      files: withRegistry(),
      fetch: inbox(TOOLS, calls, (path, body) => {
        if (path === '/api/inbox/bridge/event' && body.type === 'delivered' && body.id === 'msg_reply') delivered = true
        return path === '/api/inbox/bridge/poll' ? { commands: delivered ? [] : [reply] } : { ok: true }
      }),
    })
    await $.session.start(SESSION)
    for (let second = 0; second < 6; second++) await w.clock.advance(1_000)

    expect(w.submits).toEqual([
      'Plannotator Inbox: Ship it? (msg_reply)\nThe person replied to you in the Plannotator Inbox. Their reply follows as they wrote it: it is their answer to you. When they need to hear back, answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above.\n\nYes.\n\nAfter the 3pm freeze.' +
        // The closing line names the tool by the full name $.tool.register answered.
        `\n\n[thread msg_1 · more: ${INBOX_TOOL} read_thread · how it works: plannotator inbox --help]`,
    ])
    expect(delivered).toBe(true)
    const polls = calls.filter((c) => c.url.endsWith('/api/inbox/bridge/poll'))
    expect(polls.every((c) => c.body.session === 'session-1' && c.body.host === 'claude-code')).toBe(true)
    for (let second = 0; second < 10; second++) await w.clock.advance(1_000)
    expect(w.submits).toHaveLength(1)
  })

  test('Send now while a turn runs: the poll says the engine can, and the reply goes into the running turn as one user row ($.session.append), with no turn submitted', async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    let delivered = false
    const reply = { type: 'reply', id: 'msg_reply', thread_id: 'msg_1', reply_to: 'msg_1', subject: 'Ship it?', body: 'Yes, now.', url: 'http://localhost:5150/#thread=msg_1', now: true }
    const w = world(on, {
      files: withRegistry(),
      fetch: inbox(TOOLS, calls, (path, body) => {
        if (path === '/api/inbox/bridge/event' && body.type === 'delivered' && body.id === 'msg_reply') delivered = true
        return path === '/api/inbox/bridge/poll' ? { commands: delivered ? [] : [reply] } : { ok: true }
      }),
    })
    const session = mock.session(on)
    on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
    // An engine whose API has `$.session.append` (the version decides: validate refuses testing the noun itself).
    on('session.version', () => ({ value: { version: '2.1.302', base: '2.1.302' } }))
    await $.session.start(SESSION)
    // A main-loop turn starts and keeps running (a subagent's start alone would not count).
    await $.turn.start({ turnId: 'turn-1', text: 'Refactor the handler.' })
    for (let second = 0; second < 6; second++) await w.clock.advance(1_000)

    expect(calls.filter((c) => c.url.endsWith('/api/inbox/bridge/poll')).some((c) => c.body.send_now === true && c.body.busy === true)).toBe(true)
    expect(w.submits).toEqual([])
    const rows = session.appended().filter((row: any) => row.message?.type === 'user')
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0]!.message.content)).toContain('Plannotator Inbox: Ship it? (msg_reply)')
    expect(JSON.stringify(rows[0]!.message.content)).toContain('Yes, now.')
    expect(delivered).toBe(true)
  })

  // The restart warning (owner approval "restart-warning"): the poll says what this process loaded, so the
  // Inbox can tell a session on an older plugin. Through the engine's own `$.plugin.root` and `$.session.version()`.
  test('the poll says what this process loaded: the plugin (its folder and load time) and the engine', async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    const w = world(on, { files: withRegistry(), fetch: inbox(TOOLS, calls, (path) => (path === '/api/inbox/bridge/poll' ? { commands: [] } : { ok: true })) })
    on('session.version', () => ({ value: { version: '2.1.305', base: '2.1.305' } }))
    await $.session.start(SESSION)
    for (let second = 0; second < 3; second++) await w.clock.advance(1_000)
    const polls = calls.filter((c) => c.url.endsWith('/api/inbox/bridge/poll'))
    expect(polls.length).toBeGreaterThan(0)
    const last = polls[polls.length - 1]!.body
    expect(last.engine).toBe('2.1.305')
    expect(typeof last.plugin?.root).toBe('string')
    expect(typeof last.plugin?.loaded_at).toBe('number')
  })

  test("a background subagent's turn does not hold the reply: the main loop is idle, so it arrives as a turn", async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    let delivered = false
    const reply = { type: 'reply', id: 'msg_reply', thread_id: 'msg_1', reply_to: 'msg_1', subject: 'Ship it?', body: 'Yes.', url: 'http://localhost:5150/#thread=msg_1' }
    const w = world(on, {
      files: withRegistry(),
      fetch: inbox(TOOLS, calls, (path, body) => {
        if (path === '/api/inbox/bridge/event' && body.type === 'delivered' && body.id === 'msg_reply') delivered = true
        return path === '/api/inbox/bridge/poll' ? { commands: delivered ? [] : [reply] } : { ok: true }
      }),
    })
    on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
    await $.session.start(SESSION)
    await $.turn.start({ turnId: 'sub-turn-1', text: 'Explore the repo.', agentId: 'agent-1' })
    for (let second = 0; second < 6; second++) await w.clock.advance(1_000)
    expect(w.submits).toHaveLength(1)
    expect(delivered).toBe(true)
  })

  test('an engine older than the API with $.session.append never says it can take a reply mid-turn', async ($: any, on: any) => {
    const calls: { url: string; body: any }[] = []
    const w = world(on, {
      files: withRegistry(),
      fetch: inbox(TOOLS, calls, (path) => (path === '/api/inbox/bridge/poll' ? { commands: [] } : { ok: true })),
    })
    on('session.version', () => ({ value: { version: '2.1.290', base: '2.1.290' } }))
    await $.session.start(SESSION)
    for (let second = 0; second < 4; second++) await w.clock.advance(1_000)
    const polls = calls.filter((c) => c.url.endsWith('/api/inbox/bridge/poll'))
    expect(polls.length).toBeGreaterThan(0)
    expect(polls.some((c) => c.body.send_now === true)).toBe(false)
  })
})
