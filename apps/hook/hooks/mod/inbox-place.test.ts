/**
 * The Claude Code mod's poll says where the session lives
 * (INBOX_PLACE_POLL_FIELD) when its host says so, and nothing otherwise. The
 * failures these guard: a place sent from outside Rex (or from tmux inside
 * it); a host that cannot tell breaking the poll; the mod's copy of the hint
 * rules drifting from the shared one (inbox-contract.test.ts holds the bytes).
 * A memory host for the poll: no Inbox, no Rex.
 */
import { describe, expect, test } from 'bun:test'
import { InboxLink, inboxRegistryPathOf } from './inbox'
import { INBOX_BRIDGE_POLL_PATH, INBOX_PLACE_POLL_FIELD, inboxPlaceFromEnv, type InboxPlace } from './inbox-contract'
import { fakeHost } from './testing/fake-host'

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })
const SESSION = 'session:01a1eb88-f030-7da4-aa20-0dc3df15fce2'
const BLOCK = 'block:01a1eb88-f030-7eb1-9448-bf75ec96f726'

async function pollsOf(place?: () => Promise<InboxPlace | null>) {
  const host = fakeHost()
  host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
  const polls: Record<string, unknown>[] = []
  host.onFetch = (url, body) => {
    if (url.endsWith(INBOX_BRIDGE_POLL_PATH)) polls.push(body as Record<string, unknown>)
    return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
  }
  const link = new InboxLink({ host, dataDir: DATA, sessionId: 'ses-1', tools: [], isBusy: () => false, instanceId: 'me', ...(place ? { place } : {}) })
  link.start()
  for (let i = 0; i < 4; i += 1) {
    host.clock += 1_000
    await host.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  link.dispose()
  expect(polls.length).toBeGreaterThan(0)
  return polls
}

describe('where the session lives, on the poll', () => {
  test("in Rex's terminal: every poll carries the pane's ids", async () => {
    const env = { TERM_PROGRAM: 'rex', REX_SESSION: SESSION, REX_BLOCK: BLOCK }
    for (const poll of await pollsOf(async () => inboxPlaceFromEnv(env))) expect(poll[INBOX_PLACE_POLL_FIELD]).toEqual({ kind: 'rex', session: SESSION, block: BLOCK })
  })

  test('tmux inside Rex, no Rex, a host that cannot tell, or no place option: no such field', async () => {
    const tmux = { TERM_PROGRAM: 'tmux', REX_SESSION: SESSION, REX_BLOCK: BLOCK }
    for (const poll of await pollsOf(async () => inboxPlaceFromEnv(tmux))) expect(INBOX_PLACE_POLL_FIELD in poll).toBe(false)
    for (const poll of await pollsOf(async () => inboxPlaceFromEnv({}))) expect(INBOX_PLACE_POLL_FIELD in poll).toBe(false)
    for (const poll of await pollsOf(async () => Promise.reject(new Error('no env')))) expect(INBOX_PLACE_POLL_FIELD in poll).toBe(false)
    for (const poll of await pollsOf()) expect(INBOX_PLACE_POLL_FIELD in poll).toBe(false)
  })

  test('a session under test (bun test, or a sandboxed Plannotator) sends none, even in Rex', async () => {
    const env = { TERM_PROGRAM: 'rex', REX_SESSION: SESSION, REX_BLOCK: BLOCK }
    for (const poll of await pollsOf(async () => inboxPlaceFromEnv({ ...env, NODE_ENV: 'test' }))) expect(INBOX_PLACE_POLL_FIELD in poll).toBe(false)
    for (const poll of await pollsOf(async () => inboxPlaceFromEnv({ ...env, PLANNOTATOR_TEST_SANDBOX: '1' }))) expect(INBOX_PLACE_POLL_FIELD in poll).toBe(false)
  })
})
