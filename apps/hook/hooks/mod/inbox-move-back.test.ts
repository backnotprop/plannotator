/**
 * A reply moved back to a session that already took something under its id: the stop notice of a hand-off. The former
 * owner goes on running, so its connection has the id settled, and the Claude Code mod keeps a claim of its own.
 * A real Inbox in process on a clock the test moves, a running `InboxWake`, and a running `ClaudeSession`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startInboxServer, type InboxServer } from '../../../../packages/server/inbox'
import { INBOX_ASKER_RESTART_GRACE_MS } from '../../../../packages/server/inbox-sessions'
import { InboxAgentConnection, InboxWake } from '../../../../packages/shared/inbox/agent-link'
import { INBOX_WAKES_META_KEY, type InboxReplyCommand } from '../../../../packages/shared/inbox/connection'
import { inboxSessionDirOf } from './inbox'
import { INBOX_BRIDGE_POLL_PATH, INBOX_STEER_POLLS_POLL_FIELD, inboxHandedAwayLine } from './inbox-contract'
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
  let now = 1_000_000
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
  /** Another reply answers the former owner's held poll without the moved one: the Inbox stopped handing that out. */
  const anotherReply = async () => {
    const other = await ask('And the region?')
    return reply(other.message_id, 'k2', 'us-east-1')
  }
  const moveBack = async (id: string) => {
    now += INBOX_ASKER_RESTART_GRACE_MS + 1
    let status = 0
    await until('the move back', async () => {
      status = (await window(`messages/${id}/to`, { to: { host, session: FORMER } })).status
      return status === 200
    })
  }
  return { server, project, dataDir, asked, handOff, anotherReply, moveBack, message, pollNewOwner }
}

describe('moved back to the session that took the stop notice', () => {
  test('a running wake (Pi, OpenCode, dsh) delivers the words, as its own', async () => {
    const w = await world('pi')
    const delivered: { text: string; command: InboxReplyCommand }[] = []
    const wake = new InboxWake(
      new InboxAgentConnection({ dataDir: w.dataDir, host: 'pi', agentName: 'Pi', tools: [] }),
      FORMER,
      { isBusy: () => false, deliver: async (text, command) => void delivered.push({ text, command }), notify: () => {}, projectPath: () => w.project },
      20,
    )
    wake.start()
    stops.push(() => wake.dispose())
    const id = await w.handOff(() => delivered.some((d) => d.command.handed_away))
    const other = await w.anotherReply()
    await until('the other reply', () => delivered.some((d) => d.command.id === other))
    await w.moveBack(id)
    await until('the words', () => delivered.some((d) => d.text.includes(WORDS)))
    expect(delivered.filter((d) => d.text.includes(WORDS))).toHaveLength(1)
    expect(delivered.find((d) => d.text.includes(WORDS))!.command.also_tagged).toBeUndefined()
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
    expect((await w.message(w.asked.thread_id, id)).delivery).toMatchObject({ session: FORMER })
  }, 40_000)

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
  const NOTICE = inboxHandedAwayLine('Pi')

  test('a running Claude Code delivers the words: the claim it kept for the notice does not stand', async () => {
    const w = await claudeWorld()
    const session = await w.open()
    const id = await w.handOff(() => took(session, NOTICE))
    const other = await w.anotherReply()
    await until('the other reply', () => took(session, 'us-east-1'))
    await until('its claim on the notice', () => existsSync(join(inboxSessionDirOf(w.dataDir, FORMER), 'claims', id)))
    await w.moveBack(id)
    await until('the words', () => took(session, WORDS))
    expect(session.turns.filter((turn) => turn.text.includes(WORDS))).toHaveLength(1)
    await until('the delivery', async () => (await w.message(w.asked.thread_id, id)).delivery)
  }, 40_000)

  test('Claude Code restarted: the words go in, never a false Delivered from the notice\'s claim', async () => {
    const w = await claudeWorld()
    const first = await w.open()
    const id = await w.handOff(() => took(first, NOTICE))
    first.quit()
    const session = await w.open()
    await w.moveBack(id)
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
