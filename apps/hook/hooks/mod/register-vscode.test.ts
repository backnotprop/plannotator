/**
 * The mod in sessions that are not interactive, through the real registered hooks on a fake `$` (the engine
 * harness in apps/hook/tests needs `claude plugin test`). The panel hosts (Claude Code's VS Code extension, #3111;
 * Orca, #3325), the Claude desktop app's Code tab (#3239) and T3 Code host Claude Code through the Agent SDK, so
 * `session.start` says `isInteractive: false` and `surface: null`; they run the CLI with `CLAUDE_CODE_ENTRYPOINT`
 * `claude-vscode`, `orca`, `claude-desktop` (`claude-desktop-3p`), T3 with `t3-code` and `T3CODE_THREAD_ID`.
 * What can regress: a panel host, the Code tab or a T3 thread left without `plannotator_inbox` or the wake; the
 * person's prompt in the panel or the Code tab not read as the person (the lease, an Ask AI take-over); the Code
 * tab given more than the Inbox tick (the `plannotator` tool, the commands, the Bash take-over, the reminder, the
 * mod's plan review); a Plannotator plan review opened beside Orca's own plan card; a T3 thread filed as a
 * Claude Code session instead of the thread; any other session (`claude -p`, an Agent SDK app, Cowork, a
 * `claude -p` started from inside a panel, a Code tab or a thread) left with no Inbox tool, or promised a wake its run may not
 * live to deliver; Plannotator's own Ask AI child or the switch turned off reaching the Inbox; and a wake the SDK
 * host refuses being lost or tried again in a loop.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeStubbedHtml, stubHookDistHtml } from '../../../../tests/helpers/hook-dist-stub'
import { NO_BROWSER } from '../../../../tests/helpers/no-browser'
import { inboxRegistryPathOf, inboxSessionDirOf, INBOX_OWNER_WAIT_MS, INBOX_TICK_MS } from './inbox'
import { BRIDGE_EVENT_PATH, BRIDGE_POLL_PATH } from './bridge'
import { inboxAskBridgeBase, INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH } from './inbox-contract'
import { MOD_HEAL_EVERY_MS } from './self-heal'

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
/** What Orca's chat starts the CLI with (#3325). */
const ORCA = { CLAUDE_CODE_ENTRYPOINT: 'orca' }
/** Every panel host: a person reads its chat, a plugin's turn shows there. */
const PANEL_HOSTS = [PANEL, ORCA]
/** What the Claude desktop app starts a Code tab session's CLI with (read in the 4.23118 app; `-3p`: a third-party inference provider). */
const DESKTOP = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }
const DESKTOP_3P = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-3p' }
const DESKTOP_HOSTS = [DESKTOP, DESKTOP_3P]
/** What T3 Code starts a thread's Claude with (`mergeClaudeProcessEnvironment` and the thread's env, in T3's source). */
const T3 = { CLAUDE_CODE_ENTRYPOINT: 't3-code', T3CODE_THREAD_ID: 'a1b2c3d4-0000-4000-8000-000000000001' }
/** How the engine raises `session.start` for an Agent SDK host, the VS Code extension's included. */
const SDK_START = { isInteractive: false, surface: null, cwd: '/w' }
/** How the engine raises `session.start` for a person at Claude Code's own prompt. */
const TERMINAL_START = { isInteractive: true, surface: 'terminal', cwd: '/w' }
const REPLY = { type: 'reply', id: 'msg_reply', thread_id: 'msg_1', reply_to: 'msg_1', subject: 'Ship it?', body: 'Yes, after the freeze.', url: `http://localhost:${PORT}/#thread=msg_1` }

/** The tools T3's own MCP server gives a thread's Claude, a few seconds after it starts. */
const T3_OWN_TOOLS = ['mcp__t3-code__get_thread', 'mcp__t3-code__send_message']

/** What two processes on one machine share: the data dir and the Inbox. */
function machine() {
  return {
    files: new Map<string, string>([
      ['/bin/sh', ''],
      [inboxRegistryPathOf(DATA), REGISTRY],
      // The person turned the Inbox on here (inbox-turned-on.ts).
      [`${DATA}/inbox/turned-on`, '{"on":true,"by":"command"}'],
    ]),
    /** Ids the Inbox heard `delivered` for. */
    delivered: [] as string[],
    /** The person's reply waits in the Inbox: every poll hands it out until it is delivered. */
    replyWaiting: true,
  }
}

/** The engine beneath the mod: env, files, a clock the test moves, the timers it arms, and an Inbox on PORT. */
function engine(
  extraEnv: Record<string, string> = {},
  options: {
    shared?: ReturnType<typeof machine>
    sessionId?: string
    listed?: string[]
    toolList?: 'missing' | 'hangs'
    /** An Inbox Ask AI question waiting on this session: the poll says `ask_waits`, and its bridge hands it out once. */
    ask?: { askId: string; text: string }
  } = {},
) {
  const shared = options.shared ?? machine()
  const files = shared.files
  const sessionId = options.sessionId ?? SESSION
  const env = new Map<string, string>(Object.entries({ HOME: '/home/me', PLANNOTATOR_DATA_DIR: DATA, ...extraEnv }))
  const store = new Map<string, unknown>()
  const timers: { ms: number; fn: () => void; live: boolean }[] = []
  let askHanded = false
  const world = {
    files,
    env,
    now: 1_000_000,
    tools: [] as string[],
    /** What `$.tool.list()` answers with (the session's tools, MCP ones included), and how often it was asked. */
    listed: [...(options.listed ?? [])],
    toolLists: 0,
    /** The MCP servers the context names (`$.session.usage`'s `mcpTools`), tools behind ToolSearch included. */
    servers: [] as string[],
    envSet: [] as string[],
    /** Every slash command the mod registered. */
    commands: [] as string[],
    fetches: [] as { path: string; body: any }[],
    submits: [] as string[],
    /** Every `$.process.run` argv (a review's launch among them). */
    runs: [] as string[][],
    /** Ids the Inbox heard `delivered` for. */
    delivered: shared.delivered,
    /** What the Ask AI client posted on the session's Ask bridge, in order. */
    askEvents: [] as { type: string; askId?: string; code?: string; text?: string; answer?: string }[],
    /** The process exits: none of its timers fires again. */
    kill() {
      for (const timer of timers) timer.live = false
    },
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
    /** Fire the self-heal timer `n` times, MOD_HEAL_EVERY_MS apart. */
    async heals(n: number) {
      for (let i = 0; i < n; i++) {
        world.now += MOD_HEAL_EVERY_MS
        for (const timer of timers.filter((t) => t.live && t.ms === MOD_HEAL_EVERY_MS)) timer.fn()
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
        id: async () => sessionId,
        cwd: async () => '/w',
        root: async () => '/w',
        messages: async () => [],
        version: async () => ({ version: '2.1.322', base: '2.1.322' }),
        usage: async () => ({ context: { window: 200_000, breakdown: { mcpTools: world.servers.map((serverName) => ({ name: `mcp__${serverName}__x`, serverName, tokens: 1, isLoaded: false })) } } }),
      },
      clock: {
        now: async () => world.now,
        // A few real milliseconds: a bound raced against a `$` call (`within`) loses to one that answers.
        sleep: (_ms: number, opts?: { signal?: AbortSignal }) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5)
            opts?.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true })
          }),
        every: (ms: number, fn: () => void) => {
          const timer = { ms, fn, live: true }
          timers.push(timer)
          return { cancel: () => void (timer.live = false) }
        },
      },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
      process: {
        run: async (argv: string[]) => {
          world.runs.push(argv)
          // A review's CLI comes up at once (as in apps/hook/tests/register.test.ts).
          if (argv[3] === 'plannotator-launch') files.set(`${argv[4]}/ready`, `${JSON.stringify({ url: 'http://localhost:4321', isRemote: false, port: 4321 })}\n`)
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
      http: {
        fetch: async (url: string, init?: { body?: string }) => {
          const path = url.replace(`http://127.0.0.1:${PORT}`, '')
          const body = init?.body ? JSON.parse(init.body) : undefined
          world.fetches.push({ path, body })
          const answer = (value: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(value) })
          if (path === INBOX_BRIDGE_POLL_PATH) {
            return answer({ commands: shared.replyWaiting && !world.delivered.includes(REPLY.id) ? [REPLY] : [], ...(options.ask && !askHanded ? { ask_waits: true } : {}) })
          }
          if (options.ask && path === `${inboxAskBridgeBase(sessionId)}${BRIDGE_POLL_PATH}`) {
            // A few real milliseconds, as the Inbox's poll waits: the client polls again at once.
            await new Promise((resolve) => setTimeout(resolve, 5))
            const commands = askHanded ? [] : [{ type: 'ask', ...options.ask }]
            askHanded = true
            return answer({ commands, features: ['taken_over'] })
          }
          if (options.ask && path === `${inboxAskBridgeBase(sessionId)}${BRIDGE_EVENT_PATH}`) {
            world.askEvents.push(...(Array.isArray(body?.events) ? body.events : [body]))
            return answer({ ok: true })
          }
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
        ...(options.toolList === 'missing'
          ? {}
          : {
              list: async () => {
                world.toolLists += 1
                if (options.toolList === 'hangs') return new Promise(() => undefined)
                return world.listed.map((name) => ({ name, description: '', mcp: name.startsWith('mcp__') }))
              },
            }),
        register: async (spec: { name: string }) => {
          world.tools.push(spec.name)
          return { tool: `mcp__plugin_plannotator__${spec.name}` }
        },
      },
      command: {
        list: async () => [],
        register: async (spec: { name: string }) => void world.commands.push(spec.name),
      },
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

async function started(name: string, env: Record<string, string>, options: Parameters<typeof engine>[1] = {}, start: typeof SDK_START | typeof TERMINAL_START = SDK_START) {
  const hook = await freshHooks(name)
  const world = engine(env, options)
  await hook('session.start')(world.$, start, async () => ({ cwd: '/w' }))
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

describe('a panel host: the VS Code extension, Orca (not interactive)', () => {
  test.each(PANEL_HOSTS)('the mod runs: both tools registered, the session tagged, the Inbox polled as this session, and a reply goes in once as a turn (%j)', async (env) => {
    const { world } = await started(`panel-wake-${env.CLAUDE_CODE_ENTRYPOINT}`, env)

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
    // Its own session from the start: the tool list is never asked.
    expect(world.toolLists).toBe(0)
  })

  // The refusals the docs list for `$.prompt.submit` in an Agent SDK session, each resolved as `{ drop }`.
  for (const reason of [
    'the host has ended its input',
    'the run reached its --max-turns limit',
    'the session was stopped and nobody has sent input since',
  ]) {
    test.each([PANEL, ORCA])(`a wake the host refuses ("${reason}") is not lost and not tried again until the person sends input; then it goes in once (%j)`, async (env) => {
      const { hook, world } = await started(`panel-drop-${reason.length}-${env.CLAUDE_CODE_ENTRYPOINT}`, env)
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

const launched = (world: ReturnType<typeof engine>, cli: string) => world.runs.some((argv) => argv.includes('plannotator-launch') && argv.includes(cli))

describe('ExitPlanMode in a panel host', () => {
  test.each([PANEL])("the mod's plan review opens (%j)", async (env) => {
    const { hook, world } = await started(`panel-plan-${env.CLAUDE_CODE_ENTRYPOINT}`, env)
    const below = (e: unknown) => ({ passed: e })
    const answer = await hook('tool.call')(world.$, { tool: 'ExitPlanMode', tool_use_id: 'toolu_plan', plan: '# Plan\n' }, below)
    expect(answer).not.toMatchObject({ passed: expect.anything() })
    expect(launched(world, 'claude-mod-plan')).toBe(true)
  })

  // Orca draws its own "Review proposed plan" card: a Plannotator review beside it was left open after the card approved.
  test("Orca: the mod opens no plan review and passes ExitPlanMode and its permission request on to Orca's card", async () => {
    const { hook, world } = await started('orca-plan', ORCA)
    const below = (e: unknown) => ({ passed: e })
    expect(await hook('tool.call')(world.$, { tool: 'ExitPlanMode', tool_use_id: 'toolu_plan', plan: '# Plan\n' }, below)).toMatchObject({ passed: { tool: 'ExitPlanMode' } })
    expect(await hook('classic.PermissionRequest')(world.$, { tool_name: 'ExitPlanMode', tool_use_id: 'toolu_plan', tool_input: { plan: '# Plan\n' } }, below)).toMatchObject({ passed: { tool_name: 'ExitPlanMode' } })
    expect(launched(world, 'claude-mod-plan')).toBe(false)
  })

  // When the mod passes ExitPlanMode on, Claude Code runs the plugin's classic command hook: the session's
  // environment, which that hook process inherits, is what turns it off (the process test below runs the real hook).
  const OWN_MARK = `claude-code:${SESSION}`
  test.each<[string, Record<string, string>, string | undefined, string | undefined, { listed?: string[] }, boolean]>([
    ['Orca', ORCA, '0', OWN_MARK, {}, false],
    // Sorted headless (an inherited tag, a nested run), still under Orca's card.
    ['Orca started from a Claude Code shell (another session\'s tag)', { ...ORCA, PLANNOTATOR_SESSION_TAG: 'claude-code:other' }, '0', OWN_MARK, {}, false],
    ['claude -p from Claude\'s Bash in an Orca session', { ...ORCA, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }, '0', OWN_MARK, {}, false],
    ['a T3 thread', T3, undefined, undefined, { listed: T3_OWN_TOOLS }, false],
    ['the VS Code panel', PANEL, undefined, undefined, {}, false],
    // The Code tab keeps the classic plan hook as before #3239: nothing turns it off.
    ["the desktop app's Code tab", DESKTOP, undefined, undefined, {}, false],
    ["the desktop app's Code tab (third-party provider)", DESKTOP_3P, undefined, undefined, {}, false],
    ['claude -p', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, undefined, undefined, {}, false],
    ['no entrypoint', {}, undefined, undefined, {}, false],
    ['the terminal', {}, undefined, undefined, {}, true],
  ])("%s: the session's hooks get PLANNOTATOR_PLAN_REVIEW=%p, marked %p", async (name, env, value, mark, options, interactive) => {
    const { world } = await started(`plan-env-${name.replace(/[^a-z0-9]+/gi, '-')}`, env, options, interactive ? TERMINAL_START : SDK_START)
    expect([world.env.get('PLANNOTATOR_PLAN_REVIEW'), world.env.get('PLANNOTATOR_PLAN_REVIEW_SET_BY')]).toEqual([value, mark])
  })

  // An Orca session's `0` reaches whatever it starts (a review server, the Inbox, an "Open in" terminal, a tmux
  // server); a terminal Claude Code started from one of those must still review plans.
  test.each<[string, Record<string, string>, typeof SDK_START | typeof TERMINAL_START]>([
    ['the terminal', {}, TERMINAL_START],
    ['the VS Code panel', PANEL, SDK_START],
  ])("%s inheriting another session's marked 0: plan review on, and both variables cleared", async (name, env, start) => {
    const inherited = { ...env, PLANNOTATOR_PLAN_REVIEW: '0', PLANNOTATOR_PLAN_REVIEW_SET_BY: 'claude-code:the-orca-session' }
    const { hook, world } = await started(`plan-inherited-${name.replace(/[^a-z0-9]+/gi, '-')}`, inherited, {}, start)
    expect([world.env.get('PLANNOTATOR_PLAN_REVIEW'), world.env.get('PLANNOTATOR_PLAN_REVIEW_SET_BY')]).toEqual(['', ''])
    const below = (e: unknown) => ({ passed: e })
    expect(await hook('tool.call')(world.$, { tool: 'ExitPlanMode', tool_use_id: 'toolu_plan', plan: '# Plan\n' }, below)).not.toMatchObject({ passed: expect.anything() })
    expect(launched(world, 'claude-mod-plan')).toBe(true)
  })

  test("the terminal with the person's own PLANNOTATOR_PLAN_REVIEW=0 (no marker): respected, nothing cleared", async () => {
    const { hook, world } = await started('plan-own-off', { PLANNOTATOR_PLAN_REVIEW: '0' }, {}, TERMINAL_START)
    expect([world.env.get('PLANNOTATOR_PLAN_REVIEW'), world.env.get('PLANNOTATOR_PLAN_REVIEW_SET_BY')]).toEqual(['0', undefined])
    const below = (e: unknown) => ({ passed: e })
    expect(await hook('tool.call')(world.$, { tool: 'ExitPlanMode', tool_use_id: 'toolu_plan', plan: '# Plan\n' }, below)).toMatchObject({ passed: { tool: 'ExitPlanMode' } })
  })

  test.each<[string, string, string | undefined]>([
    ['an explicit PLANNOTATOR_PLAN_REVIEW=1', '1', undefined],
    ['the person\'s own PLANNOTATOR_PLAN_REVIEW=off (no marker)', 'off', undefined],
  ])("Orca with %s: the person's value stays, unmarked", async (_name, value, mark) => {
    const { world } = await started(`orca-own-${value}`, { ...ORCA, PLANNOTATOR_PLAN_REVIEW: value })
    expect([world.env.get('PLANNOTATOR_PLAN_REVIEW'), world.env.get('PLANNOTATOR_PLAN_REVIEW_SET_BY')]).toEqual([value, mark])
  })

  test("Orca: the non-blocking code review stays the mod's (the command and Claude's Bash `plannotator review`)", async () => {
    const { hook, world } = await started('orca-review', ORCA)
    const below = (e: unknown) => ({ passed: e })
    expect(await hook('command.run')(world.$, { command: 'plannotator-review', args: '' }, below)).not.toMatchObject({ passed: expect.anything() })
    expect(await hook('tool.call')(world.$, { tool: 'Bash', tool_use_id: 'toolu_review', command: 'plannotator review' }, below)).not.toMatchObject({ passed: expect.anything() })
  })
})

describe("the person's prompt in the panel and the desktop app's Code tab (origin sdk, the host sends what they typed)", () => {
  const LEASE = `${inboxSessionDirOf(DATA, SESSION)}/watcher.json`
  const owner = (world: ReturnType<typeof engine>) => (JSON.parse(world.files.get(LEASE) ?? 'null') as { owner: string | null } | null)?.owner

  /** Another Claude Code process on this session (a `claude --continue` in a terminal) holds the Inbox lease, touched after this one started. */
  async function otherHolds(world: ReturnType<typeof engine>) {
    world.files.set(LEASE, JSON.stringify({ owner: 'other-process', at: world.now, touchedAt: world.now + 500 }))
    world.now += 1_000
  }

  test.each<[string, Record<string, string>]>([
    ['the panel', PANEL],
    ["the desktop app's Code tab", DESKTOP],
  ])('%s: reads as the person at the prompt: it pulls the Inbox lease to this process, as Enter in the terminal does', async (_where, env) => {
    const { hook, world } = await started(`person-${env.CLAUDE_CODE_ENTRYPOINT}`, env)
    await otherHolds(world)
    await hook('prompt.submit')(world.$, { text: 'carry on', origin: { kind: 'sdk' } }, async () => ({ text: 'carry on' }))
    await settle()
    expect(owner(world)).not.toBe('other-process')
    expect(owner(world)).toBeTruthy()
  })

  test.each<[string, Record<string, string>]>([
    ['the panel', PANEL],
    ["the desktop app's Code tab", DESKTOP],
  ])("%s: a background task's notification is not the person: the lease stays with the other process", async (_where, env) => {
    const { hook, world } = await started(`notification-${env.CLAUDE_CODE_ENTRYPOINT}`, env)
    await otherHolds(world)
    await hook('prompt.submit')(world.$, { text: 'Task done.', origin: { kind: 'task-notification' } }, async () => ({ text: 'Task done.' }))
    await settle()
    expect(owner(world)).toBe('other-process')
  })
})

/**
 * The Claude desktop app's Code tab (#3239): a `headless` session plus the Inbox reply wake. Before, it was sorted
 * headless: its link started without the tick, its sends went without the wake mark ("Saved for Claude Code. It sees
 * it when it next reads this thread."), and a reply went in only once the self-heal's second look (about 60 s after
 * the session started) armed the tick.
 */
describe("the desktop app's Code tab (claude-desktop, claude-desktop-3p): the Inbox tick and what rides on it, and nothing else changes", () => {
  test.each(DESKTOP_HOSTS)('plannotator_inbox alone, the session tagged, the Inbox polled as this session from the start, and a reply goes in once as a turn (%j)', async (env) => {
    const { world } = await started(`desktop-wake-${env.CLAUDE_CODE_ENTRYPOINT}`, env)

    // No `plannotator` tool and no slash commands: as in a headless session.
    expect(world.tools).toEqual(['plannotator_inbox'])
    expect(world.commands).toEqual([])
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

  // The send's mark is what the Inbox stores as the message's `wakes`: its line then reads "Sending to Claude Code…"
  // instead of "Saved for Claude Code…", and the send tool tells the agent the reply arrives by itself.
  test('the first send carries the wake mark, and a reply posted seconds after it goes in at once', async () => {
    const shared = { ...machine(), replyWaiting: false }
    const { hook, world } = await started('desktop-first-send', DESKTOP, { shared })
    const calls = await inboxCall(hook, world)
    expect(calls.args).toMatchObject({ agent_session: SESSION, agent_host: 'claude-code', agent_name: 'Claude Code' })
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBe(true)

    await world.ticks(2)
    expect(polls(world).length).toBeGreaterThan(0)
    expect(world.submits).toEqual([])
    // The person answers a few seconds after the send.
    shared.replyWaiting = true
    await world.ticks(3)
    expect(world.submits).toHaveLength(1)
    expect(world.submits[0]).toContain(REPLY.body)
    expect(world.delivered).toEqual([REPLY.id])
  })

  test("ExitPlanMode and its permission request, the commands and Claude's Bash `plannotator review` keep the classic flows: the mod passes each on", async () => {
    const { hook, world } = await started('desktop-classic', DESKTOP)
    const below = (e: unknown) => ({ passed: e })
    expect(await hook('tool.call')(world.$, { tool: 'ExitPlanMode', tool_use_id: 'toolu_plan', plan: '# Plan\n' }, below)).toMatchObject({ passed: { tool: 'ExitPlanMode' } })
    expect(await hook('classic.PermissionRequest')(world.$, { tool_name: 'ExitPlanMode', tool_use_id: 'toolu_plan', tool_input: { plan: '# Plan\n' } }, below)).toMatchObject({ passed: { tool_name: 'ExitPlanMode' } })
    expect(await hook('tool.call')(world.$, { tool: 'Bash', tool_use_id: 'toolu_review', command: 'plannotator review' }, below)).toMatchObject({ passed: { tool: 'Bash' } })
    expect(await hook('command.run')(world.$, { command: 'plannotator-review', args: '' }, below)).toMatchObject({ passed: { command: 'plannotator-review' } })
    expect(launched(world, 'claude-mod-plan')).toBe(false)
    expect(world.runs.some((argv) => argv.includes('plannotator-launch'))).toBe(false)
  })

  test("no Inbox reminder on the conversation's first prompt (the panel, the control, gets it)", async () => {
    const contextOf = async (name: string, env: Record<string, string>) => {
      const { hook, world } = await started(name, env)
      let context: unknown = null
      await hook('prompt.submit')(world.$, { text: 'Refactor the handler.', origin: { kind: 'sdk' } }, async (e: any) => {
        context = e?.context ?? null
        return { text: 'Refactor the handler.' }
      })
      return { context, variable: world.env.get('PLANNOTATOR_INBOX_REMINDER') }
    }
    const panel = await contextOf('desktop-reminder-control', PANEL)
    expect(panel.context).toEqual([expect.stringContaining('mcp__plugin_plannotator__plannotator_inbox')])
    expect(panel.variable).toBeTruthy()
    const tab = await contextOf('desktop-reminder', DESKTOP)
    expect(tab.context).toBeNull()
    expect(tab.variable).toBeFalsy()
  })

  // An Inbox Ask AI question runs as a plugin turn of the Code tab's conversation. The person typing there while it
  // runs takes the turn over: the rest of it answers them, so it must not stream into the Inbox's Ask answer.
  test('the person typing into an Inbox Ask AI turn takes it over: the answer keeps what came before and ends taken over', async () => {
    const shared = { ...machine(), replyWaiting: false }
    const ask = { askId: 'ask-1', text: 'Why is the build slow?' }
    const { hook, world } = await started('desktop-ask-takeover', DESKTOP, { shared, ask })
    const step = async (chunks: { kind: string; text?: string; stopReason?: string }[]) => {
      const stream = hook('turn.step')(world.$, { turnId: 'turn-ask' }, async function* () {
        yield* chunks
      }) as unknown as AsyncGenerator<unknown>
      for await (const _chunk of stream) void _chunk
      await settle()
    }

    for (let tick = 0; tick < 20 && world.submits.length === 0; tick++) await world.ticks(1)
    expect(world.submits).toEqual([expect.stringContaining(ask.text)])
    await hook('turn.start')(world.$, { turnId: 'turn-ask', text: world.submits[0] }, pass)
    await step([{ kind: 'text', text: 'Half an' }, { kind: 'stop', stopReason: 'tool_use' }])

    await hook('prompt.submit')(world.$, { text: 'Stop, do this instead.', turnId: 'turn-ask', origin: { kind: 'sdk' } }, async () => ({ text: 'Stop, do this instead.' }))
    await step([{ kind: 'text', text: 'Doing what you asked.' }, { kind: 'stop', stopReason: 'end_turn' }])
    await hook('turn.complete')(world.$, { turnId: 'turn-ask', answer: 'Doing what you asked.' }, pass)
    for (let spin = 0; spin < 20 && !world.askEvents.some((e) => e.type === 'done' || e.type === 'error'); spin++) await settle()

    const ours = world.askEvents.filter((e) => e.askId === ask.askId)
    expect(ours.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('Half an')
    expect(ours.filter((e) => e.type === 'done' || e.type === 'error').map((e) => [e.type, e.code])).toEqual([['error', 'taken_over']])
    await hook('session.end')(world.$, { sessionId: SESSION }, pass)
  })

  test('a wake the desktop app refuses is not lost and not tried again until the person sends input; then it goes in once', async () => {
    const { hook, world } = await started('desktop-drop', DESKTOP)
    world.answer = { drop: 'the host has ended its input' }

    await world.ticks(6)
    expect(world.submits).toHaveLength(1)
    expect(world.delivered).toEqual([])
    await world.ticks(30)
    expect(world.submits).toHaveLength(1)
    expect(polls(world).at(-1)?.body.held).toBe(true)

    world.answer = undefined
    await hook('prompt.submit')(world.$, { text: 'carry on', origin: { kind: 'sdk' } }, async () => ({ text: 'carry on' }))
    await hook('turn.start')(world.$, { turnId: 'turn-1', text: 'carry on' }, pass)
    await hook('turn.complete')(world.$, { turnId: 'turn-1', answer: 'Done.' }, pass)
    await world.ticks(6)

    expect(world.submits).toHaveLength(2)
    expect(world.submits[1]).toContain(REPLY.body)
    expect(world.delivered).toEqual([REPLY.id])
  })

  test.each<[string, Record<string, string>, [string, string][]]>([
    ['the Inbox tool turned off (PLANNOTATOR_INBOX_TOOL=0)', { ...DESKTOP, PLANNOTATOR_INBOX_TOOL: '0' }, []],
    // #3729: the Inbox turns on only once the person ran it here.
    ['the Inbox not turned on here (its mark says off)', DESKTOP, [[`${DATA}/inbox/turned-on`, '{"on":false}']]],
  ])('%s: no tool, the Inbox never polled, nothing submitted', async (_name, env, files) => {
    const shared = machine()
    for (const [path, text] of files) shared.files.set(path, text)
    const { world } = await started(`desktop-off-${_name.replace(/[^a-z0-9]+/gi, '-')}`, env, { shared })
    await world.ticks(6)
    expect(world.tools).toEqual([])
    expect(polls(world)).toEqual([])
    expect(world.submits).toEqual([])
  })
})

/** What every Claude Code session that is not interactive and is neither the panel nor a T3 thread is. */
const HEADLESS: [string, Record<string, string>][] = [
  ['an Agent SDK app (sdk-ts)', { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }],
  ['an Agent SDK app (sdk-py)', { CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }],
  ['claude -p (sdk-cli)', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
  ['claude -p naming itself cli', { CLAUDE_CODE_ENTRYPOINT: 'cli' }],
  ["the desktop app's Cowork (local-agent)", { CLAUDE_CODE_ENTRYPOINT: 'local-agent' }],
  ['an entrypoint only near the Code tab one', { CLAUDE_CODE_ENTRYPOINT: 'Claude-Desktop' }],
  ['no entrypoint', {}],
  ['a child of an Orca panel', { ...ORCA, CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['a different Orca session inherits a tag', { ...ORCA, PLANNOTATOR_SESSION_TAG: 'claude-code:other' }],
  ['an entrypoint only near the panel one', { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode-insiders' }],
  ['a Claude T3 runs for no thread (t3-code, no T3CODE_THREAD_ID)', { CLAUDE_CODE_ENTRYPOINT: 't3-code' }],
  // A `claude -p` started from inside a panel session or a T3 thread inherits its entrypoint (and the thread id).
  ['claude -p from Claude\'s Bash in a panel session (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION)', { ...PANEL, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['a nested run with CLAUDE_CODE_CHILD_SESSION only', { ...PANEL, CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['a nested run with CLAUDECODE only', { ...PANEL, CLAUDECODE: '1' }],
  ['an agent job of a Plannotator CLI the panel\'s mod started (its session tag names that session)', { ...PANEL, PLANNOTATOR_SESSION_TAG: 'claude-code:the-panel-session' }],
  // The same guards for the desktop app's Code tab (#3239): a `claude -p` from its Bash inherits `claude-desktop`.
  ['claude -p from Claude\'s Bash in a Code tab session (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION)', { ...DESKTOP, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['a nested run in a Code tab with CLAUDE_CODE_CHILD_SESSION only', { ...DESKTOP_3P, CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['a nested run in a Code tab with CLAUDECODE only', { ...DESKTOP, CLAUDECODE: '1' }],
  ['an agent job of a Plannotator CLI a Code tab\'s mod started (its session tag names that session)', { ...DESKTOP, PLANNOTATOR_SESSION_TAG: 'claude-code:the-code-tab-session' }],
  ['claude -p from Claude\'s Bash in a T3 thread', { CLAUDE_CODE_ENTRYPOINT: 't3-code', T3CODE_THREAD_ID: 'a1b2c3d4-0000-4000-8000-000000000001', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['an agent job of a CLI a T3 thread\'s mod started', { CLAUDE_CODE_ENTRYPOINT: 't3-code', T3CODE_THREAD_ID: 'a1b2c3d4-0000-4000-8000-000000000001', PLANNOTATOR_SESSION_TAG: 't3:another-thread' }],
  // T3 before 0.1.7 sets no entrypoint and leaves CLAUDECODE from the shell it was started in.
  ['a thread of T3 before 0.1.7 (no entrypoint)', { T3CODE_THREAD_ID: 'a1b2c3d4-0000-4000-8000-000000000001' }],
  ['a thread of T3 before 0.1.7 started from a Claude Code shell', { T3CODE_THREAD_ID: 'a1b2c3d4-0000-4000-8000-000000000001', CLAUDECODE: '1', PLANNOTATOR_SESSION_TAG: 'claude-code:0f8fad5b-d9cb-469f-a165-000000000000' }],
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
      expect(world.toolLists).toBe(0)
    })
  }

  test('a send says nothing wakes the session (a one-shot run may end with its turn), and files as this session', async () => {
    const { hook, world } = await started('headless-send', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
    const calls = await inboxCall(hook, world)
    expect(calls.args).toMatchObject({ agent_session: SESSION, agent_host: 'claude-code', agent_name: 'Claude Code' })
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBeUndefined()
  })

  // The control for the Code tab's first send (#3239): a plain `claude -p` is unchanged by it.
  test('claude -p after a send, with a reply waiting: no tick started, nothing polled or submitted', async () => {
    const { hook, world } = await started('headless-send-then-reply', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
    await inboxCall(hook, world)
    await world.ticks(6)
    expect(polls(world)).toEqual([])
    expect(world.submits).toEqual([])
  })

  // Pins today's behaviour, not the design: the guide says a headless session's bridge is never polled, but the
  // self-heal's second look arms the tick of a link built without the wake (`InboxLink.ensureTicking`). Whether that
  // stays is the owner's decision; this test fails the day it changes, so the change is made on purpose.
  test('today: a claude -p that lives past two self-heal looks (about 60 s) starts polling and takes a waiting reply as a turn', async () => {
    const { world } = await started('headless-late-tick', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
    await world.ticks(6)
    await world.heals(1)
    await world.ticks(6)
    expect(polls(world)).toEqual([])
    expect(world.submits).toEqual([])

    await world.heals(1)
    await world.ticks(6)
    expect(polls(world).length).toBeGreaterThan(0)
    expect(world.submits).toEqual([expect.stringContaining(REPLY.body)])
    expect(world.delivered).toEqual([REPLY.id])
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
      const { world } = await started(`t3-${thread.replace(/[^a-z0-9]+/gi, '-')}`, { CLAUDE_CODE_ENTRYPOINT: 't3-code', T3CODE_THREAD_ID: thread }, { listed: T3_OWN_TOOLS })
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
    const { hook, world } = await started('t3-send', T3, { listed: T3_OWN_TOOLS })
    const calls = await inboxCall(hook, world)
    expect(calls.args).toMatchObject({ agent_session: T3.T3CODE_THREAD_ID, agent_host: 't3', agent_name: 'T3 Code' })
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBe(true)
  })

  test("ExitPlanMode passes on to T3's own Plan mode; Claude's Bash `plannotator review` is the mod's", async () => {
    const { hook, world } = await started('t3-plan', T3, { listed: T3_OWN_TOOLS })
    const below = (e: unknown) => ({ passed: e })
    expect(await hook('tool.call')(world.$, { tool: 'ExitPlanMode', tool_use_id: 'toolu_1', plan: '# Plan\n' }, below)).toMatchObject({ passed: { tool: 'ExitPlanMode' } })
  })

  test("the person's Enter in T3 (origin sdk) pulls the Inbox lease to this process, as in the terminal", async () => {
    const { hook, world } = await started('t3-person', T3, { listed: T3_OWN_TOOLS })
    const lease = `${inboxSessionDirOf(DATA, T3.T3CODE_THREAD_ID)}/watcher.json`
    world.files.set(lease, JSON.stringify({ owner: 'other-process', at: world.now, touchedAt: world.now + 500 }))
    world.now += 1_000
    await hook('prompt.submit')(world.$, { text: 'carry on', origin: { kind: 'sdk' } }, async () => ({ text: 'carry on' }))
    await settle()
    expect((JSON.parse(world.files.get(lease) ?? 'null') as { owner: string | null } | null)?.owner).not.toBe('other-process')
  })

  test("a module reload in the thread's own session (its tag already names the thread) runs the mod again", async () => {
    const { world } = await started('t3-reload', { ...T3, PLANNOTATOR_SESSION_TAG: `t3:${T3.T3CODE_THREAD_ID}` }, { listed: T3_OWN_TOOLS })
    expect(world.tools).toEqual(['plannotator_inbox', 'plannotator'])
  })
})

describe("which process is a T3 thread: the one with T3's t3-code tools", () => {
  const THREAD = T3.T3CODE_THREAD_ID
  const LEASE = `${inboxSessionDirOf(DATA, THREAD)}/watcher.json`
  const lease = (shared: { files: Map<string, string> }) => JSON.parse(shared.files.get(LEASE) ?? 'null') as { owner: string | null; at: number } | null
  const OTHER_SESSION = '0f8fad5b-d9cb-469f-a165-000000000000'
  /** Processes on one machine, one clock: each tick moves every one a second, in turn. */
  async function together(n: number, ...worlds: ReturnType<typeof engine>[]) {
    for (let i = 0; i < n; i++) {
      const now = Math.max(...worlds.map((w) => w.now))
      for (const world of worlds) {
        world.now = now
        await world.ticks(1)
      }
    }
  }

  test("T3 started from another Claude Code session's shell (its tag and project inherited): the thread, filed as host t3 and the thread", async () => {
    const { hook, world } = await started(
      't3-inherited-tag',
      { ...T3, PLANNOTATOR_SESSION_TAG: `claude-code:${OTHER_SESSION}`, PLANNOTATOR_SESSION_PROJECT: `claude-code:${OTHER_SESSION}:/elsewhere` },
      { listed: T3_OWN_TOOLS },
    )
    expect(world.tools).toEqual(['plannotator_inbox', 'plannotator'])
    expect(world.env.get('PLANNOTATOR_SESSION_TAG')).toBe(`t3:${THREAD}`)
    const calls = await inboxCall(hook, world)
    expect(calls.args).toMatchObject({ agent_session: THREAD, agent_host: 't3', agent_name: 'T3 Code' })
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBe(true)
    await world.ticks(6)
    expect(polls(world).length).toBeGreaterThan(0)
    expect(polls(world).every((f) => f.body.session === THREAD && f.body.host === 't3')).toBe(true)
    expect(world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
  })

  test("T3's own short run with the thread's environment (no t3-code tools) never takes the lease; the thread gets the reply once", async () => {
    const shared = machine()
    shared.replyWaiting = false
    const thread = await started('t3-owner-thread', T3, { shared, sessionId: 'sess-thread', listed: T3_OWN_TOOLS })
    await together(3, thread.world)
    const holder = lease(shared)?.owner
    expect(holder).toBeTruthy()
    // Made after the thread, and the SDK host's prompt (a title request) is origin sdk: neither moves the lease.
    const helper = await started('t3-owner-helper', T3, { shared, sessionId: 'sess-helper' })
    helper.world.now = thread.world.now
    await helper.hook('prompt.submit')(helper.world.$, { text: 'Write a title.', origin: { kind: 'sdk' } }, async () => ({ text: 'Write a title.' }))
    await settle()
    shared.replyWaiting = true
    await together(12, thread.world, helper.world)
    expect(lease(shared)?.owner).toBe(holder)
    expect(polls(helper.world)).toEqual([])
    expect(helper.world.submits).toEqual([])
    expect(thread.world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
    expect(shared.delivered).toEqual([REPLY.id])
    // Its send files as the thread, marked as the thread's (it cannot tell itself apart), and moves nothing.
    const calls = await inboxCall(helper.hook, helper.world)
    expect(calls.args).toMatchObject({ agent_session: THREAD, agent_host: 't3' })
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBe(true)
    expect(lease(shared)?.owner).toBe(holder)
    await together(6, thread.world, helper.world)
    expect(polls(helper.world)).toEqual([])
  })

  test('the tools never appear (a T3 that adds no t3-code server): no lease, no poll, past the wait and after it; asked again slowly', async () => {
    const { hook, world } = await started('t3-owner-never', T3)
    await world.ticks(4)
    world.now += INBOX_OWNER_WAIT_MS
    await world.ticks(4)
    expect(world.files.has(LEASE)).toBe(false)
    expect(polls(world)).toEqual([])
    expect(world.submits).toEqual([])
    const asked = world.toolLists
    await world.ticks(60)
    // Settled on no: asked every 30 s, not every 2 s.
    expect(world.toolLists - asked).toBeGreaterThanOrEqual(1)
    expect(world.toolLists - asked).toBeLessThanOrEqual(3)
    const calls = await inboxCall(hook, world)
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBe(true)
    await world.ticks(6)
    expect(polls(world)).toEqual([])
    expect(world.files.has(LEASE)).toBe(false)
  })

  test("the thread's first send before its tools show: the send waits for them, goes marked, and the reply goes in once", async () => {
    const { hook, world } = await started('t3-send-first', T3)
    // The tools show while the send waits (its third ask).
    let asks = 0
    const list = world.$.tool.list
    world.$.tool.list = async () => {
      if (++asks === 3) world.listed = [...T3_OWN_TOOLS]
      return list()
    }
    const calls = await inboxCall(hook, world)
    expect(calls.args).toMatchObject({ agent_session: THREAD, agent_host: 't3', agent_name: 'T3 Code' })
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBe(true)
    expect(lease(world)?.owner).toBeTruthy()
    await world.ticks(6)
    expect(world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
    await world.ticks(10)
    expect(world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
  })

  test("the thread's first send while its tools never show within the wait: still marked, and the reply goes in once they do", async () => {
    const { hook, world } = await started('t3-send-early', T3)
    const calls = await inboxCall(hook, world)
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBe(true)
    expect(polls(world)).toEqual([])
    world.listed = [...T3_OWN_TOOLS]
    await world.ticks(8)
    expect(world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
  })

  test('confirmed late, after the 3-minute wait settled on no: the next touch asks again at once, and so does the slow ask', async () => {
    for (const how of ['touch', 'slow ask'] as const) {
      const { hook, world } = await started(`t3-late-${how.replace(' ', '-')}`, T3)
      await world.ticks(2)
      world.now += INBOX_OWNER_WAIT_MS
      await world.ticks(3)
      expect(polls(world)).toEqual([])
      world.listed = [...T3_OWN_TOOLS]
      if (how === 'touch') {
        await hook('prompt.submit')(world.$, { text: 'carry on', origin: { kind: 'sdk' } }, async () => ({ text: 'carry on' }))
        await settle()
        await world.ticks(6)
      } else {
        await world.ticks(36)
      }
      expect([how, world.submits.filter((text) => text.includes(REPLY.body)).length]).toEqual([how, 1])
    }
  })

  test('tools behind ToolSearch (the list leaves them out): the context names the t3-code server, and that is the thread', async () => {
    const { world } = await started('t3-deferred', T3)
    world.servers = ['t3-code']
    await world.ticks(6)
    expect(polls(world).length).toBeGreaterThan(0)
    expect(world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
  })

  test('a Claude Code without $.tool.list: the thread runs as before the check (the lease at once, polled, delivered once)', async () => {
    const { world } = await started('t3-no-tool-list', T3, { toolList: 'missing' })
    expect(lease(world)?.owner).toBeTruthy()
    await world.ticks(6)
    expect(polls(world).length).toBeGreaterThan(0)
    expect(world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
  })

  test('a $.tool.list that never answers holds neither the tick nor a send', async () => {
    const { hook, world } = await started('t3-tool-list-hangs', T3, { toolList: 'hangs' })
    await world.ticks(6)
    expect(world.toolLists).toBeGreaterThan(1)
    const calls = await inboxCall(hook, world)
    expect(calls.meta?.['ai.plannotator/inbox-wakes']).toBe(true)
    expect(polls(world)).toEqual([])
  })

  test('the thread still starting (its tools a few seconds late): it polls once they appear, and delivers once', async () => {
    const { world } = await started('t3-owner-late', T3)
    await world.ticks(4)
    expect(polls(world)).toEqual([])
    world.listed = [...T3_OWN_TOOLS]
    await world.ticks(8)
    expect(polls(world).length).toBeGreaterThan(0)
    expect(world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
  })

  test('T3 restarts the thread under the same Claude session id: the new process takes the lease once the old one is gone and delivers the waiting reply once', async () => {
    const shared = machine()
    shared.replyWaiting = false
    const before = await started('t3-restart-before', T3, { shared, sessionId: 'sess-thread', listed: T3_OWN_TOOLS })
    await together(3, before.world)
    const first = lease(shared)?.owner
    expect(first).toBeTruthy()
    // Gone without a session.end (T3 stopped it): its lease goes stale.
    before.world.kill()
    shared.replyWaiting = true
    const after = await started('t3-restart-after', T3, { shared, sessionId: 'sess-thread' })
    after.world.now = before.world.now
    await after.world.ticks(3)
    after.world.listed = [...T3_OWN_TOOLS]
    // A live lease stands: nothing is delivered until it is stale.
    await after.world.ticks(5)
    expect(after.world.submits).toEqual([])
    await after.world.ticks(25)
    expect(lease(shared)?.owner).not.toBe(first)
    expect(after.world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
    expect(before.world.submits).toEqual([])
    expect(shared.delivered).toEqual([REPLY.id])
    await after.world.ticks(10)
    expect(after.world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
  })

  test('the thread ends its session (session.end): the next process takes the lease at once', async () => {
    const shared = machine()
    shared.replyWaiting = false
    const before = await started('t3-end-before', T3, { shared, sessionId: 'sess-thread', listed: T3_OWN_TOOLS })
    await together(3, before.world)
    await before.hook('session.end')(before.world.$, { sessionId: 'sess-thread', reason: 'other' }, pass)
    await settle()
    before.world.kill()
    expect(lease(shared)?.owner).toBeNull()
    shared.replyWaiting = true
    const after = await started('t3-end-after', T3, { shared, sessionId: 'sess-thread', listed: T3_OWN_TOOLS })
    after.world.now = before.world.now
    await after.world.ticks(6)
    expect(after.world.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
  })

  test("two live processes with the thread's tools: one polls, one delivers", async () => {
    const shared = machine()
    const one = await started('t3-two-one', T3, { shared, sessionId: 'sess-thread', listed: T3_OWN_TOOLS })
    const two = await started('t3-two-two', T3, { shared, sessionId: 'sess-thread', listed: T3_OWN_TOOLS })
    await together(15, one.world, two.world)
    const all = [...one.world.submits, ...two.world.submits].filter((text) => text.includes(REPLY.body))
    expect(all).toHaveLength(1)
    expect(shared.delivered).toEqual([REPLY.id])
    expect([polls(one.world).length > 0, polls(two.world).length > 0].filter(Boolean)).toHaveLength(1)
  })
})

/**
 * The plugin's classic plan hook (hooks.json: PermissionRequest on ExitPlanMode runs `plannotator`), run as Claude Code
 * runs it: a process with the session's environment, which holds what the mod set. Claude Code runs it in an Orca
 * session once the mod passes ExitPlanMode on (a real Orca run opened a Plannotator review beside Orca's card). Temp
 * HOME and data dir; no browser; no Inbox.
 */
describe("the plugin's classic plan hook, in the environment the mod leaves the session", () => {
  const entry = resolve(import.meta.dir, '../../server/index.ts')
  const roots: string[] = []
  let stubs: string[] = []
  beforeAll(() => {
    stubs = stubHookDistHtml()
  })
  afterAll(() => {
    removeStubbedHtml(stubs)
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  async function classicPlanHook(sessionEnv: Map<string, string>, timeoutMs: number, sessionId = SESSION) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-host-plan-card-')))
    roots.push(root)
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { recursive: true })
    const env: Record<string, string | undefined> = {}
    // Nothing from the shell running the tests speaks for the session (a Claude Code session's own CLAUDE* and PLANNOTATOR_*).
    for (const [name, value] of Object.entries(process.env)) if (!/^(CLAUDE|PLANNOTATOR_)/.test(name)) env[name] = value
    Object.assign(env, Object.fromEntries(sessionEnv), {
      HOME: join(root, 'home'),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_PORT: '0',
      PLANNOTATOR_REMOTE: '0',
      PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
      NO_BROWSER,
      BROWSER: NO_BROWSER,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_AI: 'disabled',
      PLANNOTATOR_SHARE: 'disabled',
    })
    const payload = { session_id: sessionId, transcript_path: '/nowhere/transcript.jsonl', cwd: '/w', permission_mode: 'plan', hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: '# Ship it\n\n1. Do the thing.\n' } }
    const proc = Bun.spawn([process.execPath, 'run', entry], { cwd: root, stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe', env })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    clearTimeout(timer)
    const sessions = join(dataDir, 'sessions')
    return { stdout, stderr, code, sessions: existsSync(sessions) ? readdirSync(sessions) : [] }
  }

  test("Orca: it opens nothing and exits 0 with no decision, so Orca's own plan card decides", async () => {
    const { world } = await started('classic-plan-orca', ORCA)
    const run = await classicPlanHook(world.env, 20_000)
    expect(run.code).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).not.toContain('http://')
    expect(run.sessions).toEqual([])
  }, 30_000)

  // A Claude Code with no mod to clear it (the mod off, an older Claude Code) started from something the Orca session
  // started: its own hook, with the Orca session's marked 0 in its environment, still opens the review.
  test("the Orca session's marked 0 in another session's hook: the review opens", async () => {
    const { world } = await started('classic-plan-orca-elsewhere', ORCA)
    const run = await classicPlanHook(world.env, 6_000, 'a-terminal-session')
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('http://')
  }, 30_000)

  // The control: where the mod reviews plans itself the classic hook still opens one when it is reached (it never is:
  // the mod's ExitPlanMode answer comes first), so the cases above are not vacuous.
  test('the VS Code panel: the same hook opens a review', async () => {
    const { world } = await started('classic-plan-vscode', PANEL)
    const run = await classicPlanHook(world.env, 6_000)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('http://')
  }, 30_000)

  // #3239 keeps the Code tab's plan review where it was: the mod passes ExitPlanMode on, and this hook opens the review.
  test("the desktop app's Code tab: the same hook opens a review", async () => {
    const { world } = await started('classic-plan-desktop', DESKTOP)
    const run = await classicPlanHook(world.env, 6_000)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('http://')
  }, 30_000)
})
