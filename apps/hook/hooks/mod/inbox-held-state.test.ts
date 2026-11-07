/**
 * The mod tells the Inbox when Claude Code holds this session's replies (approval "inbox-stopped-reply"):
 * after Claude Code dropped a reply's prompt (#2780, the person stopped the session), the `state` event says
 * `held: true` at once and every poll carries it; the person's input lifts it, and a `state` event says
 * `held: false`. The window's "Stopped: goes in when you type in that session" reads exactly this. The failure
 * this catches: an event that never goes out (the line waits for the next poll) or never says the hold lifted.
 * A memory host, no Inbox.
 */
import { describe, expect, test } from 'bun:test'
import { PromptDropped } from './host'
import { InboxLink, inboxRegistryPathOf } from './inbox'
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_HELD_POLL_FIELD, type InboxReplyCommand } from './inbox-contract'
import { fakeHost } from './testing/fake-host'

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })
const REPLY: InboxReplyCommand = {
  type: 'reply',
  id: 'msg_reply1',
  thread_id: 'msg_thread1',
  reply_to: 'msg_ask1',
  subject: 'Runner',
  body: 'Use the ARM runner.',
  url: 'http://127.0.0.1:4100/#thread=msg_thread1',
} as InboxReplyCommand

async function ticks(host: ReturnType<typeof fakeHost>, n: number) {
  for (let i = 0; i < n; i += 1) {
    host.clock += 1_000
    await host.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function world() {
  const host = fakeHost()
  host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
  const polls: Record<string, unknown>[] = []
  const states: Record<string, unknown>[] = []
  let waiting = true
  host.onFetch = (url, body) => {
    const record = body as Record<string, unknown>
    if (url.endsWith(INBOX_BRIDGE_POLL_PATH)) {
      polls.push(record)
      return { status: 200, ok: true, text: JSON.stringify({ commands: waiting ? [REPLY] : [] }) }
    }
    if (url.endsWith(INBOX_BRIDGE_EVENT_PATH) && record.type === 'state') states.push(record)
    if (url.endsWith(INBOX_BRIDGE_EVENT_PATH) && record.type === 'delivered') waiting = false
    return { status: 200, ok: true, text: '{}' }
  }
  let dropping = true
  host.submit = async (text) => {
    host.submits.push(text)
    if (dropping) throw new PromptDropped('the session was stopped and nobody has sent input since')
  }
  const link = new InboxLink({ host, dataDir: DATA, sessionId: 'sess-1', tools: [], isBusy: () => false, instanceId: 'me' })
  return { host, link, polls, states, stopDropping: () => (dropping = false) }
}

describe('the held state the mod reports', () => {
  test('a dropped reply: a state event says held at once, polls carry it; the person types: a state event says it lifted, and the reply goes in', async () => {
    const { host, link, polls, states, stopDropping } = world()
    link.start()
    await ticks(host, 6)
    expect(host.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
    // Told at once by the state event, not left to the next poll.
    expect(states.map((state) => state[INBOX_HELD_POLL_FIELD])).toEqual([true])
    const pollsWhileHeld = polls.length
    await ticks(host, 3)
    // Nothing tried again while held, and every poll since says so.
    expect(host.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
    expect(polls.length).toBeGreaterThan(pollsWhileHeld)
    for (const poll of polls.slice(pollsWhileHeld)) expect(poll[INBOX_HELD_POLL_FIELD]).toBe(true)

    // The person types: the hold lifts, the Inbox hears it, and the reply goes in at the idle after.
    stopDropping()
    link.onForeignPrompt({ originKind: 'composer' })
    const pollsAfter = polls.length
    await ticks(host, 6)
    expect(states.map((state) => state[INBOX_HELD_POLL_FIELD])).toEqual([true, false])
    for (const poll of polls.slice(pollsAfter)) expect(poll[INBOX_HELD_POLL_FIELD]).toBeUndefined()
    expect(host.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(2)
    link.dispose()
  })

  test('a reply that goes in: no state event about a hold, and no poll says held', async () => {
    const { host, link, polls, states, stopDropping } = world()
    stopDropping()
    link.start()
    await ticks(host, 8)
    expect(host.submits.filter((text) => text.includes(REPLY.body))).toHaveLength(1)
    expect(states).toEqual([])
    expect(polls.length).toBeGreaterThan(0)
    for (const poll of polls) expect(poll[INBOX_HELD_POLL_FIELD]).toBeUndefined()
    link.dispose()
  })
})
