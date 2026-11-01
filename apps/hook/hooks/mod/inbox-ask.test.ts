/**
 * Ask AI in the Claude Code mod: the mod's real code in a simulated session
 * (testing/claude-session.ts) against a real Inbox on a temp data dir, with the
 * person as the window's own requests. The moments that need a clock or a bad
 * server use a memory host. Real Claude Code is tests/manual/inbox-ask-claude.ts.
 *
 * This step reaches users at merge with the Inbox's setting off, so the first
 * thing guarded is that nothing happens then.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { SESSION_ASK_HEADER } from '../../../../packages/ai/session-bridge'
import { startInboxServer, type InboxServer } from '../../../../packages/server/inbox'
import type { InboxAskConversation } from '../../../../packages/shared/inbox/ask'
import { aiSession, postAsk, readAsk, runQuery, type AskAnswer } from '../../../../tests/helpers/inbox-ask-window'
import { BRIDGE_POLL_PATH, BRIDGE_POLL_WAIT_MS, BRIDGE_SUPERSEDED_WAIT_MS, createBridge } from './bridge'
import { InboxLink, inboxRegistryPathOf } from './inbox'
import { inboxAskBridgeBase, INBOX_BRIDGE_POLL_PATH } from './inbox-contract'
import { ClaudeSession, PLUGIN_FRAME } from './testing/claude-session'
import { fakeHost, type FakeHost } from './testing/fake-host'
import { TurnTracker } from './turns'

const SESSION = 'session-a'
const roots: string[] = []
const servers: InboxServer[] = []
const clients: Client[] = []
const sessions: ClaudeSession[] = []

afterEach(async () => {
  for (const session of sessions.splice(0)) session.quit()
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const server of servers.splice(0)) server.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function until(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

/** An Inbox with one thread the session owns, and what it takes to open a session on it. */
async function world(askAi = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-mod-inbox-ask-')))
  roots.push(root)
  const project = join(root, 'api')
  mkdirSync(project, { recursive: true })
  const dataDir = join(root, 'data')
  const server = await startInboxServer({ dataDir, askAi, binaryPath: null })
  servers.push(server)
  const client = new Client({ name: 'mod-inbox-ask-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)))
  clients.push(client)
  const sent = await client.callTool({
    name: 'send_message',
    arguments: { body: 'Ship it?', project_path: project, agent_session: SESSION, agent_host: 'claude-code', agent_name: 'Claude Code' },
  })
  const threadId = (sent.structuredContent as { thread_id: string }).thread_id
  const store = new Map<string, unknown>()
  const open = async () => {
    const session = await ClaudeSession.start({ env: { PATH: process.env.PATH ?? '', PLANNOTATOR_DATA_DIR: dataDir }, cwd: project, store, sessionId: SESSION, dataDir })
    session.holdPluginTurns = true
    sessions.push(session)
    return session
  }
  return { server, threadId, open }
}

const clientFetches = (session: ClaudeSession) => session.host.fetches.filter((fetch) => fetch.includes(inboxAskBridgeBase(SESSION)))
const inboxPolled = (session: ClaudeSession) => session.host.fetches.some((fetch) => fetch.includes(INBOX_BRIDGE_POLL_PATH))

/** The question as the window sends it: POST /ask, then a query on the provider it named. */
async function asked(server: InboxServer, threadId: string, turnId: string, question = 'Why now?') {
  const response = await postAsk(server, threadId, turnId, question)
  expect(response.status).toBe(200)
  const posted = (await response.json()) as AskAnswer
  expect(posted.provider_id).toBeString()
  return runQuery(server, await aiSession(server, posted.provider_id!, threadId), question)
}

async function savedTurns(server: InboxServer, threadId: string): Promise<InboxAskConversation['turns']> {
  return (await readAsk(server, threadId)).conversation?.turns ?? []
}

/**
 * Records what the session's polls said and heard, and has the Inbox answer them
 * at once: a poll held its full 20 s would end after the test, and only an
 * answered poll can start anything.
 */
function answeredPolls(session: ClaudeSession) {
  const polls: { sent: Record<string, unknown>; answered: string | null }[] = []
  const realFetch = session.host.fetch
  session.host.fetch = async (url, init) => {
    if (!url.endsWith(INBOX_BRIDGE_POLL_PATH)) return realFetch(url, init)
    const sent = JSON.parse(init.body ?? '{}') as Record<string, unknown>
    const entry: (typeof polls)[number] = { sent, answered: null }
    polls.push(entry)
    const result = await realFetch(url, { ...init, body: JSON.stringify({ ...sent, waitMs: 0 }) })
    entry.answered = result.text
    return result
  }
  return polls
}

describe('nothing happens until a question waits', () => {
  test('the setting off, as every user has it at merge: polls offer to answer, and no client, turn or change to the session follows', async () => {
    const { server, threadId, open } = await world(false)
    const session = await open()
    const polls = answeredPolls(session)
    await until(() => polls.filter((poll) => poll.answered !== null).length >= 2)

    expect(polls[0]!.sent.ask).toBe(true)
    expect((await postAsk(server, threadId, 'turn-0001', 'Why now?')).status).toBe(404)
    await session.startTurn('Keep working.')
    session.endTurn()
    const seen = polls.length
    await until(() => polls.slice(seen).some((poll) => poll.answered !== null))
    await Bun.sleep(100)

    expect(clientFetches(session)).toEqual([])
    expect(session.host.submits).toEqual([])
    expect(session.turns.map((turn) => turn.text)).toEqual(['Keep working.'])
    expect(polls.map((poll) => poll.answered).join('')).not.toContain('ask_waits')
  })

  test('the setting on with no question: the same', async () => {
    const { open } = await world()
    const session = await open()
    const polls = answeredPolls(session)
    await until(() => polls.filter((poll) => poll.answered !== null).length >= 2)
    await Bun.sleep(100)

    expect(clientFetches(session)).toEqual([])
    expect(session.host.submits).toEqual([])
    expect(polls.map((poll) => poll.answered).join('')).not.toContain('ask_waits')
  })
})

describe('the setting on', () => {
  test('a first question connects the session, runs as a turn, streams, and is saved', async () => {
    const { server, threadId, open } = await world()
    const session = await open()
    await until(() => inboxPolled(session))
    expect(clientFetches(session)).toEqual([])

    const answering = await asked(server, threadId, 'turn-0001')
    await until(() => session.running !== null)

    expect(session.running!.text.startsWith(PLUGIN_FRAME)).toBe(true)
    expect(session.running!.text).toContain(SESSION_ASK_HEADER)
    expect(session.running!.text).toContain('Why now?')
    session.mod.turns.onText(session.running!.id, 'Because ')
    await until(() => answering.messages.some((message) => message.delta === 'Because '))
    session.endTurn('Because it is ready.')
    await answering.finished

    expect(await savedTurns(server, threadId)).toMatchObject([{ question: 'Why now?', answer: 'Because it is ready.' }])
    expect((await savedTurns(server, threadId))[0]!.failure).toBeUndefined()
    expect(session.host.submits).toHaveLength(1)
  })

  test('a first question to a busy session does not go in, and a retry goes as soon as the turn ends', async () => {
    const { server, threadId, open } = await world()
    const session = await open()
    await until(() => inboxPolled(session))
    await session.startTurn('Keep working.')

    const first = await asked(server, threadId, 'turn-0001')
    await first.finished
    expect(first.messages.map((message) => message.code)).toEqual(['agent_busy'])
    expect(session.host.submits).toEqual([])

    // The client sits in a 15 s poll that said `busy`; the turn's end has to reach the Inbox on its own.
    session.endTurn()
    await Bun.sleep(500)
    const retry = await asked(server, threadId, 'turn-0001')
    await until(() => session.running !== null, 2_000)
    session.endTurn('Now it is.')
    await retry.finished

    expect(retry.messages.map((message) => message.code)).not.toContain('agent_busy')
    expect(session.host.submits).toHaveLength(1)
    expect(await savedTurns(server, threadId)).toMatchObject([{ answer: 'Now it is.' }])
  })

  test('a person typing into the answer ends it as taken over, with the words kept', async () => {
    const { server, threadId, open } = await world()
    const session = await open()
    await until(() => inboxPolled(session))
    const answering = await asked(server, threadId, 'turn-0001')
    await until(() => session.running !== null)
    session.mod.turns.onText(session.running!.id, 'Half an')
    await until(() => answering.messages.some((message) => message.delta === 'Half an'))

    await session.type('Stop, do this instead.')
    session.mod.onTurnStep(session.running!.id)
    await answering.finished

    expect(answering.messages.at(-1)?.code).toBe('session_taken_over')
    expect(await savedTurns(server, threadId)).toMatchObject([{ answer: 'Half an', failure: 'taken_over' }])
  })

  test('the session ending mid-answer ends the question as gone, with the words kept', async () => {
    const { server, threadId, open } = await world()
    const session = await open()
    await until(() => inboxPolled(session))
    const answering = await asked(server, threadId, 'turn-0001')
    await until(() => session.running !== null)
    session.mod.turns.onText(session.running!.id, 'Words so far')
    await until(() => answering.messages.some((message) => message.delta === 'Words so far'))

    session.mod.dispose()
    await answering.finished

    expect(await savedTurns(server, threadId)).toMatchObject([{ answer: 'Words so far', failure: 'gone' }])
  })

  test('two processes: the answer finishes where it started after the lease moves, and the next question goes to the new holder', async () => {
    const { server, threadId, open } = await world()
    const first = await open()
    await until(() => inboxPolled(first))
    const answering = await asked(server, threadId, 'turn-0001', 'First?')
    await until(() => first.running !== null)

    const moved: string[] = []
    first.host.debug = (text) => moved.push(text)
    const second = await open()
    await second.type('I am here now.')
    second.endTurn()
    await until(() => moved.some((text) => text.includes('another Claude Code process')))
    const pollsThen = clientFetches(first).length
    await until(() => clientFetches(first).length > pollsThen + 1)

    first.mod.turns.onText(first.running!.id, 'Yes.')
    first.endTurn('Yes.')
    await answering.finished
    expect(await savedTurns(server, threadId)).toMatchObject([{ answer: 'Yes.' }])

    await until(() => moved.some((text) => text.includes('Ask AI client stopped (ended)')))
    await until(() => inboxPolled(second))
    const next = await asked(server, threadId, 'turn-0002', 'Second?')
    await until(() => second.running !== null && second.running.text.includes('Second?'))
    second.endTurn('Also yes.')
    await next.finished

    expect(first.host.submits).toHaveLength(1)
    expect(await savedTurns(server, threadId)).toMatchObject([{ answer: 'Yes.' }, { answer: 'Also yes.' }])
  }, 20_000)
})

describe('how the client stops', () => {
  const registry = JSON.stringify({ v: 1, pid: 1, port: 4321, token: 't'.repeat(64), serverSession: 'server', url: 'http://127.0.0.1:4321' })
  const ASK_POLL = `http://127.0.0.1:4321${inboxAskBridgeBase(SESSION)}${BRIDGE_POLL_PATH}`
  const answer = (body: unknown, status = 200) => ({ status, ok: status < 300, text: JSON.stringify(body) })

  /** A link on a memory host whose Inbox always has a question waiting; `onAskPoll` plays the client's bridge. */
  function link(host: FakeHost, onAskPoll: (count: number, stop: () => void) => ReturnType<typeof answer>) {
    host.files.set(inboxRegistryPathOf('/data'), registry)
    const inbox: InboxLink = new InboxLink({
      host,
      dataDir: '/data',
      sessionId: SESSION,
      tools: [],
      isBusy: () => false,
      instanceId: 'me',
      turns: new TurnTracker(),
    })
    const gone: unknown[] = []
    let askPolls = 0
    host.onFetch = (url, body) => {
      if (url.endsWith(INBOX_BRIDGE_POLL_PATH)) return answer({ commands: [], ask_waits: true })
      if (url === ASK_POLL) {
        askPolls += 1
        return onAskPoll(askPolls, () => inbox.dispose())
      }
      if (url.includes(inboxAskBridgeBase(SESSION))) gone.push(body)
      return answer({ ok: true })
    }
    inbox.start()
    return { inbox, gone, askPolls: () => askPolls }
  }

  async function ticks(host: FakeHost, count: number) {
    for (let index = 0; index < count; index += 1) {
      host.clock += 1_000
      await host.tick()
    }
  }

  test('a closed bridge or a refused client starts again on the next signal', async () => {
    for (const end of [answer({ commands: [], closing: true }), answer({}, 404)]) {
      const host = fakeHost()
      const { inbox, askPolls } = link(host, () => end)
      await ticks(host, 6)
      expect(askPolls()).toBeGreaterThanOrEqual(2)
      inbox.dispose()
    }
  })

  test('a client that lets go says so, so the next question does not wait out the silence', async () => {
    const host = fakeHost()
    const { gone } = link(host, (_count, stop) => {
      stop()
      return answer({ commands: [] })
    })
    await ticks(host, 3)
    expect(gone).toEqual([{ type: 'status', status: 'gone' }])
  })

  test('a client another client replaced stays quiet: its gone would end the other one`s question', async () => {
    const host = fakeHost()
    const { gone, askPolls } = link(host, (_count, stop) => {
      stop()
      return answer({ commands: [], superseded: true })
    })
    await ticks(host, 3)
    expect(askPolls()).toBe(1)
    expect(gone).toEqual([])
  })

  test('a client that never connected says nothing: a question may be waiting for the next holder', async () => {
    const host = fakeHost()
    const { gone } = link(host, (_count, stop) => {
      stop()
      return answer({ commands: [] }, 500)
    })
    await ticks(host, 3)
    expect(gone).toEqual([])
  })
})

test('the longest stay-away after `superseded` is under the poll wait, so two clients never line up', async () => {
  const host = fakeHost()
  host.randomHex = () => 'ff'
  const slept: number[] = []
  host.sleep = async (ms) => {
    slept.push(ms)
  }
  let polls = 0
  host.onFetch = () => {
    polls += 1
    return { status: 200, ok: true, text: JSON.stringify(polls === 1 ? { commands: [], superseded: true } : { commands: [], closing: true }) }
  }
  await createBridge({ host, baseUrl: 'http://127.0.0.1:4321', token: 'k', turns: new TurnTracker(), isLive: () => true }).run()

  expect(slept).toEqual([BRIDGE_SUPERSEDED_WAIT_MS.min + BRIDGE_SUPERSEDED_WAIT_MS.jitter])
  expect(slept[0]!).toBeLessThan(BRIDGE_POLL_WAIT_MS)
})
