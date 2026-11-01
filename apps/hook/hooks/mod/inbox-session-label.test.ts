import { describe, expect, test } from 'bun:test'
import { InboxLink, inboxRegistryPathOf, inboxSessionTitleOf } from './inbox'
import { register, sessionTitleOf } from './register'
import { fakeHost } from './testing/fake-host'

// Session labels (approval "inbox-session-label"): the To picker's name for a
// Claude Code session is its `session_title`, which only the classic
// SessionStart and UserPromptSubmit inputs carry. The failures this catches:
// reading it from `session.start` or `prompt.submit`, which never have it (the
// label would silently never show); a poll that stops carrying it, or carries
// another session's after `/clear`; a subagent's event renaming the session.

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })

async function ticks(host: ReturnType<typeof fakeHost>, n: number) {
  for (let i = 0; i < n; i += 1) {
    host.clock += 1_000
    await host.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function linkOver(host: ReturnType<typeof fakeHost>, label?: () => string) {
  host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
  const polls: Record<string, unknown>[] = []
  host.onFetch = (url, body) => {
    if (url.endsWith('/api/inbox/bridge/poll')) polls.push(body as Record<string, unknown>)
    return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
  }
  const link = new InboxLink({ host, dataDir: DATA, sessionId: 'sess-1', tools: [], isBusy: () => false, instanceId: 'me', ...(label ? { label } : {}) })
  return { link, polls }
}

/** The module's hooks as the engine holds them: `event` to its function, the matcher dropped. */
function hooks(): Map<string, (($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown)[]> {
  const out = new Map<string, ((...args: never[]) => unknown)[]>()
  register((event: string, ...args: unknown[]) => {
    out.set(event, [...(out.get(event) ?? []), args.at(-1) as (...args: never[]) => unknown])
  })
  return out as never
}

describe('inboxSessionTitleOf', () => {
  test('the title, and an empty one as empty: it clears', () => {
    expect(inboxSessionTitleOf({ session_title: 'Fix login redirect' })).toBe('Fix login redirect')
    expect(inboxSessionTitleOf({ session_title: '' })).toBe('')
  })

  test('says nothing for an engine without the field, or for a subagent', () => {
    expect(inboxSessionTitleOf({})).toBeNull()
    expect(inboxSessionTitleOf({ session_title: 7 })).toBeNull()
    expect(inboxSessionTitleOf({ session_title: 'A subagent', agent_id: 'agent-1' })).toBeNull()
  })
})

describe('the hooks', () => {
  test('the classic events are read and the rest of the chain runs as it did', async () => {
    const on = hooks()
    for (const [event, title] of [
      ['classic.SessionStart', 'From the start'],
      ['classic.UserPromptSubmit', 'From a prompt'],
    ] as const) {
      expect(on.get(event)).toHaveLength(1)
      const input = { session_id: 'sess-hooks', session_title: title }
      const answer = await on.get(event)![0]!({}, input, (e) => ({ passed: e }))
      expect(answer).toEqual({ passed: input })
      expect(sessionTitleOf('sess-hooks')).toBe(title)
    }
  })

  test("a call that says nothing keeps the title; another session's is not this one's", async () => {
    const on = hooks()
    const start = on.get('classic.SessionStart')![0]!
    const prompt = on.get('classic.UserPromptSubmit')![0]!
    await start({}, { session_id: 'sess-keep', session_title: 'Kept' }, () => ({}))
    await prompt({}, { session_id: 'sess-keep' }, () => ({}))
    expect(sessionTitleOf('sess-keep')).toBe('Kept')
    await prompt({}, { session_id: 'sess-keep', agent_id: 'a', session_title: 'A subagent' }, () => ({}))
    expect(sessionTitleOf('sess-keep')).toBe('Kept')
    // /clear: a new id, and no title carried over.
    await start({}, { session_id: 'sess-after-clear' }, () => ({}))
    expect(sessionTitleOf('sess-after-clear')).toBe('')
    await prompt({}, { session_id: 'sess-keep', session_title: '' }, () => ({}))
    expect(sessionTitleOf('sess-keep')).toBe('')
  })
})

describe('the poll', () => {
  test('carries the title on every poll, so a later hook call updates what the Inbox shows', async () => {
    const host = fakeHost()
    let title = ''
    const { link, polls } = linkOver(host, () => title)
    link.start()
    await ticks(host, 2)
    expect(polls.length).toBeGreaterThan(0)
    expect(polls.every((poll) => poll.label === '')).toBe(true)

    title = 'Fix login redirect'
    await ticks(host, 2)
    expect(polls.at(-1)!.label).toBe('Fix login redirect')

    title = ''
    await ticks(host, 2)
    expect(polls.at(-1)!.label).toBe('')
    link.dispose()
  })

  test('a link with no title source sends no field', async () => {
    const host = fakeHost()
    const { link, polls } = linkOver(host)
    link.start()
    await ticks(host, 2)
    expect(polls.length).toBeGreaterThan(0)
    expect(polls.every((poll) => !('label' in poll))).toBe(true)
    link.dispose()
  })
})
