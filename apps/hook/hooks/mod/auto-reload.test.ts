import { describe, expect, test } from 'bun:test'
import {
  AUTO_RELOAD_ARGS,
  AUTO_RELOAD_CHECK_IN_MS,
  AUTO_RELOAD_COMMAND,
  AUTO_RELOAD_MAX_REFUSALS,
  AutoReload,
  hidesReloadOutput,
  readAutoReloads,
  STORE_AUTO_RELOAD,
  type AutoReloadDeps,
} from './auto-reload'
import { PlannotatorMod } from './controller'
import type { LoadedPluginInfo } from './host'
import { inboxRegistryPathOf } from './inbox'
import { INBOX_AUTO_RELOAD_POLL_FIELD, INBOX_RELOAD_FIELD } from './inbox-contract'
import { register } from './register'
import { fakeHost, type FakeHost } from './testing/fake-host'

// Plannotator reloads itself after an update (owner approval "cc-auto-reload"
// and its addendum: one visible echo line is fine; nothing may break, loops and
// agents keep running). The failures these catch: a reload while a turn, a
// subagent or Plannotator work runs; a reload over text the person typed; a
// second reload for the same version (a reload that loaded nothing new must not
// loop); a refused run retried without the person's input, or forever; the old
// module not saying the reload did not take; the new module not checking in;
// the poll not asking or the Inbox's word not reaching the reload; and the
// render hook hiding anything but our own run's plain success.

const SESSION = 'sess-1'

function deps(overrides: Partial<AutoReloadDeps> = {}) {
  const store = new Map<string, unknown>()
  const timers: { at: number; fn: () => void }[] = []
  const state = {
    clock: 1_000_000,
    busy: null as string | null,
    box: '',
    runs: 0,
    runError: null as Error | null,
    loaded: { version: '0.28.50', root: '/plugins/cache/plannotator/0.28.50', loaded_at: 999_000 } as LoadedPluginInfo,
  }
  const d: AutoReloadDeps = {
    sessionId: SESSION,
    now: async () => state.clock,
    storeGet: async (key) => store.get(key),
    storeSet: async (key, value) => {
      store.set(key, JSON.parse(JSON.stringify(value)))
    },
    loaded: async () => state.loaded,
    promptText: async () => state.box,
    busyReason: () => state.busy,
    run: async () => {
      state.runs += 1
      if (state.runError) throw state.runError
    },
    after: (ms, fn) => timers.push({ at: state.clock + ms, fn }),
    debug: () => undefined,
    ...overrides,
  }
  const elapse = async (ms: number) => {
    state.clock += ms
    for (const timer of timers.filter((t) => t.at <= state.clock)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.fn()
    }
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
  }
  const record = () => readAutoReloads(store.get(STORE_AUTO_RELOAD))[SESSION] ?? null
  return { d, state, store, elapse, record }
}

describe('when Plannotator reloads itself', () => {
  test('only when the Inbox says a reload loads a newer version', async () => {
    const { d, state } = deps()
    const reload = new AutoReload(d)
    await reload.tick()
    reload.setOffer(null)
    await reload.tick()
    reload.setOffer({ installed: null })
    await reload.tick()
    expect(state.runs).toBe(0)
    reload.setOffer({ installed: '0.28.51' })
    await reload.tick()
    expect(state.runs).toBe(1)
  })

  test('never while a turn, a subagent or Plannotator work runs: it waits for the next idle moment', async () => {
    const { d, state } = deps()
    const reload = new AutoReload(d)
    reload.setOffer({ installed: '0.28.51' })
    for (const reason of ['a turn runs', 'a subagent runs', 'a Plannotator review is open', 'Inbox work is in flight']) {
      state.busy = reason
      await reload.tick()
    }
    expect(state.runs).toBe(0)
    state.busy = null
    await reload.tick()
    expect(state.runs).toBe(1)
  })

  test('a turn that starts while the prompt box is read stops the run', async () => {
    const { d, state } = deps()
    const reload = new AutoReload({
      ...d,
      promptText: async () => {
        state.busy = 'a turn runs'
        return ''
      },
    })
    reload.setOffer({ installed: '0.28.51' })
    await reload.tick()
    expect(state.runs).toBe(0)
  })

  test('never over text in the prompt box (whitespace alone counts as empty); it runs once the box is cleared', async () => {
    const { d, state } = deps()
    const reload = new AutoReload(d)
    reload.setOffer({ installed: '0.28.51' })
    state.box = 'half a thought'
    await reload.tick()
    state.box = '\n'
    expect(state.runs).toBe(0)
    await reload.tick()
    expect(state.runs).toBe(1)
  })

  test('a box the host cannot read is never taken for empty', async () => {
    const { d, state } = deps()
    const reload = new AutoReload({ ...d, promptText: async () => Promise.reject(new Error('no box')) })
    reload.setOffer({ installed: '0.28.51' })
    await reload.tick()
    expect(state.runs).toBe(0)
  })

  test('once per version: a reload that loaded nothing new is not tried again, and says so', async () => {
    const { d, state, elapse, record } = deps()
    const reload = new AutoReload(d)
    reload.setOffer({ installed: '0.28.51' })
    await reload.tick()
    expect(record()?.outcome).toBe('pending')
    // The old module is still here: the reload did not replace it.
    await elapse(AUTO_RELOAD_CHECK_IN_MS)
    expect(record()?.outcome).toBe('did_not_take')
    for (let i = 0; i < 5; i += 1) {
      reload.setOffer({ installed: '0.28.51' })
      await elapse(1_000)
      await reload.tick()
    }
    expect(state.runs).toBe(1)
    // A later release is a new version: one more try.
    reload.setOffer({ installed: '0.28.52' })
    await reload.tick()
    expect(state.runs).toBe(2)
  })

  test('the record outlives the module: a fresh module for the same session does not run again for that version', async () => {
    const { d, state } = deps()
    const first = new AutoReload(d)
    first.setOffer({ installed: '0.28.51' })
    await first.tick()
    const second = new AutoReload(d)
    second.setOffer({ installed: '0.28.51' })
    await second.tick()
    expect(state.runs).toBe(1)
  })

  test('each session tries its own reload', async () => {
    const a = deps()
    const reloadA = new AutoReload(a.d)
    reloadA.setOffer({ installed: '0.28.51' })
    await reloadA.tick()
    const reloadB = new AutoReload({ ...a.d, sessionId: 'sess-2' })
    reloadB.setOffer({ installed: '0.28.51' })
    await reloadB.tick()
    expect(a.state.runs).toBe(2)
    expect(Object.keys(readAutoReloads(a.store.get(STORE_AUTO_RELOAD))).sort()).toEqual([SESSION, 'sess-2'])
  })

  test('a refused run waits for the person: tried again only after a turn starts, and at most a few times', async () => {
    const { d, state, record } = deps()
    state.runError = new Error('the session was stopped and nobody has sent input since')
    const reload = new AutoReload(d)
    reload.setOffer({ installed: '0.28.51' })
    await reload.tick()
    await reload.tick()
    await reload.tick()
    expect(state.runs).toBe(1)
    expect(record()).toMatchObject({ outcome: 'refused', refusals: 1 })
    for (let i = 0; i < AUTO_RELOAD_MAX_REFUSALS + 3; i += 1) {
      reload.onInputMoved()
      await reload.tick()
    }
    expect(state.runs).toBe(AUTO_RELOAD_MAX_REFUSALS)
  })

  test('nothing runs without a way to read the box or run the command', async () => {
    const { d, state } = deps()
    for (const reload of [new AutoReload({ ...d, promptText: undefined }), new AutoReload({ ...d, run: undefined })]) {
      reload.setOffer({ installed: '0.28.51' })
      await reload.tick()
    }
    expect(state.runs).toBe(0)
  })
})

describe('after the reload', () => {
  test('the new module checks in, then notes its tools and its first Inbox poll', async () => {
    const { d, state, elapse, record } = deps()
    const old = new AutoReload(d)
    old.setOffer({ installed: '0.28.51' })
    await old.tick()
    const ranAt = state.clock
    // The reload replaces the module (its timer goes with it) and the new one loads.
    old.dispose()
    await elapse(500)
    state.loaded = { version: '0.28.51', root: '/plugins/cache/plannotator/0.28.51', loaded_at: state.clock }
    const fresh = new AutoReload(d)
    expect(await fresh.checkIn()).not.toBeNull()
    await fresh.noteTools(true)
    await fresh.notePolled()
    expect(record()).toMatchObject({ outcome: 'checked_in', version: '0.28.51', tools: true, inbox: true, checkedIn: { version: '0.28.51', loadedAt: ranAt + 500 } })
    // The disposed old module's window passing changes nothing.
    await elapse(AUTO_RELOAD_CHECK_IN_MS)
    expect(record()?.outcome).toBe('checked_in')
    // The Inbox still saying "outdated" for that version (a judgment the reload cannot change) runs nothing again.
    fresh.setOffer({ installed: '0.28.51' })
    await fresh.tick()
    expect(state.runs).toBe(1)
  })

  test('a module loaded before the run, or long after it, does not check in', async () => {
    const { d, state, record } = deps()
    const old = new AutoReload(d)
    old.setOffer({ installed: '0.28.51' })
    await old.tick()
    expect(await new AutoReload(d).checkIn()).toBeNull()
    state.clock += 3 * AUTO_RELOAD_CHECK_IN_MS
    state.loaded = { ...state.loaded, loaded_at: state.clock }
    expect(await new AutoReload(d).checkIn()).toBeNull()
    expect(record()?.outcome).toBe('pending')
  })

  test('tools and polls are noted only on a module that checked in', async () => {
    const { d, record } = deps()
    const reload = new AutoReload(d)
    await reload.noteTools(false)
    await reload.notePolled()
    expect(record()).toBeNull()
  })
})

describe('what the chat shows of the run', () => {
  const ours = { command: AUTO_RELOAD_COMMAND, args: AUTO_RELOAD_ARGS, isErrored: false }

  test("our own run's plain success is hidden", () => {
    expect(hidesReloadOutput({ ...ours, text: 'Reloaded: 3 plugins · 12 skills · 6 agents · 4 hooks · 0 plugin MCP servers · 0 plugin LSP servers' })).toBe(true)
  })

  test('a reload the person typed, a warning or an error stays in view', () => {
    const plain = 'Reloaded: 3 plugins · 12 skills · 6 agents · 4 hooks · 0 plugin MCP servers · 0 plugin LSP servers'
    expect(hidesReloadOutput({ ...ours, args: '', text: plain })).toBe(false)
    expect(hidesReloadOutput({ ...ours, args: '--force', text: plain })).toBe(false)
    expect(hidesReloadOutput({ ...ours, command: 'reload-skills', text: plain })).toBe(false)
    expect(hidesReloadOutput({ ...ours, isErrored: true, text: plain })).toBe(false)
    expect(hidesReloadOutput({ ...ours, text: `${plain}\n2 errors during load. Run /plugin for details.` })).toBe(false)
    expect(hidesReloadOutput({ ...ours, text: `${plain} · 1 plugin installed but not applied` })).toBe(false)
    expect(
      hidesReloadOutput({ ...ours, text: 'This reload changes MCP tools (x) — your next message will re-read the whole conversation instead of using the cache. Run /reload-plugins --force to apply.' }),
    ).toBe(false)
    expect(hidesReloadOutput({ ...ours, text: `${plain} The marketplace could not be reached, so its plugins were not loaded.` })).toBe(false)
  })

  test('the module draws our success row as nothing and passes every other row on', async () => {
    const held: { event: string; matcher: unknown; run: (...args: unknown[]) => unknown }[] = []
    register((event: string, ...args: unknown[]) => {
      held.push({ event, matcher: args.length > 1 ? args[0] : undefined, run: args.at(-1) as (...a: unknown[]) => unknown })
    })
    const hook = held.find((h) => h.event === 'ui.render')!
    expect(hook.matcher).toEqual({ component: 'CommandOutput', props: { command: AUTO_RELOAD_COMMAND } })
    const passed = { passed: true }
    const next = () => passed
    const row = (props: Record<string, unknown>) => ({ component: 'CommandOutput', props: { ...ours, ...props } })
    expect(hook.run({}, row({ text: 'Reloaded: 1 plugin' }), next)).toEqual({ type: 'Box' })
    expect(hook.run({}, row({ args: '', text: 'Reloaded: 1 plugin' }), next)).toBe(passed)
    expect(hook.run({}, row({ text: 'Reloaded: 1 plugin\n1 error during load.' }), next)).toBe(passed)
  })
})

// --- Through the mod: the Inbox link's poll and the controller's gates --------------------------------

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })
const TOOLS = [{ name: 'send_message', description: 'Send.', inputSchema: { type: 'object' } }]

function modOver(host: FakeHost, options: { offer: string | null; box?: () => string }) {
  host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
  const polls: Record<string, unknown>[] = []
  const reloads: string[] = []
  host.onFetch = (url, body) => {
    if (url.endsWith('/api/inbox/bridge/poll')) polls.push(body as Record<string, unknown>)
    return { status: 200, ok: true, text: JSON.stringify({ commands: [], ...(options.offer ? { [INBOX_RELOAD_FIELD]: { installed: options.offer } } : {}) }) }
  }
  host.loadedPlugin = async () => ({ version: '0.28.50', root: '/plugins/cache/plannotator/0.28.50', loaded_at: 1 })
  host.readPrompt = async () => options.box?.() ?? ''
  host.runReload = async () => {
    reloads.push(`/${AUTO_RELOAD_COMMAND} ${AUTO_RELOAD_ARGS}`)
  }
  const mod = new PlannotatorMod(host, { sessionId: SESSION, dataDir: DATA, interactive: true, inboxTools: TOOLS })
  return { mod, polls, reloads }
}

async function ticks(host: FakeHost, n: number) {
  for (let i = 0; i < n; i += 1) {
    host.clock += 1_000
    await host.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('through the mod', () => {
  test('the poll says the connection reloads itself, and the Inbox word leads to one run at idle', async () => {
    const host = fakeHost()
    const { mod, polls, reloads } = modOver(host, { offer: '0.28.51' })
    await ticks(host, 4)
    expect(polls.length).toBeGreaterThan(0)
    expect(polls.every((poll) => poll[INBOX_AUTO_RELOAD_POLL_FIELD] === true)).toBe(true)
    expect(reloads).toEqual(['/reload-plugins plannotator'])
    await ticks(host, 10)
    expect(reloads).toHaveLength(1)
    mod.dispose()
  })

  test('no word from the Inbox, no run', async () => {
    const host = fakeHost()
    const { mod, reloads } = modOver(host, { offer: null })
    await ticks(host, 6)
    expect(reloads).toHaveLength(0)
    mod.dispose()
  })

  test('a main-loop turn holds the run until it ends; so does a subagent that is still running', async () => {
    const host = fakeHost()
    const { mod, reloads } = modOver(host, { offer: '0.28.51' })
    await mod.onTurnStart('turn-1', 'work', undefined)
    await mod.onTurnStart('agent-turn', 'research', 'agent-7')
    await ticks(host, 5)
    expect(reloads).toHaveLength(0)
    mod.onTurnComplete('turn-1', 'done', false)
    await ticks(host, 5)
    // The main loop is idle, but the subagent still runs.
    expect(reloads).toHaveLength(0)
    mod.onAgentTurnComplete('agent-7', 'agent-turn')
    await ticks(host, 3)
    expect(reloads).toHaveLength(1)
    mod.dispose()
  })

  test('text in the prompt box holds the run until it is cleared', async () => {
    const host = fakeHost()
    let box = 'draft'
    const { mod, reloads } = modOver(host, { offer: '0.28.51', box: () => box })
    await ticks(host, 5)
    expect(reloads).toHaveLength(0)
    box = ''
    await ticks(host, 3)
    expect(reloads).toHaveLength(1)
    mod.dispose()
  })
})
