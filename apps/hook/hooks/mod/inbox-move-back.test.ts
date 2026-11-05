/**
 * A reply moved back to the session that was told to stop working on it. That session goes on running, with the notice
 * taken, on its way in, or still waiting, and whatever it keeps for the notice must never stand for the person's words.
 * A real Inbox in process on a clock the test moves, a running `InboxWake`, and a running `ClaudeSession`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startInboxServer, type InboxServer } from '../../../../packages/server/inbox'
import { INBOX_ASKER_RESTART_GRACE_MS } from '../../../../packages/server/inbox-sessions'
import { InboxAgentConnection, InboxWake } from '../../../../packages/shared/inbox/agent-link'
import { INBOX_WAKES_META_KEY, type InboxReplyCommand } from '../../../../packages/shared/inbox/connection'
import { inboxSessionDirOf } from './inbox'
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_STEER_POLLS_POLL_FIELD, INBOX_TAGGED_INSTRUCTION, INBOX_WAKE_INSTRUCTION, inboxHandedAwayLine } from './inbox-contract'
import { ClaudeSession } from './testing/claude-session'

const FORMER = 'session-former'
const NEW_OWNER = 'session-new-owner'
const WORDS = 'Yours again: use the ARM runner.'

const roots: string[] = []
const servers: InboxServer[] = []
const clients: Client[] = []
const stops: (() => void)[] = []

afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const server of servers.splice(0)) server.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function until(what: string, check: () => unknown | Promise<unknown>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

/** The former owner asked, handed its thread to a new owner that then stopped; the person's reply is to move back. */
async function world(host: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-mod-move-back-')))
  roots.push(root)
  const project = join(root, 'api')
  mkdirSync(project, { recursive: true })
  const dataDir = join(root, 'data')
  let now = Date.now()
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 50, sessionsNow: () => now })
  servers.push(server)
  const client = new Client({ name: 'mod-move-back-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)))
  clients.push(client)
  const base = `http://127.0.0.1:${server.port}`
  const ask = async (body: string) =>
    (
      await client.callTool({
        name: 'send_message',
        arguments: { body, project_path: project, agent_session: FORMER, agent_host: host, agent_name: 'The agent' },
        _meta: { [INBOX_WAKES_META_KEY]: true },
      })
    ).structuredContent as { message_id: string; thread_id: string }
  const window = (path: string, body: Record<string, unknown>) =>
    fetch(`${base}/api/inbox/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) })
  const reply = async (messageId: string, key: string, words: string, extra: Record<string, unknown> = {}) =>
    ((await (await window(`messages/${messageId}/reply`, { idempotency_key: key, words, ...extra })).json()) as { reply: { id: string } }).reply.id
  const pollNewOwner = async () => {
    const response = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: NEW_OWNER, host: 'pi', project_path: project, waitMs: 0, tags: true }),
    })
    return ((await response.json()) as { commands: { id: string }[] }).commands
  }
  const message = async (threadId: string, id: string) =>
    ((await (await fetch(`${base}/api/inbox/threads/${threadId}`)).json()) as { thread: { messages: { id: string; delivery?: { session: string }; tags?: { session: string; delivery?: unknown }[] }[] } }).thread.messages.find((m) => m.id === id)!
  const asked = await ask('Which runner?')
  /** The hand-off settles and the former owner's connection takes its notice (`tookNotice`). */
  const handOff = async (tookNotice: () => boolean) => {
    // The former owner's connection polls: only then is it told to stop.
    await until('the former owner to poll', async () => ((await (await fetch(`${base}/api/inbox/threads/${asked.thread_id}/sessions`)).json()) as { sessions: { session: string }[] }).sessions.some((s) => s.session === FORMER))
    await pollNewOwner()
    const id = await reply(asked.message_id, 'k1', WORDS, { tags: [{ host: 'pi', session: NEW_OWNER, mode: 'handoff' }] })
    await until('the hand-off to settle', async () => (await pollNewOwner()).length > 0)
    await until('the former owner to take its notice', tookNotice)
    await until('the notice recorded', async () => (await message(asked.thread_id, id)).tags?.[0]?.delivery)
    return id
  }
  /** The hand-off settles while the former owner's connection may still be busy: it has not taken its notice. */
  const handOffBusy = async () => {
    await until('the former owner to poll', async () => ((await (await fetch(`${base}/api/inbox/threads/${asked.thread_id}/sessions`)).json()) as { sessions: { session: string }[] }).sessions.some((one) => one.session === FORMER))
    await pollNewOwner()
    const id = await reply(asked.message_id, 'k1', WORDS, { tags: [{ host: 'pi', session: NEW_OWNER, mode: 'handoff' }] })
    await until('the hand-off to settle', async () => (await pollNewOwner()).length > 0)
    return id
  }
  /** A connection of the former owner, by hand: its poll and its report, as any version sends them. */
  const bridge = async (path: string, body: Record<string, unknown>) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: FORMER, host, project_path: project, ...body }),
    })
  const pollFormer = async (waitMs = 0) =>
    ((await (await bridge(INBOX_BRIDGE_POLL_PATH, { waitMs, tags: true })).json()) as { commands: InboxReplyCommand[] }).commands
  const report = (id: string) => bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id })
  /** `polled`: no connection runs here, so the test's own poll says the former owner is there. */
  const age = () => {
    now += INBOX_ASKER_RESTART_GRACE_MS + 1
  }
  /** A plain reply to the former owner, which has it waiting. */
  const replyToFormer = () => reply(asked.message_id, 'k1', WORDS)
  /** The former owner fell silent past the grace: the reply moves to a live session. */
  const moveToNewOwner = async (id: string) => {
    age()
    await pollNewOwner()
    let status = 0
    await until('the move away', async () => {
      await pollNewOwner()
      status = (await window(`messages/${id}/to`, { to: { host: 'pi', session: NEW_OWNER } })).status
      return status === 200
    })
  }
  const moveBack = async (id: string, polled = false, aged = false) => {
    if (!aged) age()
    let status = 0
    await until('the move back', async () => {
      if (polled) await pollFormer()
      status = (await window(`messages/${id}/to`, { to: { host, session: FORMER } })).status
      return status === 200
    })
  }
  return { host, age, replyToFormer, moveToNewOwner, server, project, dataDir, asked, handOff, handOffBusy, pollFormer, report, moveBack, message, pollNewOwner, client }
}

function runningWake(w: Awaited<ReturnType<typeof world>>, busy: () => boolean = () => false) {
  const delivered: { text: string; command: InboxReplyCommand }[] = []
  const wake = new InboxWake(
    new InboxAgentConnection({ dataDir: w.dataDir, host: 'pi', agentName: 'Pi', tools: [] }),
    FORMER,
    { isBusy: busy, deliver: async (text, command) => void delivered.push({ text, command }), notify: () => {}, projectPath: () => w.project },
    20,
  )
  wake.start()
  stops.push(() => wake.dispose())
  return delivered
}

const NOTICE = inboxHandedAwayLine('Pi')

async function claudeWorld() {
  const w = await world('claude-code')
  const store = new Map<string, unknown>()
  const open = async () => {
    const session = await ClaudeSession.start({ env: { PATH: process.env.PATH ?? '', PLANNOTATOR_DATA_DIR: w.dataDir }, cwd: w.project, store, sessionId: FORMER, dataDir: w.dataDir })
    stops.push(() => session.quit())
    return session
  }
  return { ...w, open }
}
const took = (session: ClaudeSession, text: string) => session.turns.some((turn) => turn.text.includes(text))

describe('moved back to the session that took the stop notice', () => {
  test('a running wake (Pi, OpenCode, dsh), its next poll held: the move wakes it and the words go in, as its own', async () => {
    const w = await world('pi')
    const delivered = runningWake(w)
    const id = await w.handOff(() => delivered.some((d) => d.command.handed_away))
    // Its next poll is held: nothing ends it without the id before the move does.
    await Bun.sleep(150)
    await w.moveBack(id)
    await until('the words', () => delivered.some((d) => d.text.includes(WORDS)))
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
    const words = delivered.filter((d) => d.text.includes(WORDS))
    expect(words).toHaveLength(1)
    expect(words[0]!.command.also_tagged).toBeUndefined()
    // It is this session's own again: nothing says another session had it.
    expect(words[0]!.command.handoff).toBeUndefined()
    expect((await w.message(w.asked.thread_id, id)).delivery).toMatchObject({ session: FORMER })
  }, 40_000)

  test('a running Claude Code, its next poll held: the words go in', async () => {
    const w = await claudeWorld()
    const session = await w.open()
    const id = await w.handOff(() => took(session, NOTICE))
    // The tick (1 s) has started the next, held, poll.
    await Bun.sleep(1_500)
    await w.moveBack(id)
    await until('the words', () => took(session, WORDS))
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
    expect(session.turns.filter((turn) => turn.text.includes(WORDS))).toHaveLength(1)
  }, 40_000)

  test('Claude Code restarted: the words go in', async () => {
    const w = await claudeWorld()
    const first = await w.open()
    const id = await w.handOff(() => took(first, NOTICE))
    first.quit()
    const session = await w.open()
    await w.moveBack(id)
    await until('the words', () => took(session, WORDS))
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
  }, 40_000)

  test('an older connection, which keeps what it settled for good and does not say it polls while steering: the words reach it', async () => {
    const w = await world('pi')
    await w.pollFormer()
    const id = await w.handOffBusy()
    const settled = new Set<string>()
    const [notice] = await w.pollFormer()
    expect(notice!.handed_away).toBeTruthy()
    settled.add(notice!.id)
    expect((await w.report(notice!.id)).status).toBe(200)
    await w.moveBack(id, true)
    const words = (await w.pollFormer()).filter((command) => !settled.has(command.id))
    expect(words.map((command) => command.body)).toEqual([expect.stringContaining(WORDS)])
    expect((await w.report(words[0]!.id)).status).toBe(200)
    expect((await w.message(w.asked.thread_id, id)).delivery).toMatchObject({ session: FORMER })
  }, 40_000)
})

describe('moved back to the session with the notice not taken yet', () => {
  test('a busy wake: it never gets the notice, and only the words delivered say Delivered', async () => {
    const w = await world('pi')
    let busy = true
    const delivered = runningWake(w, () => busy)
    const id = await w.handOffBusy()
    await Bun.sleep(150)
    await w.moveBack(id)
    await Bun.sleep(150)
    expect((await w.message(w.asked.thread_id, id)).delivery ?? null).toBeNull()
    busy = false
    await until('the words', () => delivered.some((d) => d.text.includes(WORDS)))
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
    expect(delivered.filter((d) => d.command.handed_away)).toEqual([])
    expect(delivered.filter((d) => d.text.includes(WORDS))).toHaveLength(1)
  }, 40_000)

  test('a busy Claude Code: its turn ends and the words go in, with no notice', async () => {
    const w = await claudeWorld()
    const session = await w.open()
    await until('it to poll', async () => session.host.fetches.some((url: string) => url.includes(INBOX_BRIDGE_POLL_PATH)))
    await session.startTurn('a long tool call')
    await Bun.sleep(1_200)
    const id = await w.handOffBusy()
    // Its poll has the notice waiting for the turn to end.
    await Bun.sleep(2_500)
    await w.moveBack(id)
    await Bun.sleep(2_500)
    expect((await w.message(w.asked.thread_id, id)).delivery ?? null).toBeNull()
    session.endTurn()
    await until('the words', () => took(session, WORDS))
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
    expect(took(session, NOTICE)).toBe(false)
  }, 40_000)

  test('a notice report that lands after the move says nothing about the words, which are still handed out', async () => {
    const w = await world('pi')
    await w.pollFormer()
    const id = await w.handOffBusy()
    const [notice] = await w.pollFormer()
    await w.moveBack(id, true)
    expect((await w.report(notice!.id)).status).toBe(200)
    expect((await w.message(w.asked.thread_id, id)).delivery ?? null).toBeNull()
    expect((await w.pollFormer()).map((command) => command.id)).toEqual([id])
  }, 40_000)
})

test('read_thread by the id a stop notice shows reads its thread', async () => {
  const w = await world('pi')
  await w.pollFormer()
  await w.handOffBusy()
  const [notice] = await w.pollFormer()
  expect(notice!.handed_away).toBeTruthy()
  const read = (await w.client.callTool({ name: 'read_thread', arguments: { message_id: notice!.id, agent_session: FORMER } })) as { isError?: boolean; content: { text: string }[] }
  expect(read.isError ?? false).toBe(false)
  expect(read.content[0]!.text).toContain(w.asked.thread_id)
}, 40_000)

describe('tagged, not taken, then moved to that session', () => {
  /** Another session asked and stopped; the person replied and tagged the running session. */
  async function taggedOnAnother(w: Awaited<ReturnType<typeof world>>, beforeReply: () => void = () => {}) {
    const asked = (
      await w.client.callTool({
        name: 'send_message',
        arguments: { body: 'Another question?', project_path: w.project, agent_session: 'session-asker-2', agent_host: 'pi', agent_name: 'Other' },
        _meta: { [INBOX_WAKES_META_KEY]: true },
      })
    ).structuredContent as { message_id: string; thread_id: string }
    beforeReply()
    const response = await fetch(`http://127.0.0.1:${w.server.port}/api/inbox/messages/${asked.message_id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverSession: w.server.serverSession, idempotency_key: 'k9', words: WORDS, tags: [{ host: w.host, session: FORMER }] }),
    })
    return ((await response.json()) as { reply: { id: string } }).reply.id
  }

  test('a wake, with the move landing as it checks: the words go in as its own, not as a tag', async () => {
    const w = await world('pi')
    const delivered: { text: string; command: InboxReplyCommand }[] = []
    const connection = new InboxAgentConnection({ dataDir: w.dataDir, host: 'pi', agentName: 'Pi', tools: [] })
    let moveOnNextCheck: (() => Promise<void>) | null = null
    const send = connection.bridge.bind(connection)
    connection.bridge = (async (path: string, id: string, body: Record<string, unknown>, signal?: AbortSignal) => {
      if (path === INBOX_BRIDGE_POLL_PATH && body.waitMs === 0 && moveOnNextCheck) {
        const move = moveOnNextCheck
        moveOnNextCheck = null
        await move()
      }
      return send(path, id, body, signal)
    }) as typeof connection.bridge
    let busy = true
    const wake = new InboxWake(connection, FORMER, { isBusy: () => busy, deliver: async (text, command) => void delivered.push({ text, command }), notify: () => {}, projectPath: () => w.project }, 20)
    wake.start()
    stops.push(() => wake.dispose())
    await Bun.sleep(100)
    const id = await taggedOnAnother(w)
    await Bun.sleep(150)
    moveOnNextCheck = () => w.moveBack(id)
    busy = false
    await until('the words', () => delivered.some((d) => d.text.includes(WORDS)))
    expect(delivered.find((d) => d.text.includes(WORDS))!.command.tagged).toBeUndefined()
  }, 40_000)

  test('a busy Claude Code: its turn ends and the words go in as its own, not as a tag', async () => {
    const w = await claudeWorld()
    const session = await w.open()
    await until('it to poll', async () => session.host.fetches.some((url: string) => url.includes(INBOX_BRIDGE_POLL_PATH)))
    await session.startTurn('a long tool call')
    await Bun.sleep(1_200)
    // The asker's silence passes first: a tag waiting that long would go into the running turn by itself.
    const id = await taggedOnAnother(w, w.age)
    // Its poll has the tag waiting for the turn to end.
    await Bun.sleep(2_500)
    await w.moveBack(id, false, true)
    await Bun.sleep(2_500)
    session.endTurn()
    await until('the words', () => took(session, WORDS))
    const turn = session.turns.find((one) => one.text.includes(WORDS))!
    expect(turn.text).toContain(INBOX_WAKE_INSTRUCTION)
    expect(turn.text).not.toContain(INBOX_TAGGED_INSTRUCTION)
  }, 40_000)
})

describe('moved back to a session that lost it once', () => {
  /** A wake whose polls the test can stop: `away` all of them, `longAsleep` only the long ones (its check before a delivery goes). */
  function wakeWithPolls(w: Awaited<ReturnType<typeof world>>, deliver: (text: string) => Promise<void>) {
    const state = { away: false, longAsleep: false, busy: true, polled: 0 }
    const connection = new InboxAgentConnection({ dataDir: w.dataDir, host: 'pi', agentName: 'Pi', tools: [] })
    const send = connection.bridge.bind(connection)
    // Polls held for a moment only, so one ends without the reply soon after it moves.
    connection.bridge = (async (path: string, id: string, body: Record<string, unknown>, signal?: AbortSignal) => {
      const poll = path === INBOX_BRIDGE_POLL_PATH
      if (state.away || (poll && state.longAsleep && (body.waitMs as number) > 0)) return null
      const answer = await send(path, id, poll ? { ...body, waitMs: Math.min(body.waitMs as number, 100) } : body, signal)
      if (poll && (body.waitMs as number) > 0) state.polled++
      return answer
    }) as typeof connection.bridge
    const wake = new InboxWake(connection, FORMER, { isBusy: () => state.busy, deliver, notify: () => {}, projectPath: () => w.project }, 20)
    wake.start()
    stops.push(() => wake.dispose())
    return state
  }

  /** The same for a running Claude Code. */
  async function claudeWithPolls(w: Awaited<ReturnType<typeof claudeWorld>>) {
    const session = await w.open()
    await until('it to poll', async () => session.host.fetches.some((url: string) => url.includes(INBOX_BRIDGE_POLL_PATH)))
    const state = { away: false, longAsleep: false }
    const send = session.host.fetch
    session.host.fetch = (url, init) => {
      if (state.away) return Promise.reject(new Error('away'))
      if (!url.endsWith(INBOX_BRIDGE_POLL_PATH) || typeof init.body !== 'string') return send(url, init)
      const body = JSON.parse(init.body)
      if (state.longAsleep && body.waitMs > 0) return Promise.reject(new Error('asleep'))
      return send(url, { ...init, body: JSON.stringify({ ...body, waitMs: Math.min(body.waitMs, 100) }) })
    }
    return { session, state }
  }

  test('a wake that dropped it finds it back before any poll ended without it', async () => {
    const w = await world('pi')
    const delivered: string[] = []
    const state = wakeWithPolls(w, async (text) => void delivered.push(text))
    const id = await w.replyToFormer()
    // Its poll has the reply, waiting for the turn to end.
    await Bun.sleep(300)
    state.away = true
    await Bun.sleep(150)
    await w.moveToNewOwner(id)
    state.away = false
    state.longAsleep = true
    state.busy = false
    // Its check before the delivery finds the reply gone.
    await Bun.sleep(500)
    expect(delivered).toEqual([])
    await w.moveBack(id, true)
    state.longAsleep = false
    await until('the words', () => delivered.some((text) => text.includes(WORDS)))
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
  }, 40_000)

  test('a running Claude Code that dropped it finds it back before any poll ended without it', async () => {
    const w = await claudeWorld()
    const { session, state } = await claudeWithPolls(w)
    await session.startTurn('a long tool call')
    const id = await w.replyToFormer()
    await Bun.sleep(1_500)
    state.away = true
    await Bun.sleep(150)
    await w.moveToNewOwner(id)
    state.away = false
    state.longAsleep = true
    session.endTurn()
    await Bun.sleep(2_500)
    expect(took(session, WORDS)).toBe(false)
    await w.moveBack(id, true)
    state.longAsleep = false
    await until('the words', () => took(session, WORDS))
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
  }, 60_000)

  test('a wake whose delivery failed: moved away and back, what the Inbox stopped handing out is new again', async () => {
    const w = await world('pi')
    const delivered: string[] = []
    let fail = true
    const state = wakeWithPolls(w, async (text) => {
      if (fail) throw new Error('the session said no')
      delivered.push(text)
    })
    state.busy = false
    const id = await w.replyToFormer()
    // The failed delivery is reported, and the reply stays handed out.
    await Bun.sleep(300)
    fail = false
    expect(delivered).toEqual([])
    state.away = true
    await Bun.sleep(150)
    await w.moveToNewOwner(id)
    const polled = state.polled
    state.away = false
    await until('a poll to end without it', () => state.polled > polled)
    await w.moveBack(id)
    await until('the words', () => delivered.some((text) => text.includes(WORDS)))
  }, 40_000)

  test('a running Claude Code whose delivery failed: moved away and back, the words go in', async () => {
    const w = await claudeWorld()
    const { session, state } = await claudeWithPolls(w)
    const submit = session.host.submit
    let failures = 0
    session.host.submit = (text) => {
      if (failures++ === 0) return Promise.reject(new Error('the session said no'))
      return submit(text)
    }
    const id = await w.replyToFormer()
    await until('the failed delivery', () => failures > 0)
    await Bun.sleep(300)
    state.away = true
    await Bun.sleep(150)
    await w.moveToNewOwner(id)
    state.away = false
    await Bun.sleep(2_500)
    await w.moveBack(id)
    await until('the words', () => took(session, WORDS))
  }, 60_000)

  test('Claude Code killed mid-delivery: moved away and back, its old claim does not say Delivered, and the words go in', async () => {
    const w = await claudeWorld()
    const id = await w.replyToFormer()
    const claim = join(inboxSessionDirOf(w.dataDir, FORMER), 'claims', id)
    mkdirSync(claim, { recursive: true })
    writeFileSync(join(claim, 'delivered'), '1')
    await w.moveToNewOwner(id)
    await w.moveBack(id, true)
    const session = await w.open()
    await until('the words', () => took(session, WORDS))
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
  }, 40_000)
})

test('the Claude Code mod says its tick goes on polling while a steer waits', async () => {
  const w = await world('claude-code')
  const session = await ClaudeSession.start({ env: { PATH: process.env.PATH ?? '', PLANNOTATOR_DATA_DIR: w.dataDir }, cwd: w.project, store: new Map(), sessionId: FORMER, dataDir: w.dataDir })
  stops.push(() => session.quit())
  const bodies: Record<string, unknown>[] = []
  const send = session.host.fetch
  session.host.fetch = (url, init) => {
    if (url.endsWith(INBOX_BRIDGE_POLL_PATH) && typeof init.body === 'string') bodies.push(JSON.parse(init.body))
    return send(url, init)
  }
  await until('a poll', () => bodies.length > 0)
  expect(bodies[0]![INBOX_STEER_POLLS_POLL_FIELD]).toBe(true)
}, 30_000)
