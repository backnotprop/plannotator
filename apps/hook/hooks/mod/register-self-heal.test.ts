import { describe, expect, test } from 'bun:test'
import { inboxRegistryPathOf, inboxSessionDirOf, INBOX_TICK_MS } from './inbox'
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

const SESSION = 'sess-heal'
const DATA = '/data'
const LEASE = `${inboxSessionDirOf(DATA, SESSION)}/watcher.json`
const REGISTRY = JSON.stringify({ v: 1, pid: 4242, port: 5150, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:5150' })

function engine() {
  const files = new Map<string, string>([
    ['/bin/sh', ''],
    [inboxRegistryPathOf(DATA), REGISTRY],
  ])
  const env = new Map<string, string>([
    ['HOME', '/home/me'],
    ['PLANNOTATOR_DATA_DIR', DATA],
  ])
  const store = new Map<string, unknown>()
  const timers: { ms: number; fn: () => void; live: boolean }[] = []
  const world = {
    files,
    timers,
    now: 1_000_000,
    idHangs: false,
    live: (ms: number) => timers.filter((timer) => timer.live && timer.ms === ms),
    async fire(ms: number) {
      for (const timer of world.live(ms)) timer.fn()
      await settle()
    },
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
        id: () => (world.idHangs ? new Promise(() => undefined) : Promise.resolve(SESSION)),
        cwd: async () => '/w',
        root: async () => '/w',
        messages: async () => [],
        version: async () => ({ version: '2.1.318', base: '2.1.318' }),
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
      http: { fetch: async () => ({ status: 200, ok: true, text: JSON.stringify({ commands: [] }) }) },
      tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
      command: { list: async () => [], register: async () => undefined },
      ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
      prompt: { submit: async () => undefined, suggest: async () => undefined },
      turn: { abort: async () => undefined },
    },
  }
  return world
}

const pass = (e: unknown) => e

async function started(name: string) {
  const hook = await freshHooks(name)
  const world = engine()
  await hook('session.start')(world.$, { isInteractive: true }, async () => ({ cwd: '/w' }))
  await settle()
  return { hook, world }
}

const lease = (world: ReturnType<typeof engine>) => JSON.parse(world.files.get(LEASE) ?? 'null') as { owner: string | null } | null

describe('session.end', () => {
  test("another session's or a subagent's end keeps the instance polling and its lease", async () => {
    const { hook, world } = await started('end-other')
    expect(world.live(INBOX_TICK_MS)).toHaveLength(1)
    const owner = lease(world)?.owner
    expect(owner).toBeTruthy()

    await hook('session.end')(world.$, { reason: 'other', sessionId: 'fork-1' }, pass)
    await hook('session.end')(world.$, { reason: 'other', sessionId: SESSION, agentId: 'agent-7' }, pass)
    await settle()

    expect(world.live(INBOX_TICK_MS)).toHaveLength(1)
    expect(lease(world)?.owner).toBe(owner)
  })

  test("this session's own end disposes at once, without waiting on $.session.id()", async () => {
    const { hook, world } = await started('end-own')
    world.idHangs = true
    const ended = await Promise.race([
      Promise.resolve(hook('session.end')(world.$, { reason: 'prompt_input_exit', sessionId: SESSION }, pass)).then(() => 'ended'),
      new Promise((resolve) => setTimeout(() => resolve('held'), 200)),
    ])
    await settle()

    expect(ended).toBe('ended')
    expect(world.live(INBOX_TICK_MS)).toHaveLength(0)
    expect(lease(world)?.owner).toBeNull()
  })
})

describe('the self-heal', () => {
  test('session.start arms it once; a disposed instance is made again after one whole period, and only then', async () => {
    const { hook, world } = await started('heal-rebuild')
    expect(world.live(MOD_HEAL_EVERY_MS)).toHaveLength(1)

    await hook('session.end')(world.$, { reason: 'other', sessionId: SESSION }, pass)
    await settle()
    expect(world.live(INBOX_TICK_MS)).toHaveLength(0)

    world.now += MOD_HEAL_EVERY_MS - 1
    await world.fire(MOD_HEAL_EVERY_MS)
    expect(world.live(INBOX_TICK_MS)).toHaveLength(0)

    world.now += 1
    await world.fire(MOD_HEAL_EVERY_MS)
    expect(world.live(INBOX_TICK_MS)).toHaveLength(1)
    world.now += MOD_HEAL_EVERY_MS
    await world.fire(MOD_HEAL_EVERY_MS)
    expect(world.timers.filter((timer) => timer.ms === INBOX_TICK_MS)).toHaveLength(2)
  })

  test('a timer the engine ended (it stopped firing) is armed again at a turn end, never twice', async () => {
    const { hook, world } = await started('heal-rearm')
    expect(world.timers.filter((timer) => timer.ms === MOD_HEAL_EVERY_MS)).toHaveLength(1)
    const turnEnd = async (id: string) => {
      await hook('turn.complete')(world.$, { turnId: id, answer: 'Done.' }, pass)
      await settle()
    }

    world.now += MOD_HEAL_EVERY_MS
    await world.fire(MOD_HEAL_EVERY_MS)
    world.now += MOD_HEAL_EVERY_MS
    await turnEnd('t1')
    expect(world.timers.filter((timer) => timer.ms === MOD_HEAL_EVERY_MS)).toHaveLength(1)

    world.now += 2 * MOD_HEAL_EVERY_MS
    await turnEnd('t2')
    await turnEnd('t3')
    expect(world.timers.filter((timer) => timer.ms === MOD_HEAL_EVERY_MS)).toHaveLength(2)
    expect(world.live(MOD_HEAL_EVERY_MS)).toHaveLength(1)
  })

  test("a healed link never takes the lease another live process holds (it says nothing of the person's presence)", async () => {
    const { hook, world } = await started('heal-lease')
    await hook('session.end')(world.$, { reason: 'other', sessionId: SESSION }, pass)
    await settle()
    expect(lease(world)?.owner).toBeNull()

    world.now += MOD_HEAL_EVERY_MS
    const other = JSON.stringify({ owner: 'other-process', at: world.now, touchedAt: world.now - 5_000 })
    world.files.set(LEASE, other)
    await world.fire(MOD_HEAL_EVERY_MS)
    expect(world.live(INBOX_TICK_MS)).toHaveLength(1)
    expect(lease(world)?.owner).toBe('other-process')
    for (let second = 0; second < 6; second++) {
      world.now += 1_000
      world.files.set(LEASE, JSON.stringify({ owner: 'other-process', at: world.now, touchedAt: world.now - 5_000 }))
      await world.fire(INBOX_TICK_MS)
      expect(lease(world)?.owner).toBe('other-process')
    }
  })
})
