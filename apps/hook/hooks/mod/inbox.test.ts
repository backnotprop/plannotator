/**
 * The Claude Code connection to the Plannotator Inbox, proved against a REAL
 * Inbox: `plannotator inbox --background` under a temp data dir (the compiled
 * binary when PLANNOTATOR_INBOX_TEST_BINARY names one, as the Inbox e2e job
 * runs it; otherwise the CLI from source), the mod's own code on a Host of
 * real processes, HTTP and files (testing/claude-session.ts), and the
 * person's Send through the window's own route. No mocks.
 *
 * Set INBOX_PROOF_DIR to keep a transcript of each proof there.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inboxAgentTool, INBOX_WAKE_INSTRUCTION, inboxWakeText } from './inbox-contract'
import { ClaudeSession } from './testing/claude-session'

const entry = resolve(import.meta.dir, '../../server/index.ts')
const distDir = resolve(import.meta.dir, '../../dist')
const binary = process.env.PLANNOTATOR_INBOX_TEST_BINARY
const proofDir = process.env.INBOX_PROOF_DIR
let stubs: string[] = []
const roots: string[] = []
const sessions: ClaudeSession[] = []

beforeAll(() => {
  if (binary) return
  // The CLI from source imports the built HTML; the Inbox never serves it.
  stubs = ['index.html', 'review.html'].map((name) => join(distDir, name)).filter((path) => !existsSync(path))
  mkdirSync(distDir, { recursive: true })
  for (const path of stubs) writeFileSync(path, '<!doctype html><title>test</title>')
})
afterAll(() => {
  for (const path of stubs) rmSync(path, { force: true })
})
afterEach(() => {
  for (const session of sessions.splice(0)) session.quit()
  for (const root of roots.splice(0)) {
    const registry = join(root, 'home', '.plannotator', 'inbox', 'inbox.json')
    if (existsSync(registry)) {
      try {
        process.kill(JSON.parse(readFileSync(registry, 'utf8')).pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

interface World {
  root: string
  dataDir: string
  project: string
  browserMarker: string
  env: Record<string, string>
  store: Map<string, unknown>
  proof: (line: string) => void
}

function world(name: string): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-mod-')))
  roots.push(root)
  const home = join(root, 'home')
  const dataDir = join(home, '.plannotator')
  const project = join(root, 'refund-service')
  const bin = join(root, 'bin')
  mkdirSync(project, { recursive: true })
  mkdirSync(bin, { recursive: true })
  // `plannotator` on PATH, as the mod runs it.
  const plannotator = join(bin, 'plannotator')
  writeFileSync(plannotator, binary ? `#!/bin/sh\nexec '${binary}' "$@"\n` : `#!/bin/sh\nexec '${process.execPath}' '${entry}' "$@"\n`)
  chmodSync(plannotator, 0o755)
  const browserMarker = join(root, 'browser-opened')
  const browser = join(root, 'fake-browser.sh')
  writeFileSync(browser, `#!/bin/sh\necho "$1" >> '${browserMarker}'\n`)
  chmodSync(browser, 0o755)
  const proofFile = proofDir ? join(proofDir, `${name}.txt`) : null
  if (proofFile) {
    mkdirSync(proofDir!, { recursive: true })
    writeFileSync(proofFile, `# ${name}\n# Inbox: ${binary ? `compiled binary ${binary}` : 'CLI from source'}\n\n`)
  }
  return {
    root,
    dataDir,
    project,
    browserMarker,
    store: new Map(),
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: browser,
    },
    proof: (line) => {
      if (proofFile) appendFileSync(proofFile, `${line}\n`)
    },
  }
}

/** The person runs the Inbox once: `plannotator inbox --background` (no tab). */
function startInbox(w: World): { pid: number; port: number; url: string } {
  const run = Bun.spawnSync([join(w.root, 'bin', 'plannotator'), 'inbox', '--background'], { env: w.env, cwd: w.root })
  if (run.exitCode !== 0) throw new Error(`inbox --background failed: ${run.stderr.toString()}`)
  return registry(w)
}

function registry(w: World): { pid: number; port: number; url: string; token: string } {
  return JSON.parse(readFileSync(join(w.dataDir, 'inbox', 'inbox.json'), 'utf8'))
}

async function open(w: World, sessionId: string): Promise<ClaudeSession> {
  const session = await ClaudeSession.start({ env: w.env, cwd: w.project, store: w.store, sessionId, dataDir: w.dataDir })
  sessions.push(session)
  return session
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

interface ThreadMessage {
  id: string
  body: string
  author: { kind: string; session?: string | null; host?: string | null; name?: string | null }
  delivery?: { state: string; host: string; session: string; at: string } | null
}

async function thread(w: World, threadId: string): Promise<{ subject: string; project: { root: string }; messages: ThreadMessage[] }> {
  const response = await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${threadId}`)
  return ((await response.json()) as { thread: never }).thread
}

async function send(session: ClaudeSession, w: World, body: string): Promise<{ message_id: string; thread_id: string }> {
  const answer = await session.callInbox({ action: 'send_message', body }, w.project)
  if ('deny' in answer) throw new Error(answer.deny)
  w.proof(`> plannotator_inbox send_message (session ${session.sessionId})\n${answer.text}\n`)
  const structured = JSON.parse(answer.text.slice(answer.text.indexOf('{'))) as { message_id: string; thread_id: string }
  return structured
}

/** The person's Send, through the route the window posts to. */
async function personSends(w: World, messageId: string, words: string): Promise<string> {
  const { port } = registry(w)
  const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
  const response = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: `window-${messageId}-${words.length}`, words }),
  })
  expect(response.status).toBe(200)
  const reply = ((await response.json()) as { reply: { id: string; body: string } }).reply
  w.proof(`> the person presses Send in the Inbox window on ${messageId}\n${reply.body}\n`)
  return reply.id
}

const QUESTION = [
  'The refund webhook retries forever on a 409.',
  '',
  ':::question',
  'What should the worker do on a Stripe 409?',
  '',
  '- [ ] Retry with the same idempotency key',
  '- [ ] Fail the job and alert',
  ':::',
].join('\n')

describe('Claude Code ↔ Plannotator Inbox (real Inbox, real processes)', () => {
  test('no registry: no tool and nothing polls; once the Inbox ran, the tool carries exactly what its /mcp offers (an Inbox without record_decision has no such action)', async () => {
    const w = world('01-registry-and-tool-list')
    const silent = await open(w, 'session-silent')
    expect(silent.inboxTools).toBeNull()
    expect(silent.mod.inbox).toBeNull()
    await Bun.sleep(2_500)
    expect(silent.host.fetches).toEqual([])
    w.proof('no inbox/inbox.json: inboxTools null, no InboxLink, 0 HTTP requests in 2.5 s')

    startInbox(w)
    const session = await open(w, 'session-1')
    const names = session.inboxTools?.map((tool) => tool.name)
    expect(names).toEqual(['send_message', 'read_thread', 'wait_for_reply', 'resolve_message'])
    const spec = inboxAgentTool(session.inboxTools!)!
    const actions = (spec.inputSchema.properties as { action: { enum: string[] } }).action.enum
    expect(actions).toEqual(names!)
    expect(actions).not.toContain('record_decision')
    // The filled arguments never reach the agent's schema; the question guide rides `body`.
    const properties = Object.keys(spec.inputSchema.properties as object)
    for (const filled of ['project_path', 'agent_session', 'agent_host', 'agent_name']) expect(properties).not.toContain(filled)
    expect((spec.inputSchema.properties as { body: { description: string } }).body.description).toContain(':::question')
    expect(spec.description.length).toBeLessThan(2_048)
    w.proof(`registry present, Inbox running: plannotator_inbox actions = ${JSON.stringify(actions)}\n\n${spec.description}`)
  }, 60_000)

  test("send_message through the tool lands a thread in the session's project, signed by Claude Code and this session", async () => {
    const w = world('02-send-message')
    startInbox(w)
    const session = await open(w, 'session-send')
    const sent = await send(session, w, QUESTION)
    const t = await thread(w, sent.thread_id)
    expect(t.project.root).toBe(w.project)
    expect(t.subject).toBe('What should the worker do on a Stripe 409?')
    expect(t.messages[0]?.author).toMatchObject({ kind: 'agent', host: 'claude-code', name: 'Claude Code', session: 'session-send' })
    const bad = await session.callInbox({ action: 'send_message', body: 'x', agent_session: 'someone-else' }, w.project)
    expect('deny' in bad && bad.deny).toContain('takes no "agent_session"')
    w.proof(`thread ${sent.thread_id}: project ${t.project.root}, author ${JSON.stringify(t.messages[0]?.author)}`)
  }, 60_000)

  test("the person's Send reaches the asking session once, as a turn: the stable header, the fixed line, the reply verbatim; Delivered, then Replied", async () => {
    const w = world('03-send-wakes-the-session')
    startInbox(w)
    const session = await open(w, 'session-wake')
    const asked = await send(session, w, QUESTION)
    const words = 'Retry with the same key.\n\nAnd log the 409 body so we can see why.'
    const replyId = await personSends(w, asked.message_id, words)

    const turn = await waitFor('the wake turn', () => session.turns.find((t) => t.text.includes(replyId)))
    await Bun.sleep(3_000)
    expect(session.host.submits).toHaveLength(1)
    const text = session.host.submits[0]!
    const lines = text.split('\n')
    expect(lines[0]).toBe(`Plannotator Inbox: What should the worker do on a Stripe 409? (${replyId})`)
    expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION)
    const reply = (await thread(w, asked.thread_id)).messages.find((m) => m.id === replyId)!
    expect(text).toBe(inboxWakeText({ id: replyId, subject: 'What should the worker do on a Stripe 409?', body: reply.body }))
    expect(text.endsWith(reply.body)).toBe(true)
    expect(text).toContain(words)
    w.proof(`turn.start ${turn.id}:\n${turn.text}\n`)

    const delivered = await waitFor('the delivery record', async () => (await thread(w, asked.thread_id)).messages.find((m) => m.id === replyId)?.delivery)
    expect(delivered).toMatchObject({ state: 'delivered', host: 'claude-code', session: 'session-wake' })
    const list = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads`)).json()) as { sections: { id: string; threads: { thread_id: string; sent: { checked_at: string | null } | null }[] }[] }
    const row = list.sections.flatMap((s) => s.threads).find((r) => r.thread_id === asked.thread_id)
    expect(row?.sent?.checked_at).toBe(delivered.at)
    w.proof(`thread shows: Delivered to Claude Code, ${delivered.at} (reply.delivery ${JSON.stringify(delivered)})`)

    await send(session, w, 'Done: retries reuse the key and the 409 body is logged.')
    const after = await thread(w, asked.thread_id)
    expect(after.messages.at(-1)?.author).toMatchObject({ kind: 'agent', session: 'session-wake' })
    w.proof('thread shows: Replied (the asking session wrote after the delivered reply)')
    await Bun.sleep(2_500)
    expect(session.host.submits).toHaveLength(1)
  }, 90_000)

  test('a typed prompt goes first: a reply waits while the person works, and a prompt typed into the reply turn takes it over without a second delivery or an abort', async () => {
    const w = world('04-take-over')
    startInbox(w)
    const session = await open(w, 'session-busy')
    const asked = await send(session, w, QUESTION)

    await session.type('Refactor the webhook handler while you wait.')
    const replyId = await personSends(w, asked.message_id, 'Fail the job and alert.')
    await Bun.sleep(3_500)
    expect(session.host.submits).toEqual([])
    // Typed into the person's own running turn: still theirs, still waiting.
    await session.type('Also rename the file.')
    await Bun.sleep(1_500)
    expect(session.host.submits).toEqual([])
    w.proof('the person\'s turn runs: the reply waits in the mod (0 submits after 5 s)')
    session.endTurn()
    // At idle the person types again before the grace passed: that turn goes first.
    await session.type('One more thing: add a test.')
    await Bun.sleep(2_500)
    expect(session.host.submits).toEqual([])
    w.proof('the person typed at idle: their turn goes first (0 submits)')

    session.holdPluginTurns = true
    session.endTurn()
    const turn = await waitFor('the wake turn', () => session.turns.find((t) => t.text.includes(replyId)))
    // The person types into the reply's own turn: the rest of the turn is theirs.
    await session.type('Actually, hold off on that.')
    await Bun.sleep(2_500)
    session.endTurn()
    await Bun.sleep(2_500)
    expect(session.host.submits).toHaveLength(1)
    expect(session.host.aborted).toEqual([])
    const delivered = (await thread(w, asked.thread_id)).messages.find((m) => m.id === replyId)?.delivery
    expect(delivered?.state).toBe('delivered')
    w.proof(`reply turn ${turn.id} taken over by a typed prompt: 1 submit, 0 aborts, delivered once at ${delivered?.at}`)
  }, 90_000)

  test('/clear follows the new session id: a reply to the old session is not delivered into the new one, and the new session gets its own', async () => {
    const w = world('05-clear')
    startInbox(w)
    const session = await open(w, 'session-before-clear')
    const before = await send(session, w, 'Which branch should the hotfix go on?')
    session.clear('session-after-clear')
    const oldReply = await personSends(w, before.message_id, 'release/2.4')
    await Bun.sleep(4_000)
    expect(session.host.submits).toEqual([])
    w.proof(`after /clear: the reply ${oldReply} to session-before-clear is not delivered into session-after-clear`)

    const after = await send(session, w, 'Ship the hotfix now or after QA?')
    expect((await thread(w, after.thread_id)).messages[0]?.author.session).toBe('session-after-clear')
    const newReply = await personSends(w, after.message_id, 'After QA.')
    await waitFor('the new session\'s wake', () => session.host.submits.length === 1)
    expect(session.host.submits[0]).toContain(`(${newReply})`)
    // The old session's reply still waits for it on the Inbox (a resume gets it).
    const poll = await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/bridge/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${registry(w).token}` },
      body: JSON.stringify({ session: 'session-before-clear', waitMs: 0 }),
    })
    expect(((await poll.json()) as { commands: { id: string }[] }).commands.map((c) => c.id)).toEqual([oldReply])
    w.proof(`session-after-clear got only its own reply ${newReply}; ${oldReply} still waits for session-before-clear`)
  }, 90_000)

  test('two Claude Code processes on one session deliver each reply exactly once, in the process the person last worked in', async () => {
    const w = world('06-two-processes')
    startInbox(w)
    const first = await open(w, 'session-twice')
    const second = await open(w, 'session-twice')
    const asked = await send(first, w, QUESTION)
    const replyId = await personSends(w, asked.message_id, 'Retry with the same key.')
    await waitFor('one delivery', () => first.host.submits.length + second.host.submits.length >= 1)
    await Bun.sleep(4_000)
    expect(first.host.submits.length + second.host.submits.length).toBe(1)
    // The tool call in `first` made it the person's process.
    expect(first.host.submits).toHaveLength(1)
    w.proof(`reply ${replyId}: first ${first.host.submits.length}, second ${second.host.submits.length}`)

    // The person moves to the second process and types there: the next reply lands there, once.
    await second.type('Continue from here.')
    second.endTurn()
    const next = await send(second, w, 'And the 410 case?')
    await Bun.sleep(6_000)
    const nextReply = await personSends(w, next.message_id, 'Treat 410 as done.')
    await waitFor('the second delivery', () => first.host.submits.length + second.host.submits.length >= 2)
    await Bun.sleep(4_000)
    expect(first.host.submits).toHaveLength(1)
    expect(second.host.submits).toHaveLength(1)
    expect(second.host.submits[0]).toContain(`(${nextReply})`)
    w.proof(`reply ${nextReply} after the person moved to the second process: first ${first.host.submits.length}, second ${second.host.submits.length}`)
  }, 90_000)

  test('a dead Inbox is started detached by the first tool call, with no browser tab, and the message lands', async () => {
    const w = world('07-dead-inbox-started')
    const first = startInbox(w)
    const session = await open(w, 'session-dead')
    expect(session.inboxTools).not.toBeNull()
    process.kill(first.pid, 'SIGKILL')
    await waitFor('the Inbox to die', () => {
      try {
        process.kill(first.pid, 0)
        return false
      } catch {
        return true
      }
    })
    w.proof(`killed the Inbox (pid ${first.pid}); inbox.json stays`)

    const sent = await send(session, w, 'Is the staging deploy green?')
    const now = registry(w)
    expect(now.pid).not.toBe(first.pid)
    expect((await thread(w, sent.thread_id)).messages[0]?.body).toBe('Is the staging deploy green?')
    expect(existsSync(w.browserMarker)).toBe(false)
    w.proof(`the tool call started a new Inbox (pid ${now.pid}) through plannotator inbox --background; no browser opened`)

    // A new session whose Inbox is stopped still gets the tool, from the list the Inbox last offered.
    process.kill(now.pid, 'SIGKILL')
    await Bun.sleep(300)
    const later = await open(w, 'session-dead-2')
    expect(later.inboxTools?.map((tool) => tool.name)).toEqual(['send_message', 'read_thread', 'wait_for_reply', 'resolve_message'])
    w.proof('a session starting while the Inbox is stopped registers the tool from the list the Inbox last offered')
  }, 90_000)
})
