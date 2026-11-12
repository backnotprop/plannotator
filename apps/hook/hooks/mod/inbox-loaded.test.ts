import { describe, expect, test } from 'bun:test'
import { InboxLink, inboxRegistryPathOf, pluginVersionOf } from './inbox'
import { fakeHost } from './testing/fake-host'

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })

async function ticks(host: ReturnType<typeof fakeHost>, n: number) {
  for (let i = 0; i < n; i += 1) {
    host.clock += 1_000
    await host.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function linkOver(host: ReturnType<typeof fakeHost>) {
  host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
  const polls: Record<string, unknown>[] = []
  host.onFetch = (url, body) => {
    if (url.endsWith('/api/inbox/bridge/poll')) polls.push(body as Record<string, unknown>)
    return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
  }
  const link = new InboxLink({ host, dataDir: DATA, sessionId: 'sess-1', tools: [], isBusy: () => false, instanceId: 'me' })
  return { link, polls }
}

describe('the poll says what this process loaded', () => {
  test('plugin (version, folder, load time) and engine ride every poll, read once', async () => {
    const host = fakeHost()
    let pluginReads = 0
    let engineReads = 0
    host.loadedPlugin = async () => {
      pluginReads += 1
      return { version: '0.28.24', root: '/home/me/.claude/plugins/cache/plannotator/plannotator/0.28.24', loaded_at: 1_700_000_000_000 }
    }
    host.engineVersion = async () => {
      engineReads += 1
      return '2.1.305'
    }
    const { link, polls } = linkOver(host)
    link.start()
    await ticks(host, 5)
    host.clock += 60_000
    await ticks(host, 5)
    link.dispose()
    expect(polls.length).toBeGreaterThanOrEqual(2)
    for (const poll of polls) {
      expect(poll.plugin).toEqual({ version: '0.28.24', root: '/home/me/.claude/plugins/cache/plannotator/plannotator/0.28.24', loaded_at: 1_700_000_000_000 })
      expect(poll.engine).toBe('2.1.305')
    }
    expect(pluginReads).toBe(1)
    expect(engineReads).toBe(1)
  })

  test('a read that failed still sends the field, with null parts: a missing field only ever means an older mod', async () => {
    const host = fakeHost()
    host.loadedPlugin = async () => ({ version: null, root: null, loaded_at: 1_700_000_000_000 })
    const { link, polls } = linkOver(host)
    link.start()
    await ticks(host, 5)
    link.dispose()
    expect(polls.length).toBeGreaterThanOrEqual(1)
    expect(polls[0]!.plugin).toEqual({ version: null, root: null, loaded_at: 1_700_000_000_000 })
  })

  test('the session folder is read once, at the start: a later /cd does not move the restart command', async () => {
    const host = fakeHost()
    let root = '/home/me/code/billing-api'
    host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
    const polls: Record<string, unknown>[] = []
    host.onFetch = (url, body) => {
      if (url.endsWith('/api/inbox/bridge/poll')) polls.push(body as Record<string, unknown>)
      return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
    }
    const link = new InboxLink({ host, dataDir: DATA, sessionId: 'sess-1', tools: [], isBusy: () => false, instanceId: 'me', root: async () => root, cwd: async () => root })
    link.start()
    await ticks(host, 5)
    root = '/home/me/code/billing-api/services/api'
    host.clock += 60_000
    await ticks(host, 5)
    link.dispose()
    expect(polls.length).toBeGreaterThanOrEqual(2)
    for (const poll of polls) expect(poll.session_folder).toBe('/home/me/code/billing-api')
    expect(polls[polls.length - 1]!.project_path).toBe('/home/me/code/billing-api/services/api')
  })
})

describe('pluginVersionOf', () => {
  test("plugin.json's version, or null", () => {
    expect(pluginVersionOf('{"name":"plannotator","version":"0.28.24"}')).toBe('0.28.24')
    expect(pluginVersionOf('{"name":"plannotator"}')).toBeNull()
    expect(pluginVersionOf('not json')).toBeNull()
    expect(pluginVersionOf(null)).toBeNull()
  })
})
