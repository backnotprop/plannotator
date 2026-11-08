import { describe, expect, test } from 'bun:test'
import { InboxLink } from './inbox'
import { disposesOnSessionEnd, healAction, MOD_HEAL_EVERY_MS } from './self-heal'
import { fakeHost } from './testing/fake-host'

// Seen live: a session.end that was not this session's disposed the instance,
// and an idle session then got no Inbox reply until the person typed.
describe('disposesOnSessionEnd', () => {
  const current = { sessionId: 'session-1' }

  test("another session's end (a fork, a side session) keeps the instance", () => {
    expect(disposesOnSessionEnd(current, { sessionId: 'fork-1' })).toBe(false)
  })

  test("a subagent's end keeps it, whatever id it names", () => {
    expect(disposesOnSessionEnd(current, { sessionId: 'session-1', agentId: 'agent-7' })).toBe(false)
    expect(disposesOnSessionEnd(current, { agentId: 'agent-7' })).toBe(false)
  })

  test("this session's own end (a quit, /clear naming the id it leaves) disposes it", () => {
    expect(disposesOnSessionEnd(current, { sessionId: 'session-1' })).toBe(true)
  })

  test('the end of the session the process is in now disposes an instance still serving an older id', () => {
    expect(disposesOnSessionEnd(current, { sessionId: 'session-2' }, 'session-2')).toBe(true)
    expect(disposesOnSessionEnd(current, { sessionId: 'fork-1' }, 'session-1')).toBe(false)
  })

  test('an engine that names no session disposes, as before', () => {
    expect(disposesOnSessionEnd(current, {})).toBe(true)
    expect(disposesOnSessionEnd(current, undefined)).toBe(true)
  })

  test('no live instance: nothing to dispose', () => {
    expect(disposesOnSessionEnd(null, { sessionId: 'session-1' })).toBe(false)
  })
})

describe('healAction', () => {
  test('a live instance is only looked at; a missing or disposed one is made again', () => {
    expect(healAction({ isDisposed: false }, null, 0)).toBe('check')
    expect(healAction(null, null, 0)).toBe('rebuild')
    expect(healAction({ isDisposed: true }, null, 0)).toBe('rebuild')
  })

  test("this session's own end waits one whole period first (/clear moves the id just after it)", () => {
    expect(healAction({ isDisposed: true }, 1_000, 1_000 + MOD_HEAL_EVERY_MS - 1)).toBe('wait')
    expect(healAction({ isDisposed: true }, 1_000, 1_000 + MOD_HEAL_EVERY_MS)).toBe('rebuild')
  })
})

describe('InboxLink.ensureTicking', () => {
  test('a tick the engine stopped firing (one refused $.clock.every) is armed again; a firing one is left alone', async () => {
    const host = fakeHost()
    const armed: (() => void)[] = []
    // The engine took the timer and never calls it.
    host.every = (_ms, fn) => {
      armed.push(fn)
      return { cancel: () => undefined }
    }
    const link = new InboxLink({ host, dataDir: '/data', sessionId: 'session-1', tools: [], isBusy: () => false, instanceId: 'me' })
    link.start()
    expect(armed).toHaveLength(1)

    await link.ensureTicking()
    host.clock += 5_000
    await link.ensureTicking()
    expect(armed).toHaveLength(1)
    host.clock += 6_000
    await link.ensureTicking()
    expect(armed).toHaveLength(2)

    // The new timer fires: nothing more is armed.
    for (let second = 0; second < 30; second++) {
      armed[1]!()
      host.clock += 1_000
      await link.ensureTicking()
    }
    expect(armed).toHaveLength(2)

    link.dispose()
    host.clock += 60_000
    await link.ensureTicking()
    await link.ensureTicking()
    expect(armed).toHaveLength(2)
  })
})
