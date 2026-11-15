import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { InboxThread } from '../../../../packages/core/inbox-types'
import { startInboxServer, type InboxServer } from '../../../../packages/server/inbox'
import { INBOX_WAKES_META_KEY } from '../../../../packages/shared/inbox/connection'
import { INBOX_BRIDGE_POLL_PATH } from './inbox-contract'
import { ClaudeSession } from './testing/claude-session'

const SESSION = 'session-take-back'
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

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-mod-take-back-')))
  roots.push(root)
  const project = join(root, 'api')
  mkdirSync(project, { recursive: true })
  const dataDir = join(root, 'data')
  const server = await startInboxServer({ dataDir, binaryPath: null })
  servers.push(server)
  const client = new Client({ name: 'mod-take-back', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)))
  clients.push(client)
  const base = `http://127.0.0.1:${server.port}/api/inbox`
  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) })
  const asked = (
    await client.callTool({
      name: 'send_message',
      arguments: { body: 'Which runner?', project_path: project, agent_session: SESSION, agent_host: 'claude-code', agent_name: 'Claude Code' },
      _meta: { [INBOX_WAKES_META_KEY]: true },
    })
  ).structuredContent as { message_id: string; thread_id: string }
  const reply = async (key: string, words: string) =>
    ((await (await post(`messages/${asked.message_id}/reply`, { idempotency_key: key, words })).json()) as { reply: { id: string } }).reply.id
  const takeBack = async (id: string) => {
    const response = await post(`messages/${id}/take-back`, {})
    const body = (await response.json()) as { by?: string }
    return { ok: response.status === 200, by: body.by ?? null }
  }
  const sendNow = async (id: string) => (await post(`messages/${id}/send-now`, {})).status
  const delivered = async (id: string) =>
    ((await (await fetch(`${base}/threads/${asked.thread_id}`)).json()) as { thread: InboxThread }).thread.messages.find((m) => m.id === id)?.delivery ?? null
  const open = async () => {
    const session = await ClaudeSession.start({ env: { PATH: process.env.PATH ?? '', PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir }, cwd: project, store: new Map(), sessionId: SESSION, dataDir })
    stops.push(() => session.quit())
    await until('it to poll', () => session.host.fetches.some((url) => url.includes(INBOX_BRIDGE_POLL_PATH)))
    return session
  }
  return { reply, takeBack, sendNow, delivered, open }
}

const took = (session: ClaudeSession, words: string) =>
  session.turns.some((turn) => turn.text.includes(words)) || session.host.submits.some((text) => text.includes(words)) || session.host.appended.some((text) => text.includes(words))

const isClaim = (argv: readonly string[], id: string) => argv.some((arg) => arg.endsWith(`/claims/${id}`)) && argv.some((arg) => arg.includes('mkdir "$d"'))

async function pressAt(point: 'last_ask' | 'claim' | 'submit', sendNow: boolean) {
  const w = await world()
  const session = await w.open()
  if (sendNow) await session.startTurn('a long tool call')
  let armed: string | null = null
  let result: { ok: boolean; by: string | null } | null = null
  const fire = async () => {
    const id = armed
    if (!id) return
    armed = null
    result = await w.takeBack(id)
  }
  const fetch0 = session.host.fetch
  session.host.fetch = async (url, init) => {
    const response = await fetch0(url, init)
    if (point === 'last_ask' && url.endsWith(INBOX_BRIDGE_POLL_PATH) && typeof init.body === 'string' && JSON.parse(init.body).waitMs === 0) await fire()
    return response
  }
  const run0 = session.host.run
  session.host.run = async (argv, init) => {
    if (point === 'claim' && armed && isClaim(argv, armed)) {
      const claimed = await run0(argv, init)
      await fire()
      return claimed
    }
    return run0(argv, init)
  }
  const submit0 = session.host.submit
  session.host.submit = async (text) => {
    if (point === 'submit') await fire()
    return submit0(text)
  }
  const append0 = session.host.appendUserRow!
  session.host.appendUserRow = async (text) => {
    if (point === 'submit') await fire()
    return append0(text)
  }
  const words = `Pressed at ${point}: use the ARM runner.`
  const id = await w.reply('k-t', words)
  armed = id
  if (sendNow) await until('send now accepted', async () => (await w.sendNow(id)) === 200, 5_000)
  await until('the press', () => result !== null, 10_000)
  await Bun.sleep(1_500)
  return { taken: result as unknown as { ok: boolean; by: string | null }, wentIn: took(session, words) }
}

describe('take back against the Claude Code mod', () => {
  for (const sendNow of [false, true]) {
    for (const point of ['last_ask', 'claim', 'submit'] as const) {
      test(`${sendNow ? 'Send now' : 'idle'}: a press right after the ${point} is refused and the words go in once`, async () => {
        const { taken, wentIn } = await pressAt(point, sendNow)
        expect(taken.ok).toBe(false)
        expect(wentIn).toBe(true)
      }, 60_000)
    }
  }

  test('a busy session: taken back, it never goes in; a second waiting reply is free once the first went in', async () => {
    const w = await world()
    const session = await w.open()
    await session.startTurn('a long tool call')
    const first = await w.reply('k-a', 'First words: ARM.')
    const second = await w.reply('k-b', 'Second words: x86.')
    const third = await w.reply('k-c', 'Third words: RISC-V.')
    await Bun.sleep(1_200)
    expect((await w.takeBack(first)).ok).toBe(true)
    session.holdPluginTurns = true
    session.endTurn()
    await until('the second words', () => took(session, 'Second words: x86.'))
    await until('its delivery', () => w.delivered(second))
    expect(await w.takeBack(third)).toEqual({ ok: true, by: null })
    await Bun.sleep(1_500)
    expect(took(session, 'First words: ARM.')).toBe(false)
    expect(took(session, 'Third words: RISC-V.')).toBe(false)
  }, 60_000)
})
