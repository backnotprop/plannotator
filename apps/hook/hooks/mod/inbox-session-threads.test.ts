import { describe, expect, test } from 'bun:test'
import { INBOX_SESSION_THREADS_TIMEOUT_MS, inboxRegistryPathOf, readSessionThreads } from './inbox'
import { fakeHost } from './testing/fake-host'

// The session's thread list after a compaction or on a resume. The failures
// these catch: session start or a compaction held up by an Inbox that does not
// answer, a list read from whatever server now holds a dead Inbox's port, or
// any request at all on a computer where the Inbox never ran. (The list's
// words and the peek mark: register.test.ts and packages/server's
// inbox-session-reads.test.ts against a real Inbox.)

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })
const TOOL = 'mcp__plugin_plannotator_tools__plannotator_inbox'

/** A fake host whose sleeps take real time (the bound is a race against a sleep). */
function hostWithRealSleep() {
  const host = fakeHost()
  host.sleep = (ms, signal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  return host
}

describe('readSessionThreads', () => {
  test('no Inbox has run here: no list, and no request made', async () => {
    const host = hostWithRealSleep()
    const urls: string[] = []
    host.onFetch = (url) => {
      urls.push(url)
      return { status: 200, ok: true, text: '{}' }
    }
    expect(await readSessionThreads(host, DATA, 'sess-1', '/work', TOOL)).toBeNull()
    expect(urls).toEqual([])
  })

  test("another server on the registry's port (the Inbox stopped): no list, and its /mcp is never called", async () => {
    const host = hostWithRealSleep()
    host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
    const urls: string[] = []
    host.onFetch = (url) => {
      urls.push(url)
      return { status: 200, ok: true, text: JSON.stringify({ serverSession: 'someone-else' }) }
    }
    expect(await readSessionThreads(host, DATA, 'sess-1', '/work', TOOL)).toBeNull()
    expect(urls).toEqual(['http://127.0.0.1:4100/api/inbox/health'])
  })

  test("an Inbox from before the peek mark (its health has no peek): no list, and its /mcp is never called (it would make a project)", async () => {
    const host = hostWithRealSleep()
    host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
    const urls: string[] = []
    host.onFetch = (url) => {
      urls.push(url)
      return { status: 200, ok: true, text: JSON.stringify({ ok: true, app: 'plannotator-inbox', serverSession: 'srv', version: '0.28.32' }) }
    }
    expect(await readSessionThreads(host, DATA, 'sess-1', '/work', TOOL)).toBeNull()
    expect(urls).toEqual(['http://127.0.0.1:4100/api/inbox/health'])
  })

  test('an Inbox that never answers: no list, within the bound', async () => {
    const host = hostWithRealSleep()
    host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
    host.onFetch = (url) =>
      url.endsWith('/api/inbox/health') ? { status: 200, ok: true, text: JSON.stringify({ serverSession: 'srv', peek: true }) } : new Promise(() => undefined)
    const started = Date.now()
    expect(await readSessionThreads(host, DATA, 'sess-1', '/work', TOOL)).toBeNull()
    expect(Date.now() - started).toBeLessThan(INBOX_SESSION_THREADS_TIMEOUT_MS + 500)
  })
})
