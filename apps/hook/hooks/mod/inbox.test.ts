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
import { inboxAckLine, inboxAgentTool, inboxSentNowFollowUpText, INBOX_MESSAGE_INSTRUCTION, INBOX_NAME_THREAD_LINE, INBOX_NEW_THREAD_INSTRUCTION, INBOX_TOOL_ACTIONS, INBOX_WAKE_INSTRUCTION, INBOX_TAGGED_INSTRUCTION, inboxAlsoTaggedLine, inboxRedirectedLine, inboxTaggedLine, inboxWakeText, mcpAnswerOf } from './inbox-contract'
import { CLAUDE_INBOX_TOOL_NAME, ClaudeSession } from './testing/claude-session'
import { removeStubbedHtml, stubBuiltHtml } from '../../../../tests/helpers/inbox-world'
import { inboxEntryOf, isAlive, mustSignalInbox, stopProvenInboxes } from '../../../../tests/helpers/inbox-process'
import { INBOX_DISCOVER_TIMEOUT_MS, STORE_INBOX_TOOLS } from './inbox'

const entry = resolve(import.meta.dir, '../../server/index.ts')
const binary = process.env.PLANNOTATOR_INBOX_TEST_BINARY
const proofDir = process.env.INBOX_PROOF_DIR
let stubs: string[] = []
const roots: string[] = []
const sessions: ClaudeSession[] = []

beforeAll(() => {
  // The CLI from source imports the built HTML; the Inbox never serves it.
  stubs = stubBuiltHtml()
})
afterAll(() => {
  removeStubbedHtml(stubs)
})
afterEach(async () => {
  for (const session of sessions.splice(0)) session.quit()
  for (const root of roots.splice(0)) {
    // Only an Inbox proven to be the one this world started (tests/helpers/inbox-process.ts).
    const entry = inboxEntryOf(join(root, 'home', '.plannotator'))
    if (entry) await stopProvenInboxes([{ entry, root }], { signal: 'SIGKILL' })
    rmSync(root, { recursive: true, force: true })
  }
})

/** SIGKILL the world's Inbox, once proven to be the one it started, and wait for it to die. */
async function killInbox(w: World): Promise<number> {
  const { pid } = await mustSignalInbox(inboxEntryOf(w.dataDir), w.root, 'SIGKILL')
  await waitFor('the Inbox to die', () => !isAlive(pid))
  return pid
}

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

async function thread(w: World, threadId: string): Promise<{ subject: string; thread_name: string | null; project: { root: string }; messages: ThreadMessage[] }> {
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
  test('no registry: the tool from the bundled list, nothing polls or writes, and the first call starts the Inbox; once the Inbox ran, the tool carries exactly what its /mcp offers', async () => {
    const w = world('01-registry-and-tool-list')
    const silent = await open(w, 'session-silent')
    // Before this computer ever ran the Inbox: the list bundled with the mod (pinned to a real Inbox by inbox-default-tools.test.ts).
    expect(silent.inboxTools?.map((tool) => tool.name)).toEqual(INBOX_TOOL_ACTIONS.filter((name) => name !== 'card'))
    expect(silent.mod.inbox).not.toBeNull()
    await Bun.sleep(2_500)
    expect(silent.host.fetches).toEqual([])
    expect(existsSync(join(w.dataDir, 'claude-code-mod', 'session-silent', 'inbox'))).toBe(false)
    expect(existsSync(join(w.dataDir, 'inbox'))).toBe(false)
    w.proof('no inbox/inbox.json: plannotator_inbox from the bundled list, 0 HTTP requests and no files in 2.5 s')

    // The first call starts the Inbox (plannotator inbox --background, no tab) and the message lands.
    const first = await send(silent, w, 'Is the staging deploy green?')
    expect((await thread(w, first.thread_id)).messages[0]?.author).toMatchObject({ host: 'claude-code', session: 'session-silent' })
    expect(existsSync(w.browserMarker)).toBe(false)
    // And from then on the wake polls this session's replies.
    await waitFor('the wake to poll the new Inbox', () => silent.host.fetches.some((url) => url.endsWith('/api/inbox/bridge/poll')))
    w.proof(`the first call started the Inbox (pid ${registry(w).pid}) and landed thread ${first.thread_id}; the wake polls it now`)
    silent.quit()
    const session = await open(w, 'session-1')
    const names = session.inboxTools?.map((tool) => tool.name)
    // What this Inbox's /mcp lists, asked directly: the tool carries exactly those it can (an older
    // Inbox without submit_guide gets no such action: the engine harness proves that case).
    const listed = await fetch(`http://127.0.0.1:${registry(w).port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const offered = mcpAnswerOf(await listed.text())?.result as { tools: { name: string }[] }
    expect(names).toEqual(INBOX_TOOL_ACTIONS.filter((action) => offered.tools.some((tool) => tool.name === action)))
    expect(names).toContain('submit_guide')
    expect(names).not.toContain('record_decision')
    const spec = inboxAgentTool(session.inboxTools!)!
    const actions = (spec.inputSchema.properties as { action: { enum: string[] } }).action.enum
    expect(actions).toEqual(names!)
    // The filled arguments never reach the agent's schema, except an optional project_path; the question guide rides `body`.
    const properties = Object.keys(spec.inputSchema.properties as object)
    for (const filled of ['agent_session', 'agent_host', 'agent_name']) expect(properties).not.toContain(filled)
    expect(properties).toContain('project_path')
    expect(spec.inputSchema.required).toEqual(['action'])
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
    // The mod's wake delivers the reply as a turn: the result says to end the turn, never to wait.
    const next = await session.callInbox({ action: 'send_message', body: 'A second note.' }, w.project)
    expect('text' in next && next.text).toContain('arrives in this session by itself')
    expect('text' in next && next.text).not.toContain('wait_for_reply with this thread_id')
    w.proof(`thread ${sent.thread_id}: project ${t.project.root}, author ${JSON.stringify(t.messages[0]?.author)}`)
  }, 60_000)

  test('a long thread through the tool: read_thread answers a windowed transcript as text alone (no JSON after it), and search finds a message by its words', async () => {
    const w = world('02b-long-thread')
    startInbox(w)
    const session = await open(w, 'session-long')
    const first = await send(session, w, `Round 1: the queue drains in order.\n\n${QUESTION}`)
    let last = first.message_id
    for (let round = 2; round <= 20; round++) {
      const reply = await personSends(w, last, `Round ${round - 1}: go ahead.`)
      const answer = await session.callInbox({ action: 'send_message', reply_to: reply, body: `Round ${round}: the queue drains in order.${round === 13 ? ' The flamingo budget is set.' : ''}` }, w.project)
      if ('deny' in answer) throw new Error(answer.deny)
      last = JSON.parse(answer.text.slice(answer.text.indexOf('{'))).message_id
    }
    const read = await session.callInbox({ action: 'read_thread', thread_id: first.thread_id }, w.project)
    if ('deny' in read) throw new Error(read.deny)
    expect(read.text.split('\n')[0]).toStartWith(`Thread ${first.thread_id} (What should the worker do on a Stripe 409?): 39 messages, 19 from the person.`)
    // The transcript is complete: the connection hands it over without the JSON.
    expect(read.text).not.toContain('{"thread"')
    expect(read.text).toContain(`- ${first.message_id} · Claude Code · `)
    expect(read.text).toContain(`Q1 `)
    expect(read.text).toMatch(/\nCursor \d+: read_thread after: \d+ returns only what is new since this read\.$/)
    expect(Buffer.byteLength(read.text)).toBeLessThan(12_000)
    const found = await session.callInbox({ action: 'search', query: 'flamingo' }, w.project)
    if ('deny' in found) throw new Error(found.deny)
    expect(found.text.split('\n')[0]).toBe('1 message matches "flamingo" in refund-service:')
    expect(found.text).not.toContain('{"query"')
    w.proof(`> plannotator_inbox read_thread (39 messages)\n${read.text}\n\n> plannotator_inbox search flamingo\n${found.text}`)
  }, 120_000)

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
    expect(text).toBe(inboxWakeText({ id: replyId, thread_id: asked.thread_id, subject: 'What should the worker do on a Stripe 409?', body: reply.body }, CLAUDE_INBOX_TOOL_NAME))
    // The closing line names the thread and the tool by the full name the engine registered.
    expect(lines.at(-1)).toBe(`[thread ${asked.thread_id} · more: mcp__plannotator__plannotator_inbox read_thread · how it works: plannotator inbox --help]`)
    // The body sits whole above the closing line, after the first lines.
    expect(text.endsWith(`\n\n${reply.body}\n\n${lines.at(-1)}`)).toBe(true)
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

  test("the person's 👍 Looks good reaches the session once, after the Undo window, as one short turn naming the message; the window says Delivered", async () => {
    const w = world('12-looks-good-wakes-the-session')
    startInbox(w)
    const session = await open(w, 'session-ack')
    const sent = await send(session, w, 'Merged the refund fix. CI is green on main; nothing needs you here.')
    const { port } = registry(w)
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
    const pressed = Date.now()
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${sent.message_id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ serverSession: health.serverSession }),
    })
    expect(response.status).toBe(200)
    w.proof(`> the person presses 👍 Looks good in the Inbox window on ${sent.message_id}`)

    const turn = await waitFor('the 👍 turn', () => session.turns.find((t) => t.text.includes(inboxAckLine(sent.message_id))), 40_000)
    // Not before the Undo window (10 s) passed.
    expect(Date.now() - pressed).toBeGreaterThanOrEqual(9_500)
    await Bun.sleep(3_000)
    expect(session.host.submits).toHaveLength(1)
    const text = session.host.submits[0]!
    const lines = text.split('\n')
    expect(lines).toHaveLength(4)
    // The 👍 closes with its thread alone.
    expect(lines.slice(2)).toEqual(['', `[thread ${sent.thread_id}]`])
    const noteId = /\((msg_[0-9A-Z]+)\)$/.exec(lines[0]!)![1]!
    const subject = (await thread(w, sent.thread_id)).subject
    expect(lines[0]).toBe(`Plannotator Inbox: ${subject} (${noteId})`)
    expect(lines[1]).toBe(`The person marked your message 👍 Looks good (${sent.message_id}). No reply needed unless you have a question.`)
    expect(text).toBe(inboxWakeText({ id: noteId, thread_id: sent.thread_id, subject, body: lines[1]!, ack_of: sent.message_id }, CLAUDE_INBOX_TOOL_NAME))
    w.proof(`turn.start ${turn.id}:\n${turn.text}\n`)

    const ack = await waitFor('the delivered 👍', async () => {
      const message = (await thread(w, sent.thread_id)).messages.find((m) => m.id === sent.message_id) as ThreadMessage & { ack?: { delivered_at?: string | null } }
      return message.ack?.delivered_at ? message.ack : null
    })
    // The note that carried it is not a message of the thread.
    expect((await thread(w, sent.thread_id)).messages.map((m) => m.id)).toEqual([sent.message_id])
    w.proof(`thread shows: 👍 Looks good · Delivered to Claude Code, ${ack.delivered_at}`)
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

  test("the agent's answer to a wake lands in the same thread: send_message with reply_to set to the id the wake's first line names (a named thread too)", async () => {
    const w = world('08-answer-after-wake')
    startInbox(w)
    const session = await open(w, 'session-answer')
    const asked = await session.callInbox({ action: 'send_message', body: QUESTION, thread: 'refund-webhooks' }, w.project)
    if ('deny' in asked) throw new Error(asked.deny)
    const sent = JSON.parse(asked.text.slice(asked.text.indexOf('{'))) as { message_id: string; thread_id: string }
    w.proof(`> plannotator_inbox send_message thread "refund-webhooks"\n${asked.text}\n`)
    const replyId = await personSends(w, sent.message_id, 'Retry with the same key.')
    await waitFor('the wake turn', () => session.host.submits.length === 1)
    const wake = session.host.submits[0]!
    // What the fixed line tells the agent to do, read from the turn as the agent reads it.
    const header = /^Plannotator Inbox: .* \((msg_[0-9A-Z]+)\)$/.exec(wake.split('\n')[0]!)
    expect(header?.[1]).toBe(replyId)
    expect(wake.split('\n')[1]).toContain('reply_to set to the id in parentheses on the line above')
    const answer = await session.callInbox({ action: 'send_message', reply_to: header![1], body: 'Done: retries reuse the key.' }, w.project)
    if ('deny' in answer) throw new Error(answer.deny)
    const answered = JSON.parse(answer.text.slice(answer.text.indexOf('{'))) as { thread_id: string; new_thread: boolean }
    expect(answered.thread_id).toBe(sent.thread_id)
    expect(answered.new_thread).toBe(false)
    const t = await thread(w, sent.thread_id)
    expect(t.messages.map((m) => m.author.kind)).toEqual(['agent', 'person', 'agent'])
    w.proof(`wake line 1: ${wake.split('\n')[0]}\n> plannotator_inbox send_message reply_to ${header![1]}\nlanded in ${answered.thread_id} (the asked thread ${sent.thread_id}), new_thread ${answered.new_thread}`)
    // Why the line says reply_to: without it the answer would start another thread.
    const loose = await session.callInbox({ action: 'send_message', body: 'An answer without reply_to.' }, w.project)
    if ('deny' in loose) throw new Error(loose.deny)
    expect((JSON.parse(loose.text.slice(loose.text.indexOf('{'))) as { thread_id: string }).thread_id).not.toBe(sent.thread_id)
    w.proof('the same answer without reply_to lands in a different thread')
  }, 90_000)

  test('a dead Inbox is started detached by the first tool call, with no browser tab, and the message lands', async () => {
    const w = world('07-dead-inbox-started')
    const first = startInbox(w)
    const session = await open(w, 'session-dead')
    expect(session.inboxTools).not.toBeNull()
    expect(await killInbox(w)).toBe(first.pid)
    w.proof(`killed the Inbox (pid ${first.pid}); inbox.json stays`)

    const sent = await send(session, w, 'Is the staging deploy green?')
    const now = registry(w)
    expect(now.pid).not.toBe(first.pid)
    expect((await thread(w, sent.thread_id)).messages[0]?.body).toBe('Is the staging deploy green?')
    expect(existsSync(w.browserMarker)).toBe(false)
    w.proof(`the tool call started a new Inbox (pid ${now.pid}) through plannotator inbox --background; no browser opened`)

    // A new session whose Inbox is stopped still gets the tool, from the list the Inbox last offered.
    expect(await killInbox(w)).toBe(now.pid)
    const later = await open(w, 'session-dead-2')
    expect(later.inboxTools?.map((tool) => tool.name)).toEqual(session.inboxTools?.map((tool) => tool.name))
    w.proof('a session starting while the Inbox is stopped registers the tool from the list the Inbox last offered')
  }, 90_000)

  test("project_path names the project for a session working in another folder; a bad one is refused before the Inbox is reached", async () => {
    const w = world('07b-project-path')
    const first = startInbox(w)
    const notes = join(w.root, 'meeting-notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(w.project, 'replay.sh'), '#!/bin/sh\necho replay\n')
    const session = await open(w, 'session-notes')

    const named = await session.callInbox({ action: 'send_message', body: 'The script I ran.', project_path: '../refund-service', attachments: ['replay.sh'] }, notes)
    if ('deny' in named) throw new Error(named.deny)
    const sent = JSON.parse(named.text.slice(named.text.indexOf('{'))) as { thread_id: string; attachments: { kind: string }[] }
    expect((await thread(w, sent.thread_id)).project.root).toBe(w.project)
    expect(sent.attachments[0]?.kind).toBe('code')
    // Without it, the session's own project (where it started), wherever the shell stands; a relative attachment is
    // still the file in the folder the agent works in.
    writeFileSync(join(notes, 'minutes.md'), '# Minutes\n')
    const plain = await session.callInbox({ action: 'send_message', body: 'From the notes folder.', attachments: ['minutes.md'] }, notes)
    if ('deny' in plain) throw new Error(plain.deny)
    const plainSent = JSON.parse(plain.text.slice(plain.text.indexOf('{'))) as { thread_id: string; attachments: { name: string; kind: string }[] }
    expect((await thread(w, plainSent.thread_id)).project.root).toBe(w.project)
    expect(plainSent.attachments.map((a) => [a.name, a.kind])).toEqual([['minutes.md', 'markdown']])
    w.proof(`project_path "../refund-service" from ${notes} landed in ${w.project}; without it, also in ${w.project} (the session's folder), with notes/minutes.md attached`)

    expect(await killInbox(w)).toBe(first.pid)
    for (const bad of ['../missing', join(w.project, 'replay.sh'), 'two\nlines']) {
      const refused = await session.callInbox({ action: 'send_message', body: 'x', project_path: bad }, notes)
      expect('deny' in refused && refused.deny, bad).toContain('project_path')
    }
    // Nothing started the stopped Inbox: the registry still names the dead one.
    expect(registry(w).pid).toBe(first.pid)
  }, 60_000)

  // The failure this guards: the person's first prompt waits for session.start,
  // and `$.http.fetch` gives up only after 30 s, so an Inbox that accepts and
  // never answers (stopped with Ctrl-Z, a port another server holds) held every
  // Claude Code start for 30 s.
  test('a wedged Inbox (accepts, never answers) does not hold session start: the list it last offered stands within the bound', async () => {
    const w = world('08-wedged-inbox')
    const wedged = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const registryPath = join(w.dataDir, 'inbox', 'inbox.json')
    // A pid that has exited: afterEach kills whatever pid the registry names.
    const exited = Bun.spawnSync(['true']).pid
    try {
      mkdirSync(join(w.dataDir, 'inbox'), { recursive: true })
      writeFileSync(
        registryPath,
        JSON.stringify({ v: 1, pid: exited, port: wedged.port, token: 'x'.repeat(32), serverSession: 'wedged', url: `http://127.0.0.1:${wedged.port}/` }),
      )
      const remembered = [{ name: 'send_message', description: 'Send.', inputSchema: { type: 'object', properties: { body: { type: 'string' } } } }]
      w.store.set(STORE_INBOX_TOOLS, { tools: remembered })
      const started = Date.now()
      const session = await open(w, 'session-wedged')
      const took = Date.now() - started
      expect(session.inboxTools?.map((tool) => tool.name)).toEqual(['send_message'])
      expect(took).toBeLessThan(INBOX_DISCOVER_TIMEOUT_MS + 2_000)
      w.proof(`registry names a port that accepts and never answers: session start took ${took} ms and kept the remembered list`)
    } finally {
      rmSync(registryPath, { force: true })
      wedged.stop(true)
    }
  }, 20_000)
  // Plan step 8, record 5.x: New message. The failure this guards: the person
  // writes to a live session of the project and it never arrives, arrives
  // twice, or lands in a session the person did not pick.
  test('New message: the polls make both sessions of the project live (the writer first); the message reaches the picked session once, as a turn; a gone session is refused', async () => {
    const w = world('09-new-message')
    startInbox(w)
    const writer = await open(w, 'session-writer')
    const asked = await send(writer, w, 'Run finished. The export now streams rows to the file.')
    const other = await open(w, 'session-other')
    const { port } = registry(w)
    const live = await waitFor('both sessions live', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/threads/${asked.thread_id}/sessions`)).json()) as {
        sessions: { session: string; host: string; busy: boolean | null; wrote_thread: boolean }[]
      }
      return model.sessions.length === 2 ? model.sessions : null
    })
    expect(live.map((s) => [s.session, s.host, s.wrote_thread, s.busy])).toEqual([
      ['session-writer', 'claude-code', true, false],
      ['session-other', 'claude-code', false, false],
    ])
    w.proof(`live sessions of the thread's project, from the mod's polls (project_path = ${w.project}):\n${JSON.stringify(live, null, 2)}\n`)

    const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
    const post = (session: string, body: string, key: string) =>
      fetch(`http://127.0.0.1:${port}/api/inbox/threads/${asked.thread_id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ serverSession: health.serverSession, session, body, idempotency_key: key }),
      })
    const words = 'While you are in there, add a header row to the CSV export.'
    // The writer waits on the thread while the person picks the other session (review blocker B1, PR 1764).
    const writerWait = writer.callInbox({ action: 'wait_for_reply', thread_id: asked.thread_id, timeout_seconds: 8 }, w.project)
    await Bun.sleep(500)
    const response = await post('session-other', words, 'nm-1')
    expect(response.status).toBe(200)
    const message = ((await response.json()) as { message: { id: string; to: unknown; reply_to: unknown } }).message
    expect(message).toMatchObject({ reply_to: null, to: { host: 'claude-code', session: 'session-other' } })
    // A double press of Send writes nothing new.
    expect(((await (await post('session-other', words, 'nm-1')).json()) as { replayed: boolean; message: { id: string } })).toMatchObject({ replayed: true, message: { id: message.id } })

    const turn = await waitFor('the New message turn', () => other.turns.find((t) => t.text.includes(message.id)))
    await Bun.sleep(3_000)
    expect(other.host.submits).toEqual([inboxWakeText({ type: 'message', id: message.id, thread_id: asked.thread_id, subject: 'Run finished. The export now streams rows to the file.', body: words }, CLAUDE_INBOX_TOOL_NAME)])
    const lines = other.host.submits[0]!.split('\n')
    expect(lines[0]).toBe(`Plannotator Inbox: Run finished. The export now streams rows to the file. (${message.id})`)
    expect(lines[1]).toBe(INBOX_MESSAGE_INSTRUCTION)
    expect(other.host.submits[0]!.endsWith(`\n\n${words}\n\n[thread ${asked.thread_id} · more: ${CLAUDE_INBOX_TOOL_NAME} read_thread · how it works: plannotator inbox --help]`)).toBe(true)
    expect(writer.host.submits).toEqual([])
    const waited = await writerWait
    // The wait's text is complete (the Inbox marks it), so the mod hands the model the text alone.
    expect('text' in waited && waited.text).toStartWith('No reply yet.')
    expect('text' in waited && waited.text).not.toContain('"status"')
    w.proof(`session-writer's wait_for_reply on the same thread kept waiting: ${('text' in waited ? waited.text : waited.deny).split('\n')[0]}`)
    w.proof(`turn.start ${turn.id} in session-other:\n${turn.text}\n\nsession-writer submits: ${writer.host.submits.length}`)

    const delivered = await waitFor('the delivery record', async () => (await thread(w, asked.thread_id)).messages.find((m) => m.id === message.id)?.delivery)
    expect(delivered).toMatchObject({ state: 'delivered', host: 'claude-code', session: 'session-other' })
    w.proof(`thread shows: Delivered to Claude Code, ${delivered.at}`)

    // The wake's fixed line asks for reply_to set to the id it names: that answer lands in the same thread.
    const answer = await other.callInbox({ action: 'send_message', body: 'Added the header row.', reply_to: message.id }, w.project)
    if ('deny' in answer) throw new Error(answer.deny)
    expect((await thread(w, asked.thread_id)).messages.at(-1)).toMatchObject({ body: 'Added the header row.', author: { kind: 'agent', session: 'session-other' } })
    w.proof('session-other answered with reply_to the id in the wake: the answer is the last message of the same thread')

    // The picked session quits: it is not live once its last poll is 30 s old,
    // and a message to it is refused, nothing written.
    other.quit()
    const before = (await thread(w, asked.thread_id)).messages.length
    await waitFor('session-other no longer live', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/threads/${asked.thread_id}/sessions`)).json()) as { sessions: { session: string }[] }
      return model.sessions.every((s) => s.session !== 'session-other') ? true : null
    }, 60_000)
    const refused = await post('session-other', 'Are you there?', 'nm-2')
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { code: string }).code).toBe('session_not_live')
    expect((await thread(w, asked.thread_id)).messages).toHaveLength(before)
    w.proof('session-other quit: gone from the live list after 30 s; a New message to it answers 409 session_not_live and writes nothing')
  }, 120_000)

  test('the asking session ended and the person sent the reply to another live session: that session is woken once, with the line saying the asker ended; the asker is not', async () => {
    const w = world('10-ended-session-reply')
    startInbox(w)
    const asker = await open(w, 'session-asker')
    const asked = await send(asker, w, QUESTION)
    asker.quit()
    const taker = await open(w, 'session-taker')
    const { port } = registry(w)
    await waitFor('the other session live', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/threads/${asked.thread_id}/sessions`)).json()) as { sessions: { session: string }[] }
      return model.sessions.some((s) => s.session === 'session-taker') ? true : null
    })
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
    const words = 'Retry with the same key.'
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${asked.message_id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: 'ended-1', words, to: { host: 'claude-code', session: 'session-taker' } }),
    })
    expect(response.status).toBe(200)
    const reply = ((await response.json()) as { reply: { id: string; body: string } }).reply
    w.proof(`> the person picks session-taker at Send (session-asker has ended)\n${reply.body}\n`)

    const turn = await waitFor('the redirected reply turn', () => taker.turns.find((t) => t.text.includes(reply.id)))
    await Bun.sleep(3_000)
    expect(taker.host.submits).toEqual([
      inboxWakeText({ id: reply.id, subject: 'What should the worker do on a Stripe 409?', thread_id: asked.thread_id, body: reply.body, redirected_from: 'Claude Code' }, CLAUDE_INBOX_TOOL_NAME),
    ])
    const lines = taker.host.submits[0]!.split('\n')
    expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION)
    expect(lines[2]).toBe(inboxRedirectedLine('Claude Code', reply.id))
    expect(asker.host.submits).toEqual([])
    w.proof(`turn.start ${turn.id} in session-taker:\n${turn.text}`)

    const delivered = await waitFor('the delivery record', async () => (await thread(w, asked.thread_id)).messages.find((m) => m.id === reply.id)?.delivery)
    expect(delivered).toMatchObject({ state: 'delivered', host: 'claude-code', session: 'session-taker' })
    w.proof(`thread shows: Delivered to Claude Code (another session), ${delivered.at}`)
  }, 120_000)

  test("tags: the person tags another live session in the owner's reply; each is woken once, the owner told who else got it, the tagged one told to read the thread first; the tagged one's read never swallows the owner's wake", async () => {
    const w = world('10b-tagged-sessions')
    startInbox(w)
    const owner = await open(w, 'session-owner')
    const asked = await send(owner, w, QUESTION)
    const tagged = await open(w, 'session-tagged')
    const { port } = registry(w)
    // The mod says it understands tags: the window offers the session.
    await waitFor('the tagged session taggable', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/threads/${asked.thread_id}/taggable`)).json()) as { sessions: { session: string; taggable: boolean }[] }
      return model.sessions.some((s) => s.session === 'session-tagged' && s.taggable) ? true : null
    })
    // The owner is busy, so its wake waits; the tagged session reads the thread first meanwhile (as its wake will tell it).
    await owner.startTurn('Refactor the webhook handler.')
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${asked.message_id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({
        serverSession: health.serverSession,
        idempotency_key: 'tag-1',
        words: 'Retry with the same key. @Claude Code (another session) add a test for the 409 path.',
        tags: [{ host: 'claude-code', session: 'session-tagged', label: 'Claude Code (another session)' }],
      }),
    })
    expect(response.status).toBe(200)
    const reply = ((await response.json()) as { reply: { id: string; body: string } }).reply
    w.proof(`> the person tags session-tagged in the reply to session-owner\n${reply.body}\n`)

    const tagTurn = await waitFor('the tagged turn', () => tagged.turns.find((t) => t.text.includes(reply.id)))
    expect(tagged.host.submits).toEqual([
      inboxWakeText({ id: reply.id, subject: 'What should the worker do on a Stripe 409?', thread_id: asked.thread_id, body: reply.body, tagged: { owner: 'Claude Code' } }, CLAUDE_INBOX_TOOL_NAME),
    ])
    const tagLines = tagged.host.submits[0]!.split('\n')
    expect(tagLines[1]).toBe(INBOX_TAGGED_INSTRUCTION)
    expect(tagLines[2]).toBe(inboxTaggedLine('Claude Code', reply.id))
    w.proof(`turn.start ${tagTurn.id} in session-tagged:\n${tagTurn.text}`)
    // It reads the thread, as told, before the owner's turn ends.
    const read = await tagged.callInbox({ action: 'read_thread', message_id: reply.id }, w.project)
    expect('deny' in read).toBe(false)

    expect(owner.host.submits).toEqual([])
    await owner.endTurn('Done.')
    const ownerTurn = await waitFor('the owner turn', () => owner.turns.find((t) => t.text.includes(reply.id)))
    await Bun.sleep(3_000)
    expect(owner.host.submits).toEqual([
      inboxWakeText({ id: reply.id, subject: 'What should the worker do on a Stripe 409?', thread_id: asked.thread_id, body: reply.body, also_tagged: ['Claude Code'] }, CLAUDE_INBOX_TOOL_NAME),
    ])
    expect(owner.host.submits[0]!.split('\n')[2]).toBe(inboxAlsoTaggedLine(['Claude Code']))
    // Each woken once, no more.
    expect(tagged.host.submits).toHaveLength(1)
    w.proof(`turn.start ${ownerTurn.id} in session-owner:\n${ownerTurn.text}`)

    const message = await waitFor('both deliveries', async () => {
      const found = (await thread(w, asked.thread_id)).messages.find((m) => m.id === reply.id) as ThreadMessage & { tags?: { delivery?: { session: string } | null }[] }
      return found?.delivery && found.tags?.[0]?.delivery ? found : null
    })
    expect(message.delivery).toMatchObject({ session: 'session-owner' })
    expect(message.tags?.[0]?.delivery).toMatchObject({ session: 'session-tagged' })
    w.proof(`thread shows: Delivered to Claude Code; Delivered to Claude Code (another session)`)
  }, 120_000)

  test('compose: the person starts a thread with a session that never wrote in the Inbox; it arrives once as a new-thread turn, the answer lands in that thread, and the session\'s next message starts its own', async () => {
    const w = world('11-compose-new-thread')
    startInbox(w)
    const session = await open(w, 'session-compose')
    const { port } = registry(w)
    // The mod's poll says where it works: listed under the project before it ever wrote.
    const listed = await waitFor('the session in the live list', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/sessions`)).json()) as {
        projects: { project: { id: string | null; root: string }; sessions: { session: string; host: string; busy: boolean | null }[] }[]
      }
      return model.projects.find((group) => group.project.root === w.project && group.sessions.some((s) => s.session === 'session-compose')) ?? null
    })
    expect(listed.project.id).toBeNull()
    w.proof(`live sessions in every project (GET /api/inbox/sessions):\n${JSON.stringify(listed, null, 2)}\n`)

    const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
    const words = 'Idea: show which session wrote each thread.\n\nA small chip on each row would do.'
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ serverSession: health.serverSession, to: { host: 'claude-code', session: 'session-compose' }, body: words, idempotency_key: 'compose-1' }),
    })
    expect(response.status).toBe(200)
    const message = ((await response.json()) as { message: { id: string; thread_id: string } }).message
    w.proof(`> the person sends from compose to session-compose: ${message.id}`)

    const turn = await waitFor('the new-thread turn', () => session.turns.find((t) => t.text.includes(message.id)))
    await Bun.sleep(3_000)
    // The thread's subject is its short name; the wake asks the session to name the thread (its chip).
    expect(session.host.submits).toEqual([inboxWakeText({ type: 'message', new_thread: true, name_thread: true, id: message.id, subject: 'Idea: show which session wrote each thread', thread_id: message.thread_id, body: words }, CLAUDE_INBOX_TOOL_NAME)])
    expect(session.host.submits[0]!.split('\n').slice(1, 3)).toEqual([INBOX_NEW_THREAD_INSTRUCTION, INBOX_NAME_THREAD_LINE])
    w.proof(`turn.start ${turn.id} in session-compose:\n${turn.text}\n`)
    const delivered = await waitFor('the delivery record', async () => (await thread(w, message.thread_id)).messages[0]?.delivery)
    expect(delivered).toMatchObject({ host: 'claude-code', session: 'session-compose' })

    // The answer names the thread through the tool's own `thread` field: the name round-trips to the chip.
    const answer = await session.callInbox({ action: 'send_message', body: "I'll add the chip after this fix.", reply_to: message.id, thread: 'Session chip' }, w.project)
    if ('deny' in answer) throw new Error(answer.deny)
    expect(JSON.stringify(answer)).toContain('Named this thread: Session chip.')
    const named = await thread(w, message.thread_id)
    expect(named.messages.map((m) => m.author.kind)).toEqual(['person', 'agent'])
    expect(named.thread_name).toBe('Session chip')
    w.proof(`> plannotator_inbox send_message reply_to ${message.id} thread "Session chip"\nthe thread's name: ${named.thread_name}`)
    // A thread the person started is no session's default thread.
    const own = await send(session, w, 'Unrelated: the export is done.')
    expect(own.thread_id).not.toBe(message.thread_id)
    w.proof('the answer with reply_to landed in the person\'s thread; the session\'s next message without reply_to started its own thread')
  }, 120_000)

  test('Send now while Claude works: the session says it can, the window reads it as queued and busy, and the reply goes into the running turn at once (one user row, no turn); the next request carries it; Delivered', async () => {
    const w = world('12-send-now-into-the-running-turn')
    startInbox(w)
    const session = await open(w, 'session-send-now')
    const asked = await send(session, w, QUESTION)
    const { port } = registry(w)

    // Claude is working (a long turn: background subagents' notifications keep starting turns).
    await session.startTurn('Refactor the webhook handler.')
    const replyId = await personSends(w, asked.message_id, 'Retry with the same key.')
    // What the window reads under the reply: queued, the session busy, Send now offered.
    const connection = await waitFor('the busy connection', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/threads/${asked.thread_id}/sessions?asker=session-send-now`)).json()) as {
        asker: { connection: { busy: boolean | null; send_now: boolean } | null }
      }
      return model.asker.connection?.busy === true ? model.asker.connection : null
    })
    expect(connection).toMatchObject({ busy: true, send_now: true })
    await Bun.sleep(2_500)
    expect(session.host.submits).toEqual([])
    expect(session.host.appended).toEqual([])
    w.proof('Claude works: the reply is queued (0 submits, 0 rows after 2.5 s); the sessions route says busy, send_now')

    // The person presses Send now.
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
    const pressed = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${replyId}/send-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ serverSession: health.serverSession }),
    })
    expect(pressed.status).toBe(200)
    w.proof(`> the person presses Send now on ${replyId}`)
    const row = await waitFor('the row in the running turn', () => session.host.appended[0])
    const reply = (await thread(w, asked.thread_id)).messages.find((m) => m.id === replyId)!
    expect(row).toBe(inboxWakeText({ id: replyId, thread_id: asked.thread_id, subject: 'What should the worker do on a Stripe 409?', body: reply.body }, CLAUDE_INBOX_TOOL_NAME))
    expect(session.host.notices).toHaveLength(1)
    expect(session.host.submits).toEqual([])
    w.proof(`$.session.append (user row, into the running turn):\n${row}\n`)
    const delivered = await waitFor('the delivery record', async () => (await thread(w, asked.thread_id)).messages.find((m) => m.id === replyId)?.delivery)
    expect(delivered).toMatchObject({ host: 'claude-code', session: 'session-send-now' })

    // The turn's next model request carries it, then the turn ends: no extra turn, no second delivery.
    session.step()
    session.endTurn()
    await Bun.sleep(2_500)
    expect(session.host.submits).toEqual([])
    expect(session.host.appended).toHaveLength(1)
    expect(session.host.aborted).toEqual([])
    w.proof('the next request carried it; the turn ended: 0 submits, 1 row, 0 aborts')
  }, 120_000)

  test('Send now as the turn was making its last request: no request carried the row, so one short turn points Claude at it', async () => {
    const w = world('13-send-now-as-the-turn-ends')
    startInbox(w)
    const session = await open(w, 'session-late')
    const asked = await send(session, w, QUESTION)
    const { port } = registry(w)
    await session.startTurn('Write the summary.')
    const replyId = await personSends(w, asked.message_id, 'Fail the job and alert.')
    await waitFor('the busy connection', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/threads/${asked.thread_id}/sessions?asker=session-late`)).json()) as {
        asker: { connection: { busy: boolean | null } | null }
      }
      return model.asker.connection?.busy === true
    })
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${replyId}/send-now`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
          body: JSON.stringify({ serverSession: health.serverSession }),
        })
      ).status,
    ).toBe(200)
    await waitFor('the row in the running turn', () => session.host.appended[0])
    // The turn ends with no model request after the row.
    session.endTurn()
    const follow = await waitFor('the follow-up turn', () => session.host.submits[0])
    expect(follow).toBe(inboxSentNowFollowUpText({ id: replyId, subject: 'What should the worker do on a Stripe 409?', type: 'reply' }))
    await Bun.sleep(2_000)
    expect(session.host.submits).toHaveLength(1)
    w.proof(`the turn ended before reading it: one follow-up turn:\n${follow}\n`)
  }, 120_000)

  /** Send now pressed on a reply, as the window does. */
  async function pressSendNow(w: World, replyId: string): Promise<void> {
    const { port } = registry(w)
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string }
    const pressed = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${replyId}/send-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ serverSession: health.serverSession }),
    })
    expect(pressed.status).toBe(200)
  }

  /** Waits until the Inbox has heard this session busy (its poll said so). */
  async function busyKnown(w: World, threadId: string, session: string): Promise<void> {
    await waitFor('the busy connection', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${threadId}/sessions?asker=${session}`)).json()) as {
        asker: { connection: { busy: boolean | null; send_now: boolean } | null }
      }
      return model.asker.connection?.busy === true && model.asker.connection.send_now === true
    })
  }

  test('Send now, and the turn ends just before the row would go in (after the claim): it goes in as a turn, never as a row in an idle conversation', async () => {
    const w = world('14-send-now-turn-ends-before-the-append')
    startInbox(w)
    const session = await open(w, 'session-race')
    const asked = await send(session, w, QUESTION)
    await session.startTurn('Refactor the handler.')
    const replyId = await personSends(w, asked.message_id, 'Retry with the same key.')
    await busyKnown(w, asked.thread_id, 'session-race')
    // The turn ends while the delivery is claimed: every check before it read busy.
    session.host.onRun = (argv) => {
      if (argv.includes('plannotator-inbox-claim')) session.endTurn()
    }
    await pressSendNow(w, replyId)
    const turn = await waitFor('the wake turn', () => session.turns.find((t) => t.text.includes(replyId)))
    expect(session.host.appended).toEqual([])
    expect(session.host.submits).toHaveLength(1)
    expect(session.host.submits[0]!.startsWith(`Plannotator Inbox: What should the worker do on a Stripe 409? (${replyId})`)).toBe(true)
    w.proof(`the turn ended before the append: delivered as turn ${turn.id}, 0 rows`)
  }, 120_000)

  test('Send now, and the turn ends while the row goes in: the pointer turn goes at once (the next turn would otherwise mark it read)', async () => {
    const w = world('15-send-now-turn-ends-during-the-append')
    startInbox(w)
    const session = await open(w, 'session-during')
    const asked = await send(session, w, QUESTION)
    await session.startTurn('Refactor the handler.')
    const replyId = await personSends(w, asked.message_id, 'Fail the job and alert.')
    await busyKnown(w, asked.thread_id, 'session-during')
    session.host.onAppend = async () => {
      session.endTurn()
    }
    await pressSendNow(w, replyId)
    const follow = await waitFor('the pointer turn', () => session.host.submits[0])
    expect(session.host.appended).toHaveLength(1)
    expect(follow).toBe(inboxSentNowFollowUpText({ id: replyId, subject: 'What should the worker do on a Stripe 409?', type: 'reply' }))
    // A later turn's step does not swallow it, and nothing is sent twice.
    await session.startTurn('Next thing.')
    session.step()
    session.endTurn()
    await Bun.sleep(1_500)
    expect(session.host.submits).toHaveLength(1)
  }, 120_000)

  test("Send now while this session's own Ask question runs, or waits queued: never into that turn; it goes in as a turn once the session is idle", async () => {
    const w = world('16-send-now-ask-this-session')
    startInbox(w)
    const session = await open(w, 'session-ask')
    const asked = await send(session, w, QUESTION)
    const sink = { delta: () => {}, tool: () => {}, done: () => {}, error: () => {} }
    // Queued: the question is in flight, no turn runs yet.
    expect(session.mod.turns.beginAsk('ask-1', 'What does the retry loop do?', sink)).toBe(true)
    const replyId = await personSends(w, asked.message_id, 'Retry with the same key.')
    // The Inbox hears the session busy and unable to take a reply now: no Send now offered, and a press is refused.
    await waitFor('the busy connection without Send now', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${asked.thread_id}/sessions?asker=session-ask`)).json()) as {
        asker: { connection: { busy: boolean | null; send_now: boolean } | null }
      }
      return model.asker.connection?.busy === true && model.asker.connection.send_now === false
    })
    const health = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/health`)).json()) as { serverSession: string }
    const refused = await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/messages/${replyId}/send-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${registry(w).port}` },
      body: JSON.stringify({ serverSession: health.serverSession }),
    })
    expect(refused.status).toBe(409)
    await Bun.sleep(3_000)
    expect(session.host.appended).toEqual([])
    expect(session.host.submits).toEqual([])
    // Running: the question's own turn.
    await session.startTurn('Plannotator asks: What does the retry loop do?')
    await Bun.sleep(3_000)
    expect(session.host.appended).toEqual([])
    expect(session.host.submits).toEqual([])
    w.proof('the Ask question queued, then running: 0 rows, 0 submits')
    session.endTurn('It retries three times.')
    await waitFor('the wake turn', () => session.turns.find((t) => t.text.includes(replyId)))
    expect(session.host.appended).toEqual([])
    expect(session.host.submits).toHaveLength(1)
  }, 120_000)

  // The failure this catches: another plugin (a connector that delivers its own messages as turns) had its
  // turn running when the person pressed Send now (or the Inbox's 5-minute auto-send fired); the reply went
  // into that turn as a row, and the plugin read the agent's answer to our reply as the answer to its message.
  test("another plugin's turn running: Send now is not offered and a press is refused; the reply waits and goes in once, as a turn, when the session is idle", async () => {
    const w = world('16a-send-now-another-plugins-turn')
    startInbox(w)
    const session = await open(w, 'session-other-plugin')
    const asked = await send(session, w, QUESTION)
    await session.otherPluginPrompt('workspaces', 'Review the checkout PR and report back.')
    const replyId = await personSends(w, asked.message_id, 'Retry with the same key.')
    await waitFor('the busy connection without Send now', async () => {
      const model = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${asked.thread_id}/sessions?asker=session-other-plugin`)).json()) as {
        asker: { connection: { busy: boolean | null; send_now: boolean } | null }
      }
      return model.asker.connection?.busy === true && model.asker.connection.send_now === false
    })
    const health = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/health`)).json()) as { serverSession: string }
    const refused = await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/messages/${replyId}/send-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${registry(w).port}` },
      body: JSON.stringify({ serverSession: health.serverSession }),
    })
    expect(refused.status).toBe(409)
    await Bun.sleep(3_000)
    expect(session.host.appended).toEqual([])
    expect(session.host.submits).toEqual([])
    w.proof("another plugin's turn runs: send_now false, Send now refused, 0 rows, 0 submits")
    session.endTurn('Reviewed.')
    await waitFor('the wake turn', () => session.turns.find((t) => t.text.includes(replyId)))
    await Bun.sleep(1_500)
    expect(session.host.appended).toEqual([])
    expect(session.host.submits).toHaveLength(1)
    expect(session.host.aborted).toEqual([])
  }, 120_000)

  // The failure this catches: a claim held while the reply waits (here, the session's own Ask question took
  // the turn after the claim) whose `alive` goes stale, so another process reports a reply this one still holds.
  test("Send now claimed, then this session's own Ask question holds the turn: the claim is given back while it waits, and the reply goes in once, as a turn", async () => {
    const w = world('16b-send-now-held-claim-alive')
    startInbox(w)
    const session = await open(w, 'session-held')
    const asked = await send(session, w, QUESTION)
    await session.startTurn('Refactor the handler.')
    const replyId = await personSends(w, asked.message_id, 'Retry with the same key.')
    await busyKnown(w, asked.thread_id, 'session-held')
    const sink = { delta: () => {}, tool: () => {}, done: () => {}, error: () => {} }
    // At the claim, the person's turn ends and an Ask question is queued: busy, and no turn to go into.
    let claimed = false
    let released = false
    session.host.onRun = (argv) => {
      if (argv.includes('plannotator-inbox-release')) released = true
      if (!argv.includes('plannotator-inbox-claim') || claimed) return
      claimed = true
      session.endTurn()
      expect(session.mod.turns.beginAsk('ask-held', 'What does the retry loop do?', sink)).toBe(true)
    }
    await pressSendNow(w, replyId)
    const claim = join(w.dataDir, 'claude-code-mod', 'session-held', 'inbox', 'claims', replyId)
    await waitFor('the claim, then its release', () => released)
    // Nothing went in under it, so the claim is given back (any process may deliver it), not held.
    await waitFor('the claim given back', () => !existsSync(claim))
    await Bun.sleep(6_000)
    expect(existsSync(claim)).toBe(false)
    expect(session.host.appended).toEqual([])
    expect(session.host.submits).toEqual([])
    // The Ask question runs and ends: the reply goes in as a turn, once.
    await session.startTurn('Plannotator asks: What does the retry loop do?')
    session.endTurn('It retries three times.')
    await waitFor('the wake turn', () => session.turns.find((t) => t.text.includes(replyId)))
    expect(session.host.appended).toEqual([])
    expect(session.host.submits).toHaveLength(1)
  }, 120_000)

  test('two processes on one session: the claimant\'s turn starts right after its claim and the person moves to the other process; that process delivers the reply once', async () => {
    const w = world('16c-claim-then-lease-moves')
    startInbox(w)
    const first = await open(w, 'session-moves')
    const second = await open(w, 'session-moves')
    // The tool call in `first` makes it the person's process, so it claims the reply.
    const asked = await send(first, w, QUESTION)
    // Right after its claim, a turn starts in `first` (busy: the reply cannot go in there now).
    first.host.onRun = (argv) => {
      if (!argv.includes('plannotator-inbox-claim')) return
      first.host.onRun = () => undefined
      void first.startTurn('Keep refactoring the handler.')
    }
    const replyId = await personSends(w, asked.message_id, 'Retry with the same key.')
    await waitFor('the turn in the claimant', () => first.turns.some((t) => t.text === 'Keep refactoring the handler.'))
    // The person moves to the second process while that turn runs: the lease follows them.
    await second.type('Over here now.')
    second.endTurn()
    await waitFor('the delivery in the second process', () => second.host.submits.some((text) => text.includes(`(${replyId})`)), 40_000)
    expect(first.host.submits).toEqual([])
    // The claimant's turn ends: still exactly one delivery.
    first.endTurn()
    await Bun.sleep(6_000)
    expect([...first.host.submits, ...second.host.submits].filter((text) => text.includes(`(${replyId})`))).toHaveLength(1)
    w.proof(`reply ${replyId}: claimed in the first process, delivered once in the second`)
  }, 90_000)

  test('Send now with an older reply waiting for the same session: both go into the running turn, oldest first', async () => {
    const w = world('17-send-now-keeps-the-order')
    startInbox(w)
    const session = await open(w, 'session-order')
    const first = await send(session, w, QUESTION)
    const second = await session.callInbox({ action: 'send_message', body: 'Second question: rename the worker?', thread: 'naming' }, w.project)
    if ('deny' in second) throw new Error(second.deny)
    const secondId = (JSON.parse(second.text.slice(second.text.indexOf('{'))) as { message_id: string; thread_id: string })
    await session.startTurn('Refactor the handler.')
    const older = await personSends(w, first.message_id, 'Retry with the same key.')
    const newer = await personSends(w, secondId.message_id, 'Yes, rename it.')
    await busyKnown(w, first.thread_id, 'session-order')
    await pressSendNow(w, newer)
    await waitFor('both rows', () => session.host.appended.length === 2)
    expect(session.host.appended[0]!).toContain(`(${older})`)
    expect(session.host.appended[1]!).toContain(`(${newer})`)
    expect(session.host.submits).toEqual([])
  }, 120_000)
})
