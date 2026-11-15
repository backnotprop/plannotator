import { describe, expect, test } from 'bun:test'
import { inboxRegistryPathOf, readReminderSessions, STORE_INBOX_REMINDER_SESSIONS } from './inbox'
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_LAUNCHED_LINE, inboxReminderFor, inboxWakeText, type InboxReplyCommand } from './inbox-contract'
import type { register } from './register'

// A session the Inbox launched (`claude --bg`) gets the Inbox reminder on its first turn (approval
// "inbox-launched-agent-note"). That turn is the Inbox's wake, a prompt this plugin submits, and Claude Code
// never raises the plugin's own `prompt.submit` for it, so the typed-first-prompt path never runs: the wake
// carries the reminder in its own words. Through the real hooks, instance and link on an in-memory `$`.
// The failures this catches: a launched session's first turn without the reminder; the reminder on a wake
// the Inbox did not mark launched; the reminder twice (the wake, then the person's first typed prompt);
// the reminder with `inboxReminder` off.

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })
const TOOL = 'mcp__plugin_plannotator__plannotator_inbox'
const SESSION = 'sess-launched'

const ROOT: InboxReplyCommand = {
  type: 'message',
  id: 'msg_01JZROOT0000000000000000',
  thread_id: 'msg_01JZROOT0000000000000000',
  reply_to: null,
  subject: 'Fix the flaky upload test',
  body: 'The upload test fails one run in five. Find out why.',
  url: 'http://127.0.0.1:4100/#thread=msg_01JZROOT0000000000000000',
  new_thread: true,
}
const LAUNCHED_ROOT: InboxReplyCommand = { ...ROOT, launched: { agent: 'claude-code', project: true } }

type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown

/** What session.start decided is one answer per module, so each test gets its own copy of it. */
async function freshHooks(name: string) {
  const { register: registerOn } = (await import(`./register?launched-${name}`)) as { register: typeof register }
  const held = new Map<string, Hook[]>()
  registerOn((event: string, ...args: unknown[]) => void held.set(event, [...(held.get(event) ?? []), args.at(-1) as Hook]))
  return (event: string) => held.get(event)![0]!
}

const realSleep = (ms: number, options?: { signal?: AbortSignal }) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    options?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

/** The `$` the module runs on, in memory, with an Inbox whose poll hands out `command` until it is delivered. */
function engineOver(command: InboxReplyCommand, config?: Record<string, unknown>) {
  const files = new Map<string, string>([
    ['/bin/sh', ''],
    [inboxRegistryPathOf(DATA), REGISTRY],
    ...(config ? ([[`${DATA}/config.json`, JSON.stringify(config)]] as [string, string][]) : []),
  ])
  const store = new Map<string, unknown>()
  const timers = new Set<{ ms: number; fn: () => void; due: number }>()
  const submits: string[] = []
  let waiting = true
  let clock = 1_000_000
  const world = {
    submits,
    store,
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
        id: async () => SESSION,
        cwd: async () => '/home/me/src/app',
        root: async () => '/home/me/src/app',
        messages: async () => [],
        version: async () => ({ version: '2.1.316', base: '2.1.316' }),
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
      // The claim's mkdir and every other process: won.
      process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      http: {
        fetch: async (url: string, init: { body?: string }) => {
          const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
          if (url.endsWith(INBOX_BRIDGE_EVENT_PATH) && body.type === 'delivered') waiting = false
          const commands = url.endsWith(INBOX_BRIDGE_POLL_PATH) && waiting ? [command] : []
          return { status: 200, ok: true, text: JSON.stringify({ commands }) }
        },
      },
      tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
      command: { list: async () => [], register: async () => undefined },
      ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
      prompt: {
        submit: async ({ text }: { text: string }) => void submits.push(text),
        suggest: async () => undefined,
        read: async () => ({ text: '' }),
      },
      turn: { abort: async () => undefined },
    },
  }
  return world
}

/** The context the person's first typed prompt goes in with. */
async function typedPromptContext(hook: Hook, $: unknown): Promise<unknown[]> {
  let entered: { context?: unknown[] } = {}
  await hook($, { text: 'How is it going?', origin: { kind: 'composer' } }, (e) => {
    entered = e as { context?: unknown[] }
    return { text: 'How is it going?' }
  })
  return entered.context ?? []
}

async function start(name: string, command: InboxReplyCommand, config?: Record<string, unknown>) {
  const on = await freshHooks(name)
  const world = engineOver(command, config)
  await on('session.start')(world.$, { isInteractive: true }, async () => ({ cwd: '/home/me/src/app' }))
  await world.tick(6)
  expect(world.submits).toHaveLength(1)
  return { on, world, wake: world.submits[0]! }
}

describe("a launched session's first turn", () => {
  test('the launched wake carries the reminder after its own words, once: the typed prompt after it carries none', async () => {
    const { on, world, wake } = await start('carries', LAUNCHED_ROOT)
    const reminder = inboxReminderFor(null, TOOL)
    expect(wake).toBe(`${inboxWakeText(LAUNCHED_ROOT)}\n\n${reminder}`)
    expect(wake).toContain(INBOX_LAUNCHED_LINE)
    // Recorded as this conversation's first prompt's reminder, for a resume in another process too.
    expect(Object.keys(readReminderSessions(world.store.get(STORE_INBOX_REMINDER_SESSIONS)))).toEqual([SESSION])
    expect(await typedPromptContext(on('prompt.submit'), world.$)).not.toContain(reminder)
  })

  test('a wake the Inbox did not mark launched carries none; the typed first prompt still does', async () => {
    const { on, world, wake } = await start('plain', ROOT)
    const reminder = inboxReminderFor(null, TOOL)
    expect(wake).toBe(inboxWakeText(ROOT))
    expect(await typedPromptContext(on('prompt.submit'), world.$)).toContain(reminder)
  })

  test('with inboxReminder off, the launched wake carries no reminder', async () => {
    const { wake } = await start('off', LAUNCHED_ROOT, { inboxReminder: false })
    expect(wake).toBe(inboxWakeText(LAUNCHED_ROOT))
  })

  test("the person's own reminder text (prompts.inbox) is the one the launched wake carries", async () => {
    const custom = 'Use the Plannotator Inbox for anything I should see; I am not watching this terminal.'
    const { wake } = await start('custom', LAUNCHED_ROOT, { prompts: { inbox: { reminder: custom } } })
    expect(wake).toBe(`${inboxWakeText(LAUNCHED_ROOT)}\n\n${inboxReminderFor(custom, TOOL)}`)
  })
})
