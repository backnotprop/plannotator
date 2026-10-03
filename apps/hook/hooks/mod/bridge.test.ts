/**
 * The mod's pull-bridge client against the real server half
 * (packages/ai/session-bridge-pull.ts), with `$.http.fetch` answered by the
 * server's own request handler.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createPullSessionBridge, type PullSessionBridge } from '../../../../packages/ai/session-bridge-pull.ts'
import { createBridge } from './bridge'
import { fakeHost, type FakeHost } from './testing/fake-host'
import { TurnTracker } from './turns'

const TOKEN = 'k'.repeat(64)
let server: PullSessionBridge | null = null
let live = true

afterEach(() => {
  live = false
  server?.dispose()
  server = null
})

function wire(host: FakeHost, bridge: PullSessionBridge) {
  host.onFetch = async (url, body) => {
    const response = await bridge.handle(
      new Request(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    if (!response) return { status: 404, ok: false, text: '' }
    return { status: response.status, ok: response.ok, text: await response.text() }
  }
}

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function collector() {
  const seen = { deltas: '', done: null as string | null, error: null as string | null }
  return {
    seen,
    sink: {
      delta: (text: string) => {
        seen.deltas += text
      },
      done: (answer: string) => {
        seen.done = answer
      },
      error: (code: string) => {
        seen.error = code
      },
    },
  }
}

describe('Ask this session over the pull bridge', () => {
  test('a question runs as a turn and its answer goes back to Plannotator', async () => {
    live = true
    server = createPullSessionBridge({ token: TOKEN, host: 'claude-code', modes: { turn: true, transient: false } })
    const host = fakeHost()
    wire(host, server)
    const turns = new TurnTracker()
    const client = createBridge({ host, baseUrl: 'http://127.0.0.1:4321', token: TOKEN, turns, isLive: () => live })
    const running = client.run()

    await until(() => server!.bridge.status() === 'ready')
    const { seen, sink } = collector()
    server.bridge.ask({ askId: 'ask-1', text: '[Plannotator Ask AI] Why step 2?', mode: 'turn' }, sink, new AbortController().signal)

    await until(() => host.submits.length === 1)
    expect(host.submits[0]).toBe('[Plannotator Ask AI] Why step 2?')

    // Its turn starts, framed as Claude Code frames a plugin's prompt (seen live).
    turns.onTurnStart('turn-1', 'The plannotator plugin sent a message:\n[Plannotator Ask AI] Why step 2?\nThis is how Claude Code surfaces a prompt a plugin submits between turns.')
    turns.onText('turn-1', 'Because ')
    turns.onText('turn-1', 'it is needed.')
    turns.onTurnComplete('turn-1', 'Because it is needed.', false)
    client.pushStatus()

    await until(() => seen.done !== null)
    expect(seen.done).toBe('Because it is needed.')
    expect(seen.deltas).toBe('Because it is needed.')

    live = false
    server.dispose()
    await running
  })

  test('Claude mid-turn reads as busy, and an interrupt aborts the running turn', async () => {
    live = true
    server = createPullSessionBridge({ token: TOKEN, host: 'claude-code', modes: { turn: true, transient: false } })
    const host = fakeHost()
    wire(host, server)
    const turns = new TurnTracker()
    turns.onTurnStart('user-turn', 'refactor the parser')
    const client = createBridge({ host, baseUrl: 'http://127.0.0.1:4321', token: TOKEN, turns, isLive: () => live })
    const running = client.run()

    await until(() => server!.bridge.status() === 'busy')
    await server.bridge.interrupt?.()
    expect(host.aborted).toEqual(['user-turn'])

    live = false
    server.dispose()
    await running
  })

  test('a cancelled question that is still queued is confirmed and its turn aborted when it starts', async () => {
    live = true
    server = createPullSessionBridge({ token: TOKEN, host: 'claude-code', modes: { turn: true, transient: false } })
    const host = fakeHost()
    wire(host, server)
    const turns = new TurnTracker()
    const client = createBridge({ host, baseUrl: 'http://127.0.0.1:4321', token: TOKEN, turns, isLive: () => live })
    const running = client.run()

    await until(() => server!.bridge.status() === 'ready')
    const { seen, sink } = collector()
    const controller = new AbortController()
    server.bridge.ask({ askId: 'ask-2', text: '[Plannotator Ask AI] Q', mode: 'turn' }, sink, controller.signal)
    await until(() => host.submits.length === 1)
    controller.abort()

    await until(() => seen.error !== null)
    expect(turns.onTurnStart('late-turn', '[Plannotator Ask AI] Q')).toBe('late-turn')

    live = false
    server.dispose()
    await running
  })

  test('a wrong token stops the client instead of retrying forever', async () => {
    live = true
    server = createPullSessionBridge({ token: 'x'.repeat(64), host: 'claude-code', modes: { turn: true, transient: false } })
    const host = fakeHost()
    wire(host, server)
    const client = createBridge({ host, baseUrl: 'http://127.0.0.1:4321', token: TOKEN, turns: new TurnTracker(), isLive: () => live })
    await client.run()
    expect(host.submits).toEqual([])
  })
})
