/**
 * The mod's pull-bridge client against the real server half
 * (packages/ai/session-bridge-pull.ts), with `$.http.fetch` answered by the
 * server's own request handler.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createPullSessionBridge, type PullSessionBridge } from '../../../../packages/ai/session-bridge-pull.ts'
import { createBridge, TAKEN_OVER_INTERRUPT_TEXT, takenOverFallback } from './bridge'
import { fakeHost, type FakeHost } from './testing/fake-host'
import { TAKEN_OVER_BY_PERSON_TEXT, TurnTracker } from './turns'

const TOKEN = 'k'.repeat(64)
let server: PullSessionBridge | null = null
let live = true

afterEach(() => {
  live = false
  server?.dispose()
  server = null
})

function wire(host: FakeHost, bridge: PullSessionBridge, options: { olderServer?: boolean } = {}) {
  host.onFetch = async (url, body) => {
    const response = await bridge.handle(
      new Request(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    if (!response) return { status: 404, ok: false, text: '' }
    let text = await response.text()
    if (options.olderServer && url.endsWith('/poll')) {
      // A server from before the `features` advert.
      const { features: _features, ...rest } = JSON.parse(text)
      text = JSON.stringify(rest)
    }
    return { status: response.status, ok: response.ok, text }
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
  const seen = { deltas: '', done: null as string | null, error: null as string | null, message: null as string | null }
  return {
    seen,
    sink: {
      delta: (text: string) => {
        seen.deltas += text
      },
      done: (answer: string) => {
        seen.done = answer
      },
      error: (code: string, message?: string) => {
        seen.error = code
        seen.message = message ?? null
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

  // The failure this guards: the person typed into the question's turn, and
  // the reply to their prompt streamed into Plannotator as the answer, and
  // "Interrupt and ask now" then aborted the person's own work.
  test('a prompt typed into the question\'s turn settles it as taken over, and the turn is never interrupted', async () => {
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
    server.bridge.ask({ askId: 'ask-3', text: '[Plannotator Ask AI] Why step 2?', mode: 'turn' }, sink, controller.signal)
    await until(() => host.submits.length === 1)

    turns.onTurnStart('turn-3', 'The plannotator plugin sent a message:\n[Plannotator Ask AI] Why step 2?')
    turns.onStep('turn-3')
    turns.onText('turn-3', 'Because ')
    turns.onPromptEntered({ text: 'also fix the tests', fromUs: false, turnId: 'turn-3', originKind: 'composer' })
    turns.onStep('turn-3')
    turns.onText('turn-3', 'Fixed the tests.')

    await until(() => seen.error !== null)
    expect(seen.error).toBe('taken_over')
    expect(seen.message).toBe(TAKEN_OVER_BY_PERSON_TEXT)
    expect(seen.deltas).toBe('Because ')

    // A late Stop and "Interrupt and ask now" both leave the person's turn alone.
    controller.abort()
    await expect(server.bridge.interrupt!()).rejects.toThrow(TAKEN_OVER_INTERRUPT_TEXT)
    expect(host.aborted).toEqual([])

    live = false
    server.dispose()
    await running
  })

  // The failure this guards: a newer mod against an older CLI, whose server
  // reads `taken_over` as `failed` and whose UI then replaces the partial
  // answer with the error.
  test('against a server that does not advertise taken_over, a take-over settles as the partial answer plus the note', async () => {
    live = true
    server = createPullSessionBridge({ token: TOKEN, host: 'claude-code', modes: { turn: true, transient: false } })
    const host = fakeHost()
    wire(host, server, { olderServer: true })
    const turns = new TurnTracker()
    const client = createBridge({ host, baseUrl: 'http://127.0.0.1:4321', token: TOKEN, turns, isLive: () => live })
    const running = client.run()

    await until(() => server!.bridge.status() === 'ready')
    const { seen, sink } = collector()
    server.bridge.ask({ askId: 'ask-4', text: '[Plannotator Ask AI] Why step 2?', mode: 'turn' }, sink, new AbortController().signal)
    await until(() => host.submits.length === 1)
    turns.onTurnStart('turn-4', 'The plannotator plugin sent a message:\n[Plannotator Ask AI] Why step 2?')
    turns.onStep('turn-4')
    turns.onText('turn-4', 'Because ')
    turns.onPromptEntered({ text: 'also fix the tests', fromUs: false, turnId: 'turn-4', originKind: 'composer' })
    turns.onStep('turn-4')

    await until(() => seen.done !== null)
    expect(seen.error).toBeNull()
    expect(seen.done).toBe(takenOverFallback('Because ', TAKEN_OVER_BY_PERSON_TEXT).answer)
    expect(seen.deltas).toBe(seen.done)
    expect(seen.done).toContain(TAKEN_OVER_BY_PERSON_TEXT)

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
    expect(await client.run()).toMatchObject({ reason: 'refused', status: 401 })
    expect(host.submits).toEqual([])
  })
})

// The controller decides from these whether to start the loop again, so each
// way a loop ends has to say which it was.
describe('how a bridge loop ends', () => {
  const POLL = 'http://127.0.0.1:4321/api/ai/bridge/poll'

  function client(host: FakeHost, isLive = () => true) {
    return createBridge({ host, baseUrl: 'http://127.0.0.1:4321', token: TOKEN, turns: new TurnTracker(), isLive, maxFailures: 3 })
  }

  test('a server that stops answering ends it as failures, saying whether a poll got through first', async () => {
    const host = fakeHost()
    let polls = 0
    host.onFetch = (url) => {
      if (url !== POLL) return { status: 200, ok: true, text: '{}' }
      polls += 1
      // The first poll is answered; then the server goes silent ($.http.fetch gives up).
      if (polls === 1) return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
      throw new Error('The operation timed out.')
    }
    expect(await client(host).run()).toEqual({ reason: 'failures', connected: true })

    const never = fakeHost()
    never.onFetch = () => {
      throw new Error('connection refused')
    }
    expect(await client(never).run()).toEqual({ reason: 'failures', connected: false })
  })

  test('a CLI without the bridge (404) ends it as refused', async () => {
    const host = fakeHost()
    expect(await client(host).run()).toMatchObject({ reason: 'refused', status: 404 })
  })

  test('superseded: the next poll waits 10-15 s instead of taking the server back at once', async () => {
    const host = fakeHost()
    const pollTimes: number[] = []
    host.onFetch = (url) => {
      if (url !== POLL) return { status: 200, ok: true, text: '{}' }
      pollTimes.push(host.clock)
      // Superseded twice (another client polls this server), then the server closes.
      const body = pollTimes.length <= 2 ? { commands: [], superseded: true } : { commands: [], closing: true }
      return { status: 200, ok: true, text: JSON.stringify(body) }
    }
    expect(await client(host).run()).toEqual({ reason: 'closing', connected: true })
    expect(pollTimes).toHaveLength(3)
    for (const [index, time] of pollTimes.slice(1).entries()) {
      const gap = time - (pollTimes[index] as number)
      expect(gap).toBeGreaterThanOrEqual(10_000)
      expect(gap).toBeLessThanOrEqual(15_000)
    }
  })

  test('a review that is no longer live ends it as ended', async () => {
    const host = fakeHost()
    let live = true
    host.onFetch = () => {
      live = false
      return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
    }
    expect(await client(host, () => live).run()).toEqual({ reason: 'ended', connected: true })
  })
})
