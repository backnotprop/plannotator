import { describe, expect, test } from 'bun:test'
import { AUTO_RELOAD_ARGS, AUTO_RELOAD_COMMAND, AUTO_RELOAD_PROMPT_GAP_TICKS } from './auto-reload'
import { inboxRegistryPathOf } from './inbox'
import { INBOX_AUTO_RELOAD_POLL_FIELD, INBOX_RELOAD_FIELD } from './inbox-contract'

// Auto reload through the real registered hooks (review of #2873): the gates
// the controller tests drive by method must also be wired from register.ts.
// The failures this catches: `turn.complete` with an agent id no longer
// reaching the count (auto reload would then never run), `turn.start` with one
// not counting, `$.agent.list()` not asked (an agent started before this module
// loaded is missed), and a prompt between Enter and its turn start not holding
// the run.

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })
const ROOT = '/plugins/cache/plannotator/plannotator/0.28.50'

type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown

/** A fresh copy of register.ts (its module state is per process), and its hooks by event. */
async function freshHooks(name: string) {
  const { register } = (await import(`./register?${name}`)) as typeof import('./register')
  const held = new Map<string, Hook>()
  register(((event: string, ...args: unknown[]) => {
    if (!held.has(event)) held.set(event, args.at(-1) as Hook)
  }) as Parameters<typeof import('./register').register>[0])
  return (event: string) => held.get(event)!
}

const realSleep = (ms: number, options?: { signal?: AbortSignal }) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    options?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

/** The `$` the module runs on, in memory, with an Inbox whose poll answers offer `installed`. */
function engineOver(sessionId: string, installed: string) {
  const files = new Map<string, string>([
    ['/bin/sh', ''],
    [inboxRegistryPathOf(DATA), REGISTRY],
    [`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'plannotator', version: '0.28.50' })],
  ])
  const store = new Map<string, unknown>()
  const timers = new Set<{ ms: number; fn: () => void; due: number }>()
  let clock = 1_000_000
  const world = {
    commands: [] as string[],
    polls: [] as Record<string, unknown>[],
    agents: [] as { id: string; status: string }[],
    tick: async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        clock += 1_000
        for (const timer of [...timers]) {
          if (!timers.has(timer) || clock < timer.due) continue
          timer.due += timer.ms
          timer.fn()
        }
        for (let spin = 0; spin < 500; spin += 1) await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    $: {
      plugin: { root: ROOT },
      env: { get: async (name: string) => (name === 'HOME' ? '/home/me' : name === 'PLANNOTATOR_DATA_DIR' ? DATA : undefined), set: async () => undefined },
      fs: {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => {
          const text = files.get(path)
          if (text === undefined) throw new Error(`ENOENT: ${path}`)
          return text
        },
        write: async (path: string, text: string) => void files.set(path, text),
        stat: async () => null,
      },
      session: {
        id: async () => sessionId,
        cwd: async () => '/home/me/src/app',
        root: async () => '/home/me/src/app',
        messages: async () => [],
        version: async () => ({ version: '2.1.319', base: '2.1.319' }),
      },
      clock: {
        now: async () => clock,
        sleep: realSleep,
        every: (ms: number, fn: () => void) => {
          const timer = { ms, fn, due: clock + ms }
          timers.add(timer)
          return { cancel: () => timers.delete(timer) }
        },
      },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
      process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      http: {
        fetch: async (url: string, init: { body?: string }) => {
          if (url.endsWith('/api/inbox/bridge/poll')) world.polls.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>)
          return { status: 200, ok: true, text: JSON.stringify({ commands: [], [INBOX_RELOAD_FIELD]: { installed } }) }
        },
      },
      tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
      command: {
        list: async () => [],
        register: async () => undefined,
        run: async ({ command, args }: { command: string; args?: string }) => {
          world.commands.push(`/${command}${args ? ` ${args}` : ''}`)
          return {}
        },
      },
      agent: { list: async () => world.agents },
      ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
      prompt: { submit: async () => undefined, suggest: async () => undefined, read: async () => ({ text: '', cursor: 0 }) },
      turn: { abort: async () => undefined },
    },
  }
  return world
}

const RELOAD = `/${AUTO_RELOAD_COMMAND} ${AUTO_RELOAD_ARGS}`
const pass = (e: unknown) => e

describe('auto reload through the registered hooks', () => {
  test('a subagent turn (turn.start / turn.complete with an agent id) holds the run until it ends', async () => {
    const hook = await freshHooks('auto-reload-agent-turns')
    const world = engineOver('sess-agents', '0.28.51')
    const { $ } = world
    await hook('session.start')($, { isInteractive: true }, async () => ({ cwd: '/home/me/src/app' }))
    await hook('turn.start')($, { turnId: 'agent-turn-1', text: 'research', agentId: 'agent-7' }, pass)
    await world.tick(5)
    expect(world.polls.length).toBeGreaterThan(0)
    expect(world.polls.every((poll) => poll[INBOX_AUTO_RELOAD_POLL_FIELD] === true)).toBe(true)
    expect(world.commands).toEqual([])
    await hook('turn.complete')($, { turnId: 'agent-turn-1', agentId: 'agent-7', answer: 'found it' }, pass)
    await world.tick(3)
    expect(world.commands).toEqual([RELOAD])
    await hook('session.end')($, {}, pass)
  })

  test("an agent in $.agent.list() that this module never saw start holds the run", async () => {
    const hook = await freshHooks('auto-reload-agent-list')
    const world = engineOver('sess-agent-list', '0.28.52')
    const { $ } = world
    // Started before this module loaded (a manual /reload-plugins, or an earlier auto reload).
    world.agents = [{ id: 'agent-old', status: 'running' }]
    await hook('session.start')($, { isInteractive: true }, async () => ({ cwd: '/home/me/src/app' }))
    await world.tick(5)
    expect(world.commands).toEqual([])
    world.agents = [{ id: 'agent-old', status: 'completed' }]
    await world.tick(3)
    expect(world.commands).toEqual([RELOAD])
    await hook('session.end')($, {}, pass)
  })

  test('a prompt between Enter and its turn start holds the run', async () => {
    const hook = await freshHooks('auto-reload-prompt-gap')
    const world = engineOver('sess-prompt-gap', '0.28.53')
    const { $ } = world
    await hook('session.start')($, { isInteractive: true }, async () => ({ cwd: '/home/me/src/app' }))
    // The hooks beneath are still working on the prompt (prompt.submit has not resolved).
    let enter: (value: unknown) => void = () => undefined
    const submitted = hook('prompt.submit')($, { text: 'go', origin: { kind: 'composer' } }, () => new Promise((resolve) => (enter = resolve)))
    // Longer than the gap a prompt that entered gets: a prompt still inside prompt.submit has no time limit.
    await world.tick(AUTO_RELOAD_PROMPT_GAP_TICKS + 10)
    expect(world.commands).toEqual([])
    enter({ text: 'go' })
    await submitted
    await world.tick(3)
    expect(world.commands).toEqual([])
    await hook('turn.start')($, { turnId: 'turn-1', text: 'go' }, pass)
    await hook('turn.complete')($, { turnId: 'turn-1', answer: 'done' }, pass)
    await world.tick(3)
    expect(world.commands).toEqual([RELOAD])
    await hook('session.end')($, {}, pass)
  })
})
