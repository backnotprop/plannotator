/**
 * The mod reports what the session still runs in the background (background-tasks.ts): a Stop or SubagentStop
 * hook's `background_tasks` goes to the Inbox as a `tasks` bridge event at the next tick, again every
 * BACKGROUND_TASKS_RESEND_MS while anything runs (the Inbox forgets a list after 5 min), and once as `[]` when the
 * last one ends. The failures this catches: a list that never goes out, one the Inbox drops while the session waits
 * on its subagents (no resend), a stopping subagent still shown as running, and a strip that never clears.
 * A memory host, no Inbox.
 */
import { describe, expect, test } from 'bun:test'
import { BACKGROUND_TASKS_RESEND_MS, backgroundTasksOf } from './background-tasks'
import { InboxLink, inboxRegistryPathOf } from './inbox'
import { INBOX_BRIDGE_EVENT_PATH } from './inbox-contract'
import { register } from './register'
import { fakeHost } from './testing/fake-host'

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })

const agent = { id: 'a1', type: 'subagent', status: 'running', description: 'Port webhook handlers', agent_type: 'general-purpose' }
const shell = { id: 'b1', type: 'shell', status: 'running', description: 'Integration tests', command: 'bun test tests/integration' }

async function ticks(host: ReturnType<typeof fakeHost>, n: number, step = 1_000) {
  for (let i = 0; i < n; i += 1) {
    host.clock += step
    await host.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function world() {
  const host = fakeHost()
  host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
  const events: Record<string, unknown>[] = []
  host.onFetch = (url, body) => {
    const record = body as Record<string, unknown>
    if (url.endsWith(INBOX_BRIDGE_EVENT_PATH) && record.type === 'tasks') events.push(record)
    return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
  }
  const link = new InboxLink({ host, dataDir: DATA, sessionId: 'sess-1', tools: [], isBusy: () => false, instanceId: 'me' })
  return { host, link, events }
}

describe('backgroundTasksOf', () => {
  test('running and pending work, in the Inbox\'s words; a stopping subagent and ended work left out; no list keeps the last', () => {
    const seen = new Map<string, number>()
    const tasks = backgroundTasksOf([agent, shell, { id: 'c1', type: 'shell', status: 'completed', description: 'done' }, { type: 'shell' }], null, seen, 1_000)
    expect(tasks).toEqual([
      { id: 'a1', kind: 'agent', description: 'Port webhook handlers', agent_type: 'general-purpose', started_at: 1_000 },
      { id: 'b1', kind: 'shell', description: 'Integration tests', command: 'bun test tests/integration', started_at: 1_000 },
    ])
    // A later report keeps each task's first sighting; the subagent a SubagentStop is for is not running any more.
    expect(backgroundTasksOf([agent, shell], 'a1', seen, 9_000)).toEqual([{ id: 'b1', kind: 'shell', description: 'Integration tests', command: 'bun test tests/integration', started_at: 1_000 }])
    // An older Claude Code: no list, so nothing to say.
    expect(backgroundTasksOf(undefined, null, seen, 9_000)).toBeNull()
  })
})

describe('the tasks the mod reports', () => {
  test('a Stop\'s list goes at the next tick, again before the Inbox would forget it, and [] once when it ends', async () => {
    const { host, link, events } = world()
    link.start()
    await ticks(host, 2)
    expect(events).toEqual([])
    link.onBackgroundTasks([agent, shell], null)
    await ticks(host, 2)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ session: 'sess-1', type: 'tasks', tasks: [{ id: 'a1', kind: 'agent' }, { id: 'b1', kind: 'shell' }] })
    const firstAt = events[0]!.at as number
    // Within the resend interval nothing more; past it the same list again, with a newer `at`.
    await ticks(host, 3, BACKGROUND_TASKS_RESEND_MS / 4)
    expect(events).toHaveLength(1)
    await ticks(host, 2, BACKGROUND_TASKS_RESEND_MS / 2)
    expect(events).toHaveLength(2)
    expect(events[1]!.at as number).toBeGreaterThan(firstAt)
    expect((events[1]!.tasks as { started_at: number }[])[0]!.started_at).toBe((events[0]!.tasks as { started_at: number }[])[0]!.started_at)
    // The last task ends: [] once, then nothing.
    link.onBackgroundTasks([], null)
    await ticks(host, 2)
    expect(events.at(-1)!.tasks).toEqual([])
    const count = events.length
    await ticks(host, 3, BACKGROUND_TASKS_RESEND_MS)
    expect(events).toHaveLength(count)
    link.dispose()
  })

  test('a session that never ran background work sends nothing, and a hook without a list changes nothing', async () => {
    const { host, link, events } = world()
    link.start()
    link.onBackgroundTasks([], null)
    link.onBackgroundTasks(undefined, null)
    await ticks(host, 3)
    expect(events).toEqual([])
    link.dispose()
  })

  test('register hooks Stop and SubagentStop, and passes the event on unchanged', async () => {
    const hooks = new Map<string, (...args: unknown[]) => unknown>()
    register((event: string, ...args: unknown[]) => {
      if (event === 'classic.Stop' || event === 'classic.SubagentStop') hooks.set(event, args.at(-1) as (...args: unknown[]) => unknown)
    })
    expect([...hooks.keys()].sort()).toEqual(['classic.Stop', 'classic.SubagentStop'])
    const event = { hook_event_name: 'Stop', background_tasks: [agent] }
    for (const hook of hooks.values()) expect(await hook({}, event, (e: unknown) => e)).toBe(event)
  })
})
