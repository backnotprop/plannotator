/**
 * The mod in sessions that are not interactive, through the real registered hooks on a fake `$` (the engine
 * harness in apps/hook/tests needs `claude plugin test`). Claude Code's VS Code extension (#3111) and T3 Code
 * host Claude Code through the Agent SDK, so `session.start` says `isInteractive: false` and `surface: null`; the
 * extension runs the CLI with `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, T3 with `t3-code` and `T3CODE_THREAD_ID`.
 * What can regress: the panel or a T3 thread left without `plannotator_inbox` or the wake; a T3 thread filed as a
 * Claude Code session instead of the thread; any other session (`claude -p`, an Agent SDK app, Claude Desktop, a
 * `claude -p` started from inside a panel or thread) left with no Inbox tool, or promised a wake its run may not
 * live to deliver; Plannotator's own Ask AI child or the switch turned off reaching the Inbox; and a wake the SDK
 * host refuses being lost or tried again in a loop.
 */
import { describe, expect, test } from 'bun:test'
import { inboxRegistryPathOf, inboxSessionDirOf, INBOX_TICK_MS } from './inbox'
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH } from './inbox-contract'

type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown

async function freshHooks(name: string) {
  const { register } = (await import(`./register?${name}`)) as typeof import('./register')
  const held = new Map<string, Hook>()
  register(((event: string, ...args: unknown[]) => {
    if (!held.has(event)) held.set(event, args.at(-1) as Hook)
  }) as Parameters<typeof import('./register').register>[0])
  return (event: string) => held.get(event)!
}

async function settle() {
  for (let spin = 0; spin < 50; spin += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const SESSION = 'sess-vscode'
const DATA = '/data'
const PORT = 5150
const REGISTRY = JSON.stringify({ v: 1, pid: 4242, port: PORT, token: 't'.repeat(40), serverSession: 'srv', url: `http://127.0.0.1:${PORT}` })
/** What the VS Code extension's chat panel starts the CLI with (read in the 2.1.322 extension). */
const PANEL = { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }
/** What T3 Code starts a thread's Claude with (`mergeClaudeProcessEnvironment` and the thread's env, in T3's source). */
const T3 = { CLAUDE_CODE_ENTRYPOINT: 't3-code', T3CODE_THREAD_ID: 'a1b2c3d4-0000-4000-8000-000000000001' }
/** How the engine raises `session.start` for an Agent SDK host, the VS Code extension's included. */
const SDK_START = { isInteractive: false, surface: null, cwd: '/w' }
const REPLY = { type: 'reply', id: 'msg_reply', thread_id: 'msg_1', reply_to: 'msg_1', subject: 'Ship it?', body: 'Yes, after the freeze.', url: `http://localhost:${PORT}/#thread=msg_1` }

/** The engine beneath the mod: env, files, a clock the test moves, the timers it arms, and an Inbox on PORT. */
function engine(extraEnv: Record<string, string> = {}) {
  const files = new Map<string, string>([
    ['/bin/sh', ''],
    [inboxRegistryPathOf(DATA), REGISTRY],
  ])
  const env = new Map<string, string>(Object.entries({ HOME: '/home/me', PLANNOTATOR_DATA_DIR: DATA, ...extraEnv }))
  const store = new Map<string, unknown>()
  const timers: { ms: number; fn: () => void; live: boolean }[] = []
  const world = {
    files,
    env,
    now: 1_000_000,
    tools: [] as string[],
    envSet: [] as string[],
    fetches: [] as { path: string; body: any }[],
    submits: [] as string[],
    /** Ids the Inbox heard `delivered` for. */
    delivered: [] as string[],
    /** What `$.prompt.submit` resolves with; a `{ drop }` is the engine's refusal. */
    answer: undefined as unknown,
    /** Fire the Inbox tick `n` times, a second apart. */
    async ticks(n: number) {
      for (let i = 0; i < n; i++) {
        world.now += 1_000
        for (const timer of timers.filter((t) => t.live && t.ms === INBOX_TICK_MS)) timer.fn()
        await settle()
      }
    },
    $: {
      env: {
        get: async (name: string) => env.get(name),
        set: async (name: string, value: string) => {
          world.envSet.push(name)
          env.set(name, value)
        },
      },
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
        version: async () => ({ version: '2.1.322', base: '2.1.322' }),
      },
      clock: {
        now: async () => world.now,
        sleep: async () => undefined,
        every: (ms: number, fn: () => void) => {
          const timer = { ms, fn, live: true }
          timers.push(timer)
          return { cancel: () => void (timer.live = false) }
        },
      },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
      process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      http: {
        fetch: async (url: string, init?: { body?: string }) => {
          const path = url.replace(`http://127.0.0.1:${PORT}`, '')
          const body = init?.body ? JSON.parse(init.body) : undefined
          world.fetches.push({ path, body })
          const answer = (value: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(value) })
          if (path === INBOX_BRIDGE_POLL_PATH) return answer({ commands: world.delivered.includes(REPLY.id) ? [] : [REPLY] })
          if (path === '/api/inbox/health') return answer({ serverSession: 'srv' })
          if (path === '/mcp' && body?.method === 'tools/call') return answer({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Sent.' }] } })
          if (path === INBOX_BRIDGE_EVENT_PATH) {
            if (body?.type === 'delivered') world.delivered.push(body.id)
            return answer({ ok: true })
          }
          return { status: 404, ok: false, headers: {}, text: '' }
        },
      },
      tool: {
        register: async (spec: { name: string }) => {
          world.tools.push(spec.name)
          return { tool: `mcp__plugin_plannotator__${spec.name}` }
        },
      },
      command: { list: async () => [], register: async () => undefined },
      ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
      prompt: {
        submit: async ({ text }: { text: string }) => {
          world.submits.push(text)
          return world.answer
        },
        suggest: async () => undefined,
        read: async () => ({ text: '', cursor: 0 }),
      },
      turn: { abort: async () => undefined },
    },
  }
  return world
}

const pass = (e: unknown) => e

async function started(name: string, env: Record<string, string>) {
  const hook = await freshHooks(name)
  const world = engine(env)
  await hook('session.start')(world.$, SDK_START, async () => ({ cwd: '/w' }))
  await settle()
  return { hook, world }
}

const polls = (world: ReturnType<typeof engine>) => world.fetches.filter((f) => f.path === INBOX_BRIDGE_POLL_PATH)

/** One `plannotator_inbox` send through the registered hook: the arguments and `_meta` the Inbox's `/mcp` got. */
async function inboxCall(hook: Awaited<ReturnType<typeof freshHooks>>, world: ReturnType<typeof engine>) {
  const answer = (await hook('tool.call')(world.$, { tool: 'mcp__plugin_plannotator__plannotator_inbox', tool_use_id: 'toolu_inbox', action: 'send_message', subject: 'Hello', body: 'Ready.' }, pass)) as { result?: unknown; deny?: unknown }
  const call = world.fetches.find((f) => f.path === '/mcp' && f.body?.method === 'tools/call')
  expect([answer, call?.body?.params?.name]).toEqual([{ result: expect.any(String) }, 'send_message'])
  return { args: call!.body.params.arguments as Record<string, unknown>, meta: call!.body.params._meta as Record<string, unknown> | undefined }
}

describe("the VS Code extension's chat panel (CLAUDE_CODE_ENTRYPOINT=claude-vscode, not interactive)", () => {
  test('the mod runs: both tools registered, the session tagged, the Inbox polled as this session, and a reply goes in once as a turn', async () => {
    const { world } = await started('panel-wake', PANEL)

    expect(world.tools).toEqual(['plannotator_inbox', 'plannotator'])
    expect(world.env.get('PLANNOTATOR_SESSION_TAG')).toBe(`claude-code:${SESSION}`)

    await world.ticks(6)
    expect(polls(world).length).toBeGreaterThan(0)
    expect(polls(world).every((f) => f.body.session === SESSION && f.body.host === 'claude-code')).toBe(true)
    expect(world.submits).toHaveLength(1)
    expect(world.submits[0]).toContain(`Plannotator Inbox: ${REPLY.subject} (${REPLY.id})`)
    expect(world.submits[0]).toContain(REPLY.body)
    expect(world.delivered).toEqual([REPLY.id])

    await world.ticks(10)
    expect(world.submits).toHaveLength(1)
  })

  // The refusals the docs list for `$.prompt.submit` in an Agent SDK session, each resolved as `{ drop }`.
  for (const reason of [
    'the host has ended its input',
    'the run reached its --max-turns limit',
    'the session was stopped and nobody has sent input since',
  ]) {
    test(`a wake the host refuses ("${reason}") is not lost and not tried again until the person sends input; then it goes in once`, async () => {
      const { hook, world } = await started(`panel-drop-${reason.length}`, PANEL)
      world.answer = { drop: reason }

      await world.ticks(6)
      expect(world.submits).toHaveLength(1)
      expect(world.delivered).toEqual([])
      // Still owed: the next poll says the session holds it until input (the window's existing "Stopped" line).
      await world.ticks(30)
      expect(world.submits).toHaveLength(1)
      expect(polls(world).at(-1)?.body.held).toBe(true)

      // The person types into the panel: the SDK host's own turn.
      world.answer = undefined
      await hook('prompt.submit')(world.$, { text: 'carry on', origin: { kind: 'sdk' } }, async () => ({ text: 'carry on' }))
      await hook('turn.start')(world.$, { turnId: 'turn-1', text: 'carry on' }, pass)
      await hook('turn.complete')(world.$, { turnId: 'turn-1', answer: 'Done.' }, pass)
      await world.ticks(6)

      expect(world.submits).toHaveLength(2)
      expect(world.submits[1]).toContain(REPLY.body)
      expect(world.delivered).toEqual([REPLY.id])
    })
  }
})

describe("the person's prompt in the panel (origin sdk, the extension sends what they typed)", () => {
  const LEASE = `${inboxSessionDirOf(DATA, SESSION)}/watcher.json`
  const owner = (world: ReturnType<typeof engine>) => (JSON.parse(world.files.get(LEASE) ?? 'null') as { owner: string | null } | null)?.owner

  /** Another Claude Code process on this session (a `claude --continue` in a terminal) holds the Inbox lease, touched after this one started. */
  async function otherHolds(world: ReturnType<typeof engine>) {
    world.files.set(LEASE, JSON.stringify({ owner: 'other-process', at: world.now, touchedAt: world.now + 500 }))
    world.now += 1_000
  }

  test('reads as the person at the prompt: it pulls the Inbox lease to this process, as Enter in the terminal does', async () => {
    const { hook, world } = await started('panel-person', PANEL)
    await otherHolds(world)
    await hook('prompt.submit')(world.$, { text: 'carry on', origin: { kind: 'sdk' } }, async () => ({ text: 'carry on' }))
    await settle()
    expect(owner(world)).not.toBe('other-process')
    expect(owner(world)).toBeTruthy()
  })

  test("a background task's notification is not the person: the lease stays with the other process", async () => {
    const { hook, world } = await started('panel-notification', PANEL)
    await otherHolds(world)
    await hook('prompt.submit')(world.$, { text: 'Task done.', origin: { kind: 'task-notification' } }, async () => ({ text: 'Task done.' }))
    await settle()
    expect(owner(world)).toBe('other-process')
  })
})

/** What every Claude Code session that is not interactive and is neither the panel nor a T3 thread is. */
const HEADLESS: [string, Record<string, string>][] = [
  ['an Agent SDK app (sdk-ts)', { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }],
  ['an Agent SDK app (sdk-py)', { CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }],
  ['claude -p (sdk-cli)', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
  ['claude -p naming itself cli', { CLAUDE_CODE_ENTRYPOINT: 'cli' }],
  ['Claude Desktop (claude-desktop)', { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }],
  ['no entrypoint', {}],
  ['an entrypoint only near the panel one', { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode-insiders' }],
  ['a Claude T3 runs for no thread (t3-code, no T3CODE_THREAD_ID)', { CLAUDE_CODE_ENTRYPOINT: 't3-code' }],
  // A `claude -p` started from inside a panel session or a T3 thread inherits its entrypoint (and the thread id).
  ['claude -p from Claude\'s Bash in a panel session (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION)', { ...PANEL, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['a nested run with CLAUDE_CODE_CHILD_SESSION only', { ...PANEL, CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['a nested run with CLAUDECODE only', { ...PANEL, CLAUDECODE: '1' }],
  ['an agent job of a Plannotator CLI the panel\'s mod started (its session tag names that session)', { ...PANEL, PLANNOTATOR_SESSION_TAG: 'claude-code:the-panel-session' }],
  ['claude -p from Claude\'s Bash in a T3 thread', { CLAUDE_CODE_ENTRYPOINT: 't3-code', T3CODE_THREAD_ID: 'a1b2c3d4-0000-4000-8000-000000000001', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['an agent job of a CLI a T3 thread\'s mod started', { CLAUDE_CODE_ENTRYPOINT: 't3-code', T3CODE_THREAD_ID: 'a1b2c3d4-0000-4000-8000-000000000001', PLANNOTATOR_SESSION_TAG: 't3:another-thread' }],
]

describe('every other session that is not interactive (headless): the Inbox tool, no wake, the classic reviews', () => {
  for (const [name, env] of HEADLESS) {
    test(`${name}: plannotator_inbox as this session, the Inbox never polled, nothing submitted`, async () => {
      const { world } = await started(`headless-${name.replace(/[^a-z0-9]+/gi, '-')}`, env)
      await world.ticks(6)
      expect(world.tools).toEqual(['plannotator_inbox'])
      expect(world.env.get('PLANNOTATOR_SESSION_TAG')).toBe(`claude-code:${SESSION}`)
      expect(polls(world)).toEqual([])
      expect(world.submits).toEqual([])
    })
  }

  test('a send says nothing wakes the session (a one-shot run may end with its turn), and files as this session', async () => {
    const { hook, world } = await started('headless-send', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
    const calls = await inboxCall(hook, world)
    expect(calls.args).toMatchObject({ agent_session: SESSION, agent_host: 'claude-code', agent_name: 'Claude Code' })
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBeUndefined()
  })

  test("ExitPlanMode, the commands and Claude's Bash `plannotator review` keep the classic flows: the mod passes each on", async () => {
    const { hook, world } = await started('headless-classic', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
    const below = (e: unknown) => ({ passed: e })
    expect(await hook('tool.call')(world.$, { tool: 'ExitPlanMode', tool_use_id: 'toolu_1', plan: '# Plan\n' }, below)).toMatchObject({ passed: { tool: 'ExitPlanMode' } })
    expect(await hook('tool.call')(world.$, { tool: 'Bash', tool_use_id: 'toolu_2', command: 'plannotator review' }, below)).toMatchObject({ passed: { tool: 'Bash' } })
    expect(await hook('command.run')(world.$, { command: 'plannotator-review', args: '' }, below)).toMatchObject({ passed: { command: 'plannotator-review' } })
  })
})

describe('where the mod stands down', () => {
  const cases: [string, Record<string, string>][] = [
    // Plannotator's own agent must never get Plannotator's tools or reach the person's Inbox (recursion).
    ['Plannotator\'s Ask AI child in the panel (PLANNOTATOR_ASK_AI_CHILD=1)', { ...PANEL, PLANNOTATOR_ASK_AI_CHILD: '1' }],
    ['Plannotator\'s Ask AI child as claude -p', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', PLANNOTATOR_ASK_AI_CHILD: '1' }],
    ['Plannotator\'s Ask AI child in a T3 thread', { ...T3, PLANNOTATOR_ASK_AI_CHILD: '1' }],
    ['the panel with the mod turned off (PLANNOTATOR_CLAUDE_MOD=0)', { ...PANEL, PLANNOTATOR_CLAUDE_MOD: '0' }],
    ['claude -p with the mod turned off', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', PLANNOTATOR_CLAUDE_MOD: '0' }],
    ['a T3 thread with the mod turned off', { ...T3, PLANNOTATOR_CLAUDE_MOD: '0' }],
  ]
  for (const [name, env] of cases) {
    test(`${name}: no tool, nothing set, the Inbox never asked`, async () => {
      const { world } = await started(`inert-${name.replace(/[^a-z0-9]+/gi, '-')}`, env)
      await world.ticks(6)
      expect(world.tools).toEqual([])
      expect(world.envSet).toEqual([])
      expect(world.fetches).toEqual([])
      expect(world.submits).toEqual([])
    })
  }

  test("a module reload in the panel's own session (its tag already names it) runs the mod again", async () => {
    const { world } = await started('panel-reload', { ...PANEL, PLANNOTATOR_SESSION_TAG: `claude-code:${SESSION}` })
    expect(world.tools).toEqual(['plannotator_inbox', 'plannotator'])
  })

  test('the Inbox tool turned off in a headless session: nothing registered', async () => {
    const { world } = await started('headless-no-inbox', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', PLANNOTATOR_INBOX_TOOL: '0' })
    await world.ticks(6)
    expect(world.tools).toEqual([])
    expect(polls(world)).toEqual([])
  })
})

/** Every id form T3 gives a thread (packages/core/inbox-t3.ts). */
const T3_THREADS = [
  'a1b2c3d4-0000-4000-8000-000000000001',
  'mcp:a1b2c3d4-0000-4000-8000-000000000001',
  `mcp:launch:${'b'.repeat(64)}`,
  'thread:subagent:0123456789abcdef',
  'thread:provider:claudeAgent:native-thread:it%27s',
]

describe('a T3 Code thread (CLAUDE_CODE_ENTRYPOINT=t3-code beside T3CODE_THREAD_ID, not interactive)', () => {
  for (const thread of T3_THREADS) {
    test(`${thread}: both tools, the session tagged as the thread, the Inbox polled as host t3 and the thread, a reply in once as a turn`, async () => {
      const { world } = await started(`t3-${thread.replace(/[^a-z0-9]+/gi, '-')}`, { CLAUDE_CODE_ENTRYPOINT: 't3-code', T3CODE_THREAD_ID: thread })
      expect(world.tools).toEqual(['plannotator_inbox', 'plannotator'])
      expect(world.env.get('PLANNOTATOR_SESSION_TAG')).toBe(`t3:${thread}`)

      await world.ticks(6)
      expect(polls(world).length).toBeGreaterThan(0)
      expect(polls(world).every((f) => f.body.session === thread && f.body.host === 't3')).toBe(true)
      expect(world.submits).toHaveLength(1)
      expect(world.submits[0]).toContain(REPLY.body)
      expect(world.delivered).toEqual([REPLY.id])
      expect(world.fetches.filter((f) => f.path === INBOX_BRIDGE_EVENT_PATH).every((f) => f.body.session === thread && f.body.host === 't3')).toBe(true)

      await world.ticks(10)
      expect(world.submits).toHaveLength(1)
    })
  }

  test('a send files as host t3, the thread id and T3 Code, and says the wake will bring the reply', async () => {
    const { hook, world } = await started('t3-send', T3)
    const calls = await inboxCall(hook, world)
    expect(calls.args).toMatchObject({ agent_session: T3.T3CODE_THREAD_ID, agent_host: 't3', agent_name: 'T3 Code' })
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBe(true)
  })

  test("ExitPlanMode passes on to T3's own Plan mode; Claude's Bash `plannotator review` is the mod's", async () => {
    const { hook, world } = await started('t3-plan', T3)
    const below = (e: unknown) => ({ passed: e })
    expect(await hook('tool.call')(world.$, { tool: 'ExitPlanMode', tool_use_id: 'toolu_1', plan: '# Plan\n' }, below)).toMatchObject({ passed: { tool: 'ExitPlanMode' } })
  })

  test("the person's Enter in T3 (origin sdk) pulls the Inbox lease to this process, as in the terminal", async () => {
    const { hook, world } = await started('t3-person', T3)
    const lease = `${inboxSessionDirOf(DATA, T3.T3CODE_THREAD_ID)}/watcher.json`
    world.files.set(lease, JSON.stringify({ owner: 'other-process', at: world.now, touchedAt: world.now + 500 }))
    world.now += 1_000
    await hook('prompt.submit')(world.$, { text: 'carry on', origin: { kind: 'sdk' } }, async () => ({ text: 'carry on' }))
    await settle()
    expect((JSON.parse(world.files.get(lease) ?? 'null') as { owner: string | null } | null)?.owner).not.toBe('other-process')
  })

  test("a module reload in the thread's own session (its tag already names the thread) runs the mod again", async () => {
    const { world } = await started('t3-reload', { ...T3, PLANNOTATOR_SESSION_TAG: `t3:${T3.T3CODE_THREAD_ID}` })
    expect(world.tools).toEqual(['plannotator_inbox', 'plannotator'])
  })
})
