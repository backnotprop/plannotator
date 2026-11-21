/**
 * Opening a review behind Claude Code's built-in guard (`cc-plugin-sec-default`, Team and Enterprise logins and
 * managed machines). From Claude Code 2.1.326 the guard holds each call the model makes until the session allowed
 * it: a person's mod's `$.process.run` that repeats a held call is refused ("this repeats a Bash call that is not
 * allowed; serve an allowed call at tool.run"), and its re-check of that call is sent past the mod's own
 * `tool.check` hook ("its tool.check hook was skipped"). The guard forgets the call at `tool.run`.
 *
 * Driven through the real registered hooks on a fake `$`, in the order the engine runs them with the guard seated
 * first: the guard holds the call, the mod's `tool.call`, the session's permission check (the guard sends
 * `tool.check` past the mod: its hook is never called here), the guard forgets the call, the mod's `tool.run`. The
 * stand-in guard refuses EVERY start while a call is held, the strictest reading of the rule, so nothing here
 * leans on how the guard matches words.
 *
 * What can regress: the `plannotator` tool, or a taken-over Bash `plannotator annotate notes.md --gate --json`,
 * failing with the guard's refusal (0.28.67 under Claude Code 2.1.326); a call passed on that nothing serves at
 * `tool.run`; the CLI run for real for a taken-over command; a call the person refused opened anyway; a refused
 * start leaving its launch folder behind; anything changing where no guard refuses (answered at `tool.call`, no
 * permission step, as before); and a hook named `tool.run`, which an engine before 2.1.326 refuses to load.
 */
import { describe, expect, test } from 'bun:test'
import { HELD_AT_RUN_TEXT, isServedAtRun } from './early-run'

type Hook = ($: unknown, e: unknown, next: unknown) => unknown

/** The guard's words, as `$.process.run` rejects with them for this plugin. */
const REFUSAL = 'plannotator: $.process.run: this repeats a Bash call that is not allowed; serve an allowed call at tool.run'

const SESSION = 'sess-guarded'
const DATA = '/data'
/** The mod's tool as the fake engine registers it (`$.tool.register` answers `mcp__plugin_plannotator__<name>`). */
const MOD_TOOL = 'mcp__plugin_plannotator__plannotator'
const TERMINAL_START = { isInteractive: true, surface: 'terminal', cwd: '/w' }

async function freshHooks(name: string) {
  const { register } = (await import(`./register?early-run-${name}`)) as typeof import('./register')
  const held = new Map<string, Hook>()
  const matchers = new Map<string, unknown>()
  register(((event: string, ...args: unknown[]) => {
    if (held.has(event)) return
    held.set(event, args.at(-1) as Hook)
    if (args.length > 1) matchers.set(event, args[0])
  }) as Parameters<typeof import('./register').register>[0])
  return { hook: (event: string) => held.get(event)!, events: [...held.keys()], matchers }
}

async function settle() {
  for (let spin = 0; spin < 50; spin += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The engine beneath the mod, with the guard's early-run rule on when `guarded`. */
function engine(guarded: boolean) {
  const files = new Map<string, string>([['/bin/sh', '']])
  const env = new Map<string, string>(Object.entries({ HOME: '/home/me', PLANNOTATOR_DATA_DIR: DATA, PLANNOTATOR_INBOX_TOOL: '0' }))
  const store = new Map<string, unknown>()
  const world = {
    files,
    /** The model's calls the guard holds: from their tool.call until tool.run (or, refused, until the next prompt). */
    held: new Set<string>(),
    /** Starts the guard refused. */
    refused: 0,
    /** The CLI argv of every start that went ahead. */
    launched: [] as string[][],
    $: {
      env: { get: async (name: string) => env.get(name), set: async (name: string, value: string) => void env.set(name, value) },
      fs: {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => {
          const text = files.get(path)
          if (text === undefined) throw new Error(`ENOENT: ${path}`)
          return text
        },
        write: async (path: string, text: string) => void files.set(path, text),
        stat: async (path: string) => (files.has(path) ? { kind: 'file', size: files.get(path)!.length } : null),
      },
      session: {
        id: async () => SESSION,
        cwd: async () => '/w',
        root: async () => '/w',
        messages: async () => [],
        version: async () => ({ version: '2.1.327', base: '2.1.327' }),
      },
      clock: {
        now: async () => 1_000_000,
        sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
        every: () => ({ cancel: () => undefined }),
      },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
      process: {
        run: async (argv: string[]) => {
          const [, , , tag, dir] = argv
          if (tag === 'plannotator-launch') {
            if (guarded && world.held.size > 0) {
              world.refused += 1
              throw new Error(REFUSAL)
            }
            world.launched.push(argv.slice(5))
            // The CLI comes up at once (as in apps/hook/tests/register.test.ts).
            files.set(`${dir}/ready`, `${JSON.stringify({ url: 'http://localhost:4321', isRemote: false, port: 4321 })}\n`)
          }
          if (tag === 'plannotator-cleanup') for (const path of [...files.keys()]) if (path.startsWith(`${dir}/`)) files.delete(path)
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
      http: { fetch: async () => ({ status: 404, ok: false, headers: {}, text: '' }) },
      tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
      command: { list: async () => [], register: async () => undefined },
      ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
      prompt: { submit: async () => undefined, suggest: async () => undefined, read: async () => ({ text: '', cursor: 0 }) },
      turn: { abort: async () => undefined },
    },
  }
  return world
}

async function started(name: string, guarded: boolean) {
  const hooks = await freshHooks(name)
  const world = engine(guarded)
  await hooks.hook('session.start')(world.$, TERMINAL_START, async () => ({ cwd: '/w' }))
  await settle()
  return { ...hooks, world }
}

/** Launch folders that still hold a `stdin`: one per start that went ahead, none for a refused one. */
const launchFolders = (world: ReturnType<typeof engine>) => [...world.files.keys()].filter((path) => path.endsWith('/stdin'))

/**
 * One model call through the chain, the guard seated first. `person` is the session's permission decision
 * (rules, mode, auto mode's classifier or a prompt). What reached core is counted: for the mod's tool that is a
 * call nothing served, for Bash the command run for real.
 */
async function modelCall(setup: Awaited<ReturnType<typeof started>>, call: Record<string, unknown>, person: 'allow' | 'deny' = 'allow') {
  const { hook, world } = setup
  const reached = { permission: 0, core: [] as unknown[] }
  world.held.add(String(call.tool_use_id))
  const core = Object.assign(async (e: any) => {
    reached.core.push(e)
    return e.tool === 'Bash' ? { result: { stdout: 'the CLI ran', stderr: '', interrupted: false } } : { deny: `no hook answered ${e.tool}` }
  }, { event: 'tool.run' })
  // What the engine runs beneath the mod's tool.call: the permission check, then tool.run.
  const beneath = async (e: any) => {
    reached.permission += 1
    // Refused: the guard keeps holding the call until the person's next prompt.
    if (person === 'deny') return { deny: 'The user doesn\'t want to proceed with this tool use.' }
    // Allowed: forgotten at tool.run, ahead of the hooks beneath the guard.
    world.held.delete(String(e.tool_use_id))
    return hook('tool.*')(world.$, e, core)
  }
  const answer = await hook('tool.call')(world.$, call, beneath)
  return { answer: answer as any, reached }
}

const TOOL_CALL = { tool: MOD_TOOL, tool_use_id: 'toolu_tool', action: 'annotate', target: 'notes.md', gate: true }
const BASH_CALL = { tool: 'Bash', tool_use_id: 'toolu_bash', command: 'plannotator annotate notes.md --gate --json', description: 'Open notes.md in Plannotator' }

describe('behind the guard (Claude Code 2.1.326+, a Team or Enterprise login)', () => {
  test('the plannotator tool: the start the guard refuses goes to the session\'s check instead, and opens at tool.run', async () => {
    const setup = await started('tool', true)
    const { answer, reached } = await modelCall(setup, TOOL_CALL)

    expect(answer.deny).toBeUndefined()
    expect(answer.result).toContain('Opened notes.md in Plannotator: http://localhost:4321')
    expect([setup.world.refused, reached.permission, reached.core.length]).toEqual([1, 1, 0])
    expect(setup.world.launched).toEqual([['plannotator', 'annotate', 'notes.md', '--gate']])
    expect(launchFolders(setup.world)).toHaveLength(1)
  })

  test('a taken-over Bash `plannotator annotate notes.md --gate --json`: checked as the command it is, opened at tool.run, never run', async () => {
    const setup = await started('bash', true)
    const { answer, reached } = await modelCall(setup, BASH_CALL)

    expect(answer.result).toEqual({ stdout: expect.stringContaining('Opened notes.md in Plannotator: http://localhost:4321'), stderr: '', interrupted: false })
    expect([setup.world.refused, reached.permission, reached.core.length]).toEqual([1, 1, 0])
    expect(setup.world.launched).toEqual([['plannotator', 'annotate', 'notes.md', '--gate']])
    expect(launchFolders(setup.world)).toHaveLength(1)
  })

  test.each([
    ['the plannotator tool', 'tool', TOOL_CALL],
    ['a taken-over Bash command', 'bash', BASH_CALL],
  ])('%s the person refuses at the permission check opens nothing, and the refusal is what Claude reads', async (_name, id, call) => {
    const setup = await started(`refused-${id}`, true)
    const { answer, reached } = await modelCall(setup, call, 'deny')

    expect(answer).toEqual({ deny: 'The user doesn\'t want to proceed with this tool use.' })
    expect([setup.world.launched, reached.core, launchFolders(setup.world)]).toEqual([[], [], []])
  })

  // The person refuses the tool, then allows a Bash fallback with the same words in the same turn: the
  // guard still holds the refused call, so it refuses the start at tool.run too. Its advice ("serve an
  // allowed call at tool.run") would send Claude in a circle there; Claude reads what to do instead.
  test('a start refused at tool.run reads as the held call it is, not as the guard\'s advice', async () => {
    const setup = await started('held-at-run', true)
    await modelCall(setup, TOOL_CALL, 'deny')
    const { answer, reached } = await modelCall(setup, BASH_CALL)

    expect(answer).toEqual({ deny: HELD_AT_RUN_TEXT })
    expect(HELD_AT_RUN_TEXT).not.toContain('tool.run')
    expect([setup.world.launched, reached.core, launchFolders(setup.world)]).toEqual([[], [], []])
  })

  test("the mod's tool reaching tool.run is answered whatever ran before it (its tool.call or tool.check hook skipped)", async () => {
    const { hook, world } = await started('run-alone', true)
    const core = Object.assign(async () => ({ deny: `no hook answered ${MOD_TOOL}` }), { event: 'tool.run' })

    const answer = (await hook('tool.*')(world.$, TOOL_CALL, core)) as { result?: string }

    expect(answer.result).toContain('Opened notes.md in Plannotator')
    expect(world.launched).toHaveLength(1)
  })

  test("at tool.run, a subagent's `plannotator annotate` and any other command run as written", async () => {
    const { hook, world } = await started('run-as-written', true)
    const core = Object.assign(async (e: unknown) => ({ ran: e }), { event: 'tool.run' })

    for (const call of [
      { tool: 'Bash', tool_use_id: 'toolu_sub', agentId: 'agent_1', command: 'plannotator annotate notes.md' },
      { tool: 'Bash', tool_use_id: 'toolu_ls', command: 'ls -la' },
      { tool: 'Bash', tool_use_id: 'toolu_strict', command: 'plannotator annotate notes.md --require-approval' },
    ]) {
      expect(await hook('tool.*')(world.$, call, core)).toEqual({ ran: call })
    }
    expect(world.launched).toEqual([])
  })
})

describe('where no guard refuses (no guard, or Claude Code before 2.1.326): as before', () => {
  test.each([
    ['the plannotator tool', 'tool', TOOL_CALL],
    ['a taken-over Bash command', 'bash', BASH_CALL],
  ])('%s is answered at tool.call: no permission step, nothing beneath runs', async (_name, id, call) => {
    const setup = await started(`open-${id}`, false)
    const { answer, reached } = await modelCall(setup, call)

    expect(answer.deny).toBeUndefined()
    expect(JSON.stringify(answer.result)).toContain('Opened notes.md in Plannotator: http://localhost:4321')
    expect([reached.permission, reached.core.length, setup.world.launched.length]).toEqual([0, 0, 1])
  })

  test('another start error is still the answer, never passed on', async () => {
    const setup = await started('other-error', false)
    setup.world.$.process.run = async (argv: string[]) => {
      if (argv[3] === 'plannotator-launch') throw new Error('spawn plannotator ENOENT')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const { answer, reached } = await modelCall(setup, TOOL_CALL)

    expect(answer).toEqual({ deny: 'Plannotator could not start: spawn plannotator ENOENT' })
    expect(reached.permission).toBe(0)
  })
})

describe('registration', () => {
  test('tool.run is reached through `tool.*`, never by its name (an engine before 2.1.326 refuses to load a module naming it)', async () => {
    const { events, matchers } = await freshHooks('registration')

    expect(events).not.toContain('tool.run')
    expect(events).toContain('tool.*')
    // Matched like the engine matches: a name, or a pattern, in the `tool` list.
    const list = (matchers.get('tool.*') as { tool: (string | RegExp)[] }).tool
    const hears = (name: string) => list.some((entry) => (typeof entry === 'string' ? entry === name : entry.test(name)))
    const names = ['Bash', MOD_TOOL, 'mcp__plannotator__plannotator', 'Read', 'Edit', 'mcp__plannotator__plannotator_inbox', 'mcp__github__create_issue']
    expect(names.filter(hears)).toEqual(['Bash', MOD_TOOL, 'mcp__plannotator__plannotator'])
    // A call tool.call passes on is one this hook hears, or nothing would serve it.
    expect(names.map(isServedAtRun)).toEqual(names.map(hears))
  })
})
