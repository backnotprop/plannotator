import { describe, expect, test } from 'bun:test'
import { InboxLink, inboxRegistryPathOf, inboxSessionTitleOf } from './inbox'
import { register } from './register'
import { fakeHost } from './testing/fake-host'

// Session labels (approval "inbox-session-label"): the To picker's name for a
// Claude Code session is its `session_title`, which only the classic
// SessionStart and UserPromptSubmit inputs carry. The failures this catches:
// reading it from `session.start` or `prompt.submit`, which never have it (the
// label would silently never show); dropping the wiring from the hook through
// `currentMod` and `PlannotatorMod` to the link, which no fake `label` can see;
// a poll that stops carrying it, or carries another session's after `/clear`; a
// subagent's event renaming the session; a poll that does not know the title
// blanking a labelled row, or a reload doing the same until the next prompt.
//
// What a guard does to these hooks needs the engine: apps/hook/tests/register.test.ts.

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })

async function ticks(host: ReturnType<typeof fakeHost>, n: number) {
  for (let i = 0; i < n; i += 1) {
    host.clock += 1_000
    await host.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function linkOver(host: ReturnType<typeof fakeHost>, label?: () => string | null | Promise<string | null>) {
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

/** The module's hooks as the engine holds them: `event` to its function, the matcher dropped. */
function hooks(): Map<string, Hook[]> {
  const out = new Map<string, Hook[]>()
  register((event: string, ...args: unknown[]) => {
    out.set(event, [...(out.get(event) ?? []), args.at(-1) as Hook])
  })
  return out
}

/** `$.state` as the host keeps it: by plugin, key and member id, outliving any module variable. */
function stateOf() {
  const values = new Map<string, unknown>()
  const name = (ref: { plugin: string; key: string; id?: string }) => `${ref.plugin}/${ref.key}/${ref.id ?? ''}`
  return {
    title: (session: string) => values.get(name({ plugin: 'plannotator', key: 'sessionTitle', id: session })),
    state: {
      get: async (ref: { plugin: string; key: string; id?: string }) => ({ value: values.get(name(ref)), version: 0 }),
      set: async (ref: { plugin: string; key: string; id?: string }, value: unknown) => {
        values.set(name(ref), value)
        return { isSet: true, version: 1 }
      },
    },
  }
}

describe('inboxSessionTitleOf', () => {
  test('the title, and an empty one as empty: it clears', () => {
    expect(inboxSessionTitleOf({ session_title: 'Fix login redirect' })).toBe('Fix login redirect')
    expect(inboxSessionTitleOf({ session_title: '' })).toBe('')
  })

  test('says nothing for an engine without the field, or for a subagent', () => {
    expect(inboxSessionTitleOf({})).toBeNull()
    expect(inboxSessionTitleOf({ session_title: 7 })).toBeNull()
    expect(inboxSessionTitleOf({ session_title: 'A subagent', agent_id: 'agent-1' })).toBeNull()
  })
})

describe('the hooks', () => {
  test('the classic events are read and the rest of the chain runs as it did', async () => {
    const on = hooks()
    const kept = stateOf()
    for (const [event, title] of [
      ['classic.SessionStart', 'From the start'],
      ['classic.UserPromptSubmit', 'From a prompt'],
    ] as const) {
      expect(on.get(event)).toHaveLength(1)
      const input = { session_id: 'sess-hooks', session_title: title }
      const answer = await on.get(event)![0]!({ state: kept.state }, input, (e) => ({ passed: e }))
      expect(answer).toEqual({ passed: input })
      expect(kept.title('sess-hooks')).toBe(title)
    }
  })

  test("a call that says nothing keeps the title; each session's is its own", async () => {
    const on = hooks()
    const kept = stateOf()
    const $ = { state: kept.state }
    const start = on.get('classic.SessionStart')![0]!
    const prompt = on.get('classic.UserPromptSubmit')![0]!
    await start($, { session_id: 'sess-keep', session_title: 'Kept' }, () => ({}))
    await prompt($, { session_id: 'sess-keep' }, () => ({}))
    expect(kept.title('sess-keep')).toBe('Kept')
    await prompt($, { session_id: 'sess-keep', agent_id: 'a', session_title: 'A subagent' }, () => ({}))
    expect(kept.title('sess-keep')).toBe('Kept')
    // /clear: a new id, and no title carried over; another session's event leaves this one's alone.
    await start($, { session_id: 'sess-after-clear' }, () => ({}))
    expect(kept.title('sess-after-clear')).toBeUndefined()
    await start($, { session_id: 'sess-other', session_title: 'Other' }, () => ({}))
    expect(kept.title('sess-keep')).toBe('Kept')
    await prompt($, { session_id: 'sess-keep', session_title: '' }, () => ({}))
    expect(kept.title('sess-keep')).toBe('')
  })

  test('an engine with no $.state still runs the chain: a label never fails a prompt', async () => {
    const on = hooks()
    const input = { session_id: 'sess-old', session_title: 'Title' }
    expect(await on.get('classic.UserPromptSubmit')![0]!({}, input, (e) => ({ passed: e }))).toEqual({ passed: input })
  })
})

describe('the poll', () => {
  test('carries the title on every poll, so a later hook call updates what the Inbox shows', async () => {
    const host = fakeHost()
    let title = ''
    const { link, polls } = linkOver(host, () => title)
    link.start()
    await ticks(host, 2)
    expect(polls.length).toBeGreaterThan(0)
    expect(polls.every((poll) => poll.label === '')).toBe(true)

    title = 'Fix login redirect'
    await ticks(host, 2)
    expect(polls.at(-1)!.label).toBe('Fix login redirect')

    title = ''
    await ticks(host, 2)
    expect(polls.at(-1)!.label).toBe('')
    link.dispose()
  })

  test.each([
    ['answers null', (): null => null],
    ['rejects', (): Promise<string> => Promise.reject(new Error('the state is gone'))],
    ['throws', (): string => { throw new Error('the state is gone') }],
  ] as const)('a source that %s cannot tell: the last word stands, and "" still clears', async (_how, cannotTell) => {
    const host = fakeHost()
    let read: () => string | null | Promise<string> = () => 'Fix login redirect'
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

  test('a link with no title source sends no field', async () => {
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
  const kept = stateOf()
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
    tick: async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        clock += 1_000
        for (const fn of [...timers]) fn()
        for (let spin = 0; spin < 500; spin += 1) await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    $: {
      state: kept.state,
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
        sleep: async () => undefined,
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

describe('from a classic event to a poll body', () => {
  test('through the real hooks, instance and link: a title, a later title, a new instance, and /clear', async () => {
    const on = hooks()
    const world = engineOver('sess-wired')
    const { $ } = world
    const prompt = on.get('classic.UserPromptSubmit')![0]!
    const pass = (e: unknown) => e
    const instanceNow = (id: string) => on.get('turn.start')![0]!($, { turnId: `turn-${id}`, text: '' }, pass)

    // Before session.start finished: the engine may raise a session's first events that early.
    await on.get('classic.SessionStart')![0]!($, { session_id: 'sess-wired', session_title: 'From the start' }, pass)
    await on.get('session.start')![0]!($, { isInteractive: true }, async () => ({ cwd: '/home/me/src/ai-collab' }))
    await world.tick(3)
    expect(world.polls.at(-1)).toEqual({ session: 'sess-wired', label: 'From the start' })

    await prompt($, { session_id: 'sess-wired', session_title: 'Fix login redirect' }, pass)
    await world.tick(3)
    expect(world.polls.at(-1)).toEqual({ session: 'sess-wired', label: 'Fix login redirect' })

    // A reload: module variables are gone and the host's state is not, so the host's
    // copy is set here, past the hooks. The new instance's first poll has to say it.
    await on.get('session.end')![0]!($, {}, pass)
    await $.state.set({ plugin: 'plannotator', key: 'sessionTitle', id: 'sess-wired' }, 'Kept by the host')
    const before = world.polls.length
    await instanceNow('again')
    await world.tick(3)
    expect(world.polls.length).toBeGreaterThan(before)
    expect(world.polls.slice(before).every((poll) => poll.label === 'Kept by the host')).toBe(true)

    // /clear: another session id, and the old title is not this session's.
    await on.get('session.end')![0]!($, {}, pass)
    world.sessionId = 'sess-cleared'
    const cleared = world.polls.length
    await instanceNow('cleared')
    await world.tick(3)
    expect(world.polls.length).toBeGreaterThan(cleared)
    expect(world.polls.slice(cleared).every((poll) => poll.session === 'sess-cleared' && poll.label === '')).toBe(true)

    await on.get('session.end')![0]!($, {}, pass)
  })
})
