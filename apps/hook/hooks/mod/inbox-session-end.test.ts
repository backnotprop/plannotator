/**
 * An idle Claude Code session, a reply from the person, and a `session.end`
 * in between that leaves the process running. Seen live: a session idle after
 * an idle compaction got no Inbox reply until the person typed (the instance
 * was disposed and nothing made it again). A real Inbox in process, a running
 * `ClaudeSession`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startInboxServer, type InboxServer } from '../../../../packages/server/inbox'
import { INBOX_WAKES_META_KEY } from '../../../../packages/shared/inbox/connection'
import { ClaudeSession } from './testing/claude-session'

const SESSION = 'session-1'

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

/** The session asked in the Inbox and sits idle, polling. */
async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-mod-session-end-')))
  roots.push(root)
  const project = join(root, 'api')
  const home = join(root, 'home')
  mkdirSync(project, { recursive: true })
  mkdirSync(home, { recursive: true })
  const dataDir = join(home, '.plannotator')
  const server = await startInboxServer({ dataDir, binaryPath: null })
  servers.push(server)
  const client = new Client({ name: 'mod-session-end-test', version: '1.0.0' })
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
  const session = await ClaudeSession.start({ env: { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir }, cwd: project, store: new Map(), sessionId: SESSION, dataDir })
  sessions.push(session)
  await until('the session to poll', async () =>
    ((await (await fetch(`${base}/api/inbox/threads/${asked.thread_id}/sessions`)).json()) as { sessions: { session: string }[] }).sessions.some((s) => s.session === SESSION),
  )
  /** The person's Send, through the route the window posts to. */
  const reply = async (words: string) =>
    (
      (await (
        await fetch(`${base}/api/inbox/messages/${asked.message_id}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k-${words.length}`, words }),
        })
      ).json()) as { reply: { id: string } }
    ).reply.id
  const delivery = async (id: string) =>
    ((await (await fetch(`${base}/api/inbox/threads/${asked.thread_id}`)).json()) as { thread: { messages: { id: string; delivery?: { state: string; session: string } }[] } }).thread.messages.find(
      (m) => m.id === id,
    )?.delivery
  const woke = (id: string) => session.turns.filter((turn) => turn.text.includes(id))
  return { session, reply, delivery, woke }
}

describe('session.end while the session goes on', () => {
  test("another session's end (a fork, a side session, a subagent) leaves the instance polling: the person's reply wakes the idle session", async () => {
    const w = await world()
    w.session.endSession('fork-1')
    w.session.endSession(SESSION, 'agent-7')

    const id = await w.reply('Use the ARM runner.')
    await until('the wake turn', () => w.woke(id).length > 0, 10_000)
    expect(w.session.mod.isDisposed).toBe(false)
    await until('the delivery', async () => (await w.delivery(id))?.state === 'delivered')
    expect(await w.delivery(id)).toMatchObject({ state: 'delivered', session: SESSION })
    await Bun.sleep(2_000)
    expect(w.woke(id)).toHaveLength(1)
  }, 40_000)

  test('the instance disposed with the session still there: the self-heal makes it again and the waiting reply goes in, once', async () => {
    const w = await world()
    // This session's own end, and the process goes on: nothing polls the Inbox now.
    expect(w.session.endSession(SESSION)).toBe(true)
    const id = await w.reply('Use the ARM runner.')
    await Bun.sleep(2_500)
    expect(w.woke(id)).toHaveLength(0)

    w.session.startSelfHeal(300)
    await until('the wake turn', () => w.woke(id).length > 0, 10_000)
    expect(w.session.mod.isDisposed).toBe(false)
    await until('the delivery', async () => (await w.delivery(id))?.state === 'delivered')
    await Bun.sleep(2_000)
    expect(w.woke(id)).toHaveLength(1)
  }, 40_000)
})
