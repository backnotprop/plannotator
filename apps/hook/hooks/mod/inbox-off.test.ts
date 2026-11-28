import { describe, expect, test } from 'bun:test'
import { InboxLink, inboxRegistryPathOf } from './inbox'
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_OFF_POLL_FIELD, INBOX_OFF_TOOL_TEXT, inboxOffRefuses, type InboxReplyCommand } from './inbox-contract'
import { readOffSessions, withOffSession } from './inbox-off'
import { fakeHost } from './testing/fake-host'

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })
const REPLY = {
  type: 'reply',
  id: 'msg_reply1',
  thread_id: 'msg_thread1',
  reply_to: 'msg_ask1',
  subject: 'fern-api rollout',
  body: 'Hold the fern-api rollout until Bob Tully is back.',
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
  const link = new InboxLink({ host, dataDir: DATA, sessionId: 'sess-1', tools: [], isBusy: () => false, instanceId: 'me' })
  return { host, link, polls, states }
}

const delivered = (host: ReturnType<typeof fakeHost>) => host.submits.filter((text) => text.includes(REPLY.body))

describe('Inbox off in one Claude Code session', () => {
  test('off: the reply waits while polls go on and say off, a send is refused with the one line; on: it goes in once', async () => {
    const { host, link, polls, states } = world()
    link.setInboxOff(true)
    link.start()
    await ticks(host, 8)
    expect(delivered(host)).toEqual([])
    expect(polls.length).toBeGreaterThan(2)
    for (const poll of polls) expect(poll[INBOX_OFF_POLL_FIELD]).toBe(true)
    expect(await link.callTool({ action: 'send_message', body: 'Ready?' }, '/work')).toEqual({ deny: INBOX_OFF_TOOL_TEXT })

    link.setInboxOff(false)
    await ticks(host, 6)
    expect(delivered(host)).toHaveLength(1)
    expect(states.map((state) => state[INBOX_OFF_POLL_FIELD])).toEqual([false])
    expect(polls.at(-1)?.[INBOX_OFF_POLL_FIELD]).toBe(false)
    await ticks(host, 4)
    expect(delivered(host)).toHaveLength(1)
    link.dispose()
  })

  test('the person typing does not lift off (unlike a stopped session)', async () => {
    const { host, link } = world()
    link.setInboxOff(true)
    link.start()
    await ticks(host, 3)
    link.onForeignPrompt({ originKind: 'composer' })
    link.onMainTurnStart()
    await ticks(host, 6)
    expect(delivered(host)).toEqual([])
    link.dispose()
  })

  test('only reads pass while off', () => {
    expect(inboxOffRefuses({ action: 'read_thread' })).toBe(false)
    expect(inboxOffRefuses({ action: 'search', query: 'ledger' })).toBe(false)
    expect(inboxOffRefuses('{"action":"read_thread"}')).toBe(false)
    for (const action of ['send_message', 'submit_guide', 'steps', 'card', 'routine', 'resolve_message', 'snooze_thread', 'thread_pulls']) expect(inboxOffRefuses({ action })).toBe(true)
    expect(inboxOffRefuses('not json')).toBe(true)
  })

  test('the stored record keeps a resumed session off and drops it on on', () => {
    const off = withOffSession(readOffSessions(undefined), 'sess-1', true, 5)
    expect(Object.hasOwn(readOffSessions(off), 'sess-1')).toBe(true)
    expect(withOffSession(off, 'sess-1', false, 6)).toEqual({})
  })
})
