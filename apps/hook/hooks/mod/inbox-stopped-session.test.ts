/**
 * The owner's report: after Claude Code compacted an idle session, three Inbox replies each said "Delivered to
 * Claude Code" and no turn started; once the person typed, later replies woke it. Claude Code's
 * `$.prompt.submit` does not reject a prompt it refuses: it resolves `{ drop: <reason> }` (after a Stop: "the
 * session was stopped and nobody has sent input since"), and the mod read that as a turn that started. Any
 * reason is a drop. A real Inbox in process, a
 * running `ClaudeSession` whose engine drops plugin prompts once stopped, the person's reply through the
 * window's own route.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startInboxServer, type InboxServer } from '../../../../packages/server/inbox'
import { INBOX_WAKES_META_KEY } from '../../../../packages/shared/inbox/connection'
import { inboxSessionDirOf } from './inbox'
import { INBOX_BRIDGE_POLL_PATH } from './inbox-contract'
import { ClaudeSession, STOPPED_DROP_REASON } from './testing/claude-session'

const SESSION = 'session-stopped'
const FIRST = 'Use the ARM runner.'
const SECOND = 'And pin the image.'

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

async function until(what: string, check: () => unknown | Promise<unknown>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

/** The session asked in the Inbox; the person can reply to it. */
async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-mod-stopped-')))
  roots.push(root)
  const project = join(root, 'api')
  const home = join(root, 'home')
  mkdirSync(project, { recursive: true })
  mkdirSync(home, { recursive: true })
  const dataDir = join(root, 'data')
  const server = await startInboxServer({ dataDir, binaryPath: null })
  servers.push(server)
  const client = new Client({ name: 'mod-stopped-session-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)))
  clients.push(client)
  const base = `http://127.0.0.1:${server.port}`
  const asked = (
    await client.callTool({
      name: 'send_message',
      arguments: { body: 'Which runner?', project_path: project, agent_session: SESSION, agent_host: 'claude-code', agent_name: 'Claude Code' },
      _meta: { [INBOX_WAKES_META_KEY]: true },
    })
  ).structuredContent as { message_id: string; thread_id: string }
  const reply = async (key: string, words: string) =>
    (
      (await (
        await fetch(`${base}/api/inbox/messages/${asked.message_id}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: key, words }),
        })
      ).json()) as { reply: { id: string } }
    ).reply.id
  const delivery = async (id: string) =>
    ((await (await fetch(`${base}/api/inbox/threads/${asked.thread_id}`)).json()) as { thread: { messages: { id: string; delivery?: { session: string } | null }[] } }).thread.messages.find(
      (message) => message.id === id,
    )?.delivery ?? null
  // The list row's delivery for the thread (the window's "Stopped" line, approval "inbox-stopped-reply").
  const rowReason = async () =>
    ((await (await fetch(`${base}/api/inbox/threads?archived=exclude`)).json()) as { sections: { threads: { thread_id: string; delivery?: { reason: string } | null }[] }[] }).sections
      .flatMap((section) => section.threads)
      .find((row) => row.thread_id === asked.thread_id)?.delivery?.reason ?? null
  const session = await ClaudeSession.start({
    env: { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir },
    cwd: project,
    store: new Map(),
    sessionId: SESSION,
    dataDir,
  })
  sessions.push(session)
  await until('the session to poll', () => session.host.fetches.some((url) => url.includes(INBOX_BRIDGE_POLL_PATH)))
  const claims = join(inboxSessionDirOf(dataDir, SESSION), 'claims')
  return { session, reply, delivery, claims, rowReason }
}

const wakes = (session: ClaudeSession, words: string) => session.turns.filter((turn) => turn.text.includes(words))
const attempts = (session: ClaudeSession, words: string) => session.host.submits.filter((text) => text.includes(words))

describe('a session whose plugin prompts Claude Code refuses until the person types', () => {
  test.each([
    ['after a Stop', STOPPED_DROP_REASON],
    ['for any other reason', 'plugin input is held'],
  ])('%s: a reply waits, undelivered, until the person types; then it wakes the session once, and the next reply wakes it as usual', async (_when, reason) => {
    const { session, reply, delivery, claims, rowReason } = await world()
    await session.startTurn('Refactor the handler.')
    session.stop(reason)

    const first = await reply('k1', FIRST)
    await until('the wake to be tried', () => attempts(session, FIRST).length > 0)
    // Several ticks: Claude Code dropped it, so nothing says it went in, and nothing tries it again while input is held.
    await Bun.sleep(3_500)
    expect(wakes(session, FIRST)).toEqual([])
    expect(attempts(session, FIRST)).toHaveLength(1)
    expect(await delivery(first)).toBeNull()
    expect(session.host.toasts).toEqual([])
    // The claim was given back: nothing reported, nothing delivered.
    expect(existsSync(join(claims, first))).toBe(false)
    // The mod told the Inbox: the person's reply reads "Stopped", not Queued or Sending.
    await until('the row to read stopped', async () => (await rowReason()) === 'stopped')

    // The person types: their turn runs first, and the reply goes in at the idle after it.
    await session.type('Carry on.')
    await Bun.sleep(2_500)
    expect(wakes(session, FIRST)).toEqual([])
    // Their input lifted the hold: the reply waits on their turn as any reply does, no longer "Stopped".
    expect(await rowReason()).toBe('working')
    session.endTurn()
    await until('the wake', () => wakes(session, FIRST).length > 0)
    await until('the delivery', async () => (await delivery(first)) !== null)
    expect(await delivery(first)).toMatchObject({ session: SESSION })
    expect(await rowReason()).toBe('delivered')

    const second = await reply('k2', SECOND)
    await until('the next wake', () => wakes(session, SECOND).length > 0)
    await until('its delivery', async () => (await delivery(second)) !== null)
    expect(wakes(session, FIRST)).toHaveLength(1)
    expect(wakes(session, SECOND)).toHaveLength(1)
    // Nothing held any more: the next reply ends delivered too (the state event itself: inbox-held-state.test.ts).
    expect(await rowReason()).toBe('delivered')
  }, 40_000)
  // Review of #2780: the person typed while the dropped reply's claim was being given back. The hold set after that
  // release overwrote their input, and the reply waited for the NEXT input. Held first, their input clears it.
  test('the person types while the claim is given back: the reply still goes in at the idle after their turn, once', async () => {
    const { session, reply, delivery } = await world()
    await session.startTurn('Refactor the handler.')
    session.stop()
    let typed = false
    session.host.onRun = (argv) => {
      if (argv[3] !== 'plannotator-inbox-release' || typed) return
      typed = true
      void session.type('Carry on.')
    }

    const first = await reply('k1', FIRST)
    await until('the person to type during the release', () => typed && session.running !== null)
    await Bun.sleep(1_500)
    expect(wakes(session, FIRST)).toEqual([])
    session.endTurn()
    await until('the wake', () => wakes(session, FIRST).length > 0)
    await until('the delivery', async () => (await delivery(first)) !== null)
    await Bun.sleep(1_500)
    expect(wakes(session, FIRST)).toHaveLength(1)
    expect(attempts(session, FIRST)).toHaveLength(2)
  }, 40_000)
})
