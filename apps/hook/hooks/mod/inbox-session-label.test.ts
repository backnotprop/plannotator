import { describe, expect, test } from 'bun:test'
import { InboxLink, INBOX_SESSION_NAMES_MAX, inboxRegistryPathOf, readSessionNames, sessionNamesAfterCommand, STORE_INBOX_SESSION_NAMES } from './inbox'
import { register } from './register'
import { fakeHost } from './testing/fake-host'

// Session labels (approval "inbox-session-label", Change 2026-11-01): a Claude
// Code session shows a label only once it is named with `/rename`. The engine
// tells a plugin the name nowhere else, so `command.run` keeps it in `$.store`.
// The failures this catches: an unnamed session showing anything; the wiring from
// the hook through `PlannotatorMod` to the link coming undone, which no fake
// `label` can see; a `/clear` losing a name the engine kept, or keeping one the
// engine moved; a `--resume` not finding the name; another session's name; a poll
// that cannot read the store blanking a labelled row; the hook changing
// `/rename`'s or `/clear`'s answer, or stopping or holding them when `$` fails; a
// write with the mod off; and a write of nothing new undoing another session's.
//
// That a real `/rename` raises this hook needs the engine, so it is checked by
// hand in a real session; apps/hook/tests/register.test.ts does not run it.

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })

async function ticks(host: ReturnType<typeof fakeHost>, n: number) {
  for (let i = 0; i < n; i += 1) {
    host.clock += 1_000
    await host.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function linkOver(host: ReturnType<typeof fakeHost>, label?: () => string | Promise<string>) {
  host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
  const polls: Record<string, unknown>[] = []
  host.onFetch = (url, body) => {
    if (url.endsWith('/api/inbox/bridge/poll')) polls.push(body as Record<string, unknown>)
    return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
  }
  const link = new InboxLink({ host, dataDir: DATA, sessionId: 'sess-1', tools: [], isBusy: () => false, instanceId: 'me', ...(label ? { label } : {}) })
  return { link, polls }
}

type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown

/** The module's hooks as the engine holds them: `event` to its matcher and function. */
function hooks(registerOn: typeof register = register) {
  const held = new Map<string, { matcher: unknown; run: Hook }[]>()
  registerOn((event: string, ...args: unknown[]) => {
    held.set(event, [...(held.get(event) ?? []), { matcher: args.length > 1 ? args[0] : undefined, run: args.at(-1) as Hook }])
  })
  return {
    only: (event: string) => held.get(event)![0]!.run,
    /** The `command.run` hook the engine selects for `command`, by its matcher. */
    command: (command: string) => held.get('command.run')!.find((hook) => (hook.matcher as { command: string[] }).command.includes(command))!.run,
  }
}

/**
 * `$.clock.sleep` on real time, the way the bound around the store needs it: a
 * sleep that answers at once would end that bound before any write.
 */
const realSleep = (ms: number, options?: { signal?: AbortSignal }) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    options?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

const NOW = 1_000

function named(...ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, { name: `Name of ${id}`, at: NOW }]))
}

describe('what a command does to the names', () => {
  const after = (record: ReturnType<typeof named>, command: string, args: string, before: string, moved = before) => sessionNamesAfterCommand(record, { command, args, before, after: moved }, NOW)

  test('/rename names the session, trimmed, and replaces the name it had', () => {
    expect(after({}, 'rename', '  Fix login redirect ', 's1')).toEqual({ s1: { name: 'Fix login redirect', at: NOW } })
    expect(after(named('s1'), 'rename', 'Docs pass', 's1').s1?.name).toBe('Docs pass')
  })

  test('a bare /rename reads as unnamed: the model chose a name we are not told, and the old one is wrong now', () => {
    expect(after(named('s1', 's2'), 'rename', '', 's1')).toEqual(named('s2'))
  })

  test("/clear takes the name to the new session id, as the engine does; the old session keeps it for a resume", () => {
    const names = after(named('old'), 'clear', '', 'old', 'new')
    expect(names.new?.name).toBe('Name of old')
    expect(names.old?.name).toBe('Name of old')
  })

  test('/clear <name> names the session it left, and the new one has none', () => {
    const names = after({}, 'clear', 'Finished login work', 'old', 'new')
    expect(names).toEqual({ old: { name: 'Finished login work', at: NOW } })
  })

  test('/clear of an unnamed session names nothing; one that did not move the id changes nothing', () => {
    expect(after({}, 'clear', '', 'old', 'new')).toEqual({})
    expect(after(named('s1'), 'clear', 'Ignored', 's1')).toEqual(named('s1'))
  })

  test('the store stays bounded: the oldest names go first', () => {
    const full = Object.fromEntries(Array.from({ length: INBOX_SESSION_NAMES_MAX }, (_, i) => [`s${i}`, { name: 'n', at: i }]))
    const names = sessionNamesAfterCommand(full, { command: 'rename', args: 'Newest', before: 'new', after: 'new' }, INBOX_SESSION_NAMES_MAX)
    expect(Object.keys(names)).toHaveLength(INBOX_SESSION_NAMES_MAX)
    expect(names.new?.name).toBe('Newest')
    expect(names.s0).toBeUndefined()
    expect(names.s1).toBeDefined()
  })

  test('a command that changes nothing hands back the same record: the hook writes only a change', () => {
    const record = named('s1')
    expect(after(record, 'clear', '', 'unnamed', 'new')).toBe(record)
    expect(after(record, 'clear', 'Ignored', 's1')).toBe(record)
    expect(after(record, 'rename', '', 'unnamed')).toBe(record)
    expect(after(record, 'rename', 'Name of s1', 's1')).toBe(record)
  })

  test('what the store holds is read with care: another shape is no name', () => {
    expect(readSessionNames(undefined)).toEqual({})
    expect(readSessionNames([])).toEqual({})
    expect(readSessionNames({ a: 'text', b: { name: 7, at: 1 }, c: { name: 'ok' }, d: { name: '', at: 1 }, e: null, f: { name: 'Kept', at: 2 } })).toEqual({ f: { name: 'Kept', at: 2 } })
  })
})

describe('the command.run hook', () => {
  function storeOf(session: string) {
    const values = new Map<string, unknown>()
    let writes = 0
    return {
      values,
      writes: () => writes,
      $: {
        session: { id: async () => session },
        clock: { now: async () => NOW, sleep: realSleep },
        store: {
          get: async (key: string) => values.get(key),
          set: async (key: string, value: unknown) => {
            writes += 1
            values.set(key, value)
          },
        },
      },
    }
  }

  test("the engine's own command runs and its answer comes back as it was", async () => {
    const { $ } = storeOf('s1')
    const input = { command: 'rename', args: 'Fix login redirect' }
    const answer = { ref: 4 }
    let passed: unknown
    const got = await hooks().command('rename')($, input, (e) => {
      passed = e
      return answer
    })
    expect(passed).toBe(input)
    expect(got).toBe(answer)
  })

  test('a command that fails names nothing, and still fails', async () => {
    const { $, values } = storeOf('s1')
    await expect(
      (async () =>
        hooks().command('rename')($, { command: 'rename', args: 'Never ran' }, () => {
          throw new Error('refused')
        }))(),
    ).rejects.toThrow('refused')
    expect(values.has(STORE_INBOX_SESSION_NAMES)).toBe(false)
  })

  const never = () => new Promise<never>(() => undefined)
  const refuse = async () => {
    throw new Error('the store is gone')
  }
  const engine = {
    session: { id: async () => 's1' },
    clock: { now: async () => NOW, sleep: realSleep },
    store: { get: async () => undefined, set: async () => undefined },
  }

  test.each<[string, unknown]>([
    [
      'the session id throws where it is called',
      {
        ...engine,
        session: {
          id: () => {
            throw new Error('no session')
          },
        },
      },
    ],
    ['the session id rejects', { ...engine, session: { id: refuse } }],
    [
      'reading `$.session` throws',
      {
        ...engine,
        get session() {
          throw new Error('no session')
        },
      },
    ],
    ['the store rejects a read', { ...engine, store: { ...engine.store, get: refuse } }],
    ['the store rejects a write', { ...engine, store: { ...engine.store, set: refuse } }],
    ['a read never settles', { ...engine, store: { ...engine.store, get: never } }],
    ['a write never settles', { ...engine, store: { ...engine.store, set: never } }],
  ])('%s: the command still runs once and its answer comes back', async (_how, $) => {
    const input = { command: 'clear', args: '' }
    const answer = { ref: 4 }
    let ran = 0
    const got = await hooks().command('clear')($, input, (e) => {
      ran += 1
      expect(e).toBe(input)
      return answer
    })
    expect(ran).toBe(1)
    expect(got).toBe(answer)
  })

  test('a command that changed nothing writes nothing', async () => {
    const { $, writes } = storeOf('s1')
    await hooks().command('clear')($, { command: 'clear', args: '' }, () => ({ ref: 2 }))
    await hooks().command('rename')($, { command: 'rename', args: '' }, () => ({ ref: 1 }))
    expect(writes()).toBe(0)
  })

  test("a session whose /clear changed nothing cannot undo a name another session wrote meanwhile", async () => {
    const shared = storeOf('other')
    const on = hooks()
    const clearing = {
      ...shared.$,
      session: { id: async () => 'unnamed' },
      store: {
        ...shared.$.store,
        // This read lands first; the other session's whole write lands before this one acts on it.
        get: async (key: string) => {
          const seen = shared.values.get(key)
          await on.command('rename')(shared.$, { command: 'rename', args: 'Named elsewhere' }, () => ({ ref: 1 }))
          return seen
        },
      },
    }
    await on.command('clear')(clearing, { command: 'clear', args: '' }, () => ({ ref: 2 }))
    expect(readSessionNames(shared.values.get(STORE_INBOX_SESSION_NAMES)).other?.name).toBe('Named elsewhere')
  })
})

/**
 * What session.start decided lives in the module, one answer per process, and a
 * process has only one first session.start. So each test here gets its own copy
 * of the module; the query only keeps Bun from handing back the cached one.
 */
async function freshRegister(name: string): Promise<typeof register> {
  const path = `./register?${name}`
  return ((await import(path)) as { register: typeof register }).register
}

describe('what session.start decided', () => {
  const engineWith = (env: Record<string, string>) => {
    const store = new Map<string, unknown>()
    return {
      store,
      $: {
        env: { get: async (name: string) => env[name], set: async () => undefined },
        fs: { exists: async () => true, read: async () => { throw new Error('ENOENT') } },
        session: { id: async () => 's1', cwd: async () => '/w', root: async () => '/w' },
        clock: { now: async () => NOW, sleep: realSleep },
        store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
      },
    }
  }

  test('with the mod off, /rename runs and nothing is kept', async () => {
    const on = hooks(await freshRegister('knob-off'))
    const { $, store } = engineWith({ HOME: '/home/me', PLANNOTATOR_DATA_DIR: DATA, PLANNOTATOR_CLAUDE_MOD: '0' })
    await on.only('session.start')($, { isInteractive: true }, async () => ({ cwd: '/w' }))

    const answer = { ref: 1 }
    expect(await on.command('rename')($, { command: 'rename', args: 'Fix login redirect' }, () => answer)).toBe(answer)
    expect(store.size).toBe(0)
  })

  test('a first /rename that beats session.start is kept: the mod may turn out on', async () => {
    const on = hooks(await freshRegister('before-start'))
    const { $, store } = engineWith({})
    await on.command('rename')($, { command: 'rename', args: 'Fix login redirect' }, () => ({ ref: 1 }))
    expect(readSessionNames(store.get(STORE_INBOX_SESSION_NAMES)).s1?.name).toBe('Fix login redirect')
  })
})

describe('the poll', () => {
  test('carries the name on every poll, so a /rename reaches the next one', async () => {
    const host = fakeHost()
    let name = ''
    const { link, polls } = linkOver(host, () => name)
    link.start()
    await ticks(host, 2)
    expect(polls.length).toBeGreaterThan(0)
    expect(polls.every((poll) => poll.label === '')).toBe(true)

    name = 'Fix login redirect'
    await ticks(host, 2)
    expect(polls.at(-1)!.label).toBe('Fix login redirect')

    name = ''
    await ticks(host, 2)
    expect(polls.at(-1)!.label).toBe('')
    link.dispose()
  })

  test.each([
    ['rejects', (): Promise<string> => Promise.reject(new Error('the store is gone'))],
    ['throws', (): string => { throw new Error('the store is gone') }],
  ] as const)('a source that %s cannot tell: the last word stands, and "" still clears', async (_how, cannotTell) => {
    const host = fakeHost()
    let read: () => string | Promise<string> = () => 'Fix login redirect'
    const { link, polls } = linkOver(host, () => read())
    link.start()
    await ticks(host, 2)
    expect(polls.at(-1)!.label).toBe('Fix login redirect')

    read = cannotTell
    const seen = polls.length
    await ticks(host, 3)
    expect(polls.length).toBeGreaterThan(seen)
    expect(polls.slice(seen).every((poll) => poll.label === 'Fix login redirect')).toBe(true)

    read = () => ''
    await ticks(host, 2)
    expect(polls.at(-1)!.label).toBe('')
    link.dispose()
  })

  test('a link with no name source sends no field', async () => {
    const host = fakeHost()
    const { link, polls } = linkOver(host)
    link.start()
    await ticks(host, 2)
    expect(polls.length).toBeGreaterThan(0)
    expect(polls.every((poll) => !('label' in poll))).toBe(true)
    link.dispose()
  })
})

/** The `$` the module runs on, in memory: enough for the real session.start, instance and link. */
function engineOver(firstSession: string) {
  const files = new Map<string, string>([
    ['/bin/sh', ''],
    [inboxRegistryPathOf(DATA), REGISTRY],
  ])
  const store = new Map<string, unknown>()
  const timers = new Set<() => void>()
  const polls: { session: unknown; label: unknown }[] = []
  let clock = 1_000_000
  const world = {
    sessionId: firstSession,
    polls,
    store,
    tick: async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        clock += 1_000
        for (const fn of [...timers]) fn()
        for (let spin = 0; spin < 500; spin += 1) await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    $: {
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
        id: async () => world.sessionId,
        cwd: async () => '/home/me/src/ai-collab',
        root: async () => '/home/me/src/ai-collab',
        messages: async () => [],
        version: async () => ({ version: '2.1.316', base: '2.1.316' }),
      },
      clock: {
        now: async () => clock,
        sleep: realSleep,
        every: (_ms: number, fn: () => void) => {
          timers.add(fn)
          return { cancel: () => timers.delete(fn) }
        },
      },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
      process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      http: {
        fetch: async (url: string, init: { body?: string }) => {
          if (url.endsWith('/api/inbox/bridge/poll')) {
            const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
            polls.push({ session: body.session, label: body.label })
          }
          return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
        },
      },
      tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
      command: { list: async () => [], register: async () => undefined },
      ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
      prompt: { submit: async () => undefined, suggest: async () => undefined },
      turn: { abort: async () => undefined },
    },
  }
  return world
}

describe('from /rename to a poll body', () => {
  test('through the real hooks, instance and link: unnamed, named, renamed, /clear, a resume, and another session', async () => {
    const on = hooks()
    const world = engineOver('sess-wired')
    const { $ } = world
    const pass = (e: unknown) => e
    const end = () => on.only('session.end')($, {}, pass)
    let turn = 0
    const nextInstance = () => on.only('turn.start')($, { turnId: `turn-${(turn += 1)}`, text: '' }, pass)
    const rename = (args: string) => on.command('rename')($, { command: 'rename', args }, async () => ({ ref: 1 }))
    /** `/clear` as the engine runs it: the session ends and the process goes on under a new id, all inside `next`. */
    const clear = (args: string, nextId: string) =>
      on.command('clear')($, { command: 'clear', args }, async () => {
        await end()
        world.sessionId = nextId
        return { text: '', ref: 2 }
      })
    const pollsFrom = async (seen: number) => {
      await world.tick(3)
      expect(world.polls.length).toBeGreaterThan(seen)
      return world.polls.slice(seen)
    }

    // Unnamed: the row reads as it always did.
    await on.only('session.start')($, { isInteractive: true }, async () => ({ cwd: '/home/me/src/ai-collab' }))
    expect((await pollsFrom(0)).every((poll) => poll.session === 'sess-wired' && poll.label === '')).toBe(true)

    await rename('Fix login redirect')
    await world.tick(3)
    expect(world.polls.at(-1)).toEqual({ session: 'sess-wired', label: 'Fix login redirect' })

    await rename('Docs pass')
    await world.tick(3)
    expect(world.polls.at(-1)).toEqual({ session: 'sess-wired', label: 'Docs pass' })

    // A poll speaks for its own session, wherever the process's id has gone.
    world.sessionId = 'sess-elsewhere'
    await world.tick(3)
    expect(world.polls.at(-1)).toEqual({ session: 'sess-wired', label: 'Docs pass' })
    world.sessionId = 'sess-wired'

    // A resume is another process: the name is the store's, set past the hooks here
    // so this can only pass by reading it, and it shows on the first poll.
    await end()
    const named = readSessionNames(world.store.get(STORE_INBOX_SESSION_NAMES))
    await $.store.set(STORE_INBOX_SESSION_NAMES, { ...named, 'sess-wired': { name: 'Kept in the store', at: 1 } })
    let seen = world.polls.length
    await nextInstance()
    expect((await pollsFrom(seen)).every((poll) => poll.label === 'Kept in the store')).toBe(true)

    // /clear: the engine writes the name onto the new session id, so the new id shows it.
    await clear('', 'sess-cleared')
    seen = world.polls.length
    await nextInstance()
    expect((await pollsFrom(seen)).every((poll) => poll.session === 'sess-cleared' && poll.label === 'Kept in the store')).toBe(true)

    // /clear <name>: the session it left has that name, the new one none.
    await clear('Finished', 'sess-fresh')
    seen = world.polls.length
    await nextInstance()
    expect((await pollsFrom(seen)).every((poll) => poll.session === 'sess-fresh' && poll.label === '')).toBe(true)

    // Back to the session /clear named, in this process, then to one never named.
    await end()
    world.sessionId = 'sess-cleared'
    seen = world.polls.length
    await nextInstance()
    expect((await pollsFrom(seen)).every((poll) => poll.session === 'sess-cleared' && poll.label === 'Finished')).toBe(true)

    await end()
    world.sessionId = 'sess-never-named'
    seen = world.polls.length
    await nextInstance()
    expect((await pollsFrom(seen)).every((poll) => poll.session === 'sess-never-named' && poll.label === '')).toBe(true)

    await end()
  })
})
