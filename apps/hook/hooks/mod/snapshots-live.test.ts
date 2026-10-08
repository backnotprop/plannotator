/**
 * The Claude Code connection to Plannotator Snapshots, proved against a REAL
 * hub: `plannotator snapshot hub --background` under a temp HOME and data dir
 * (the compiled binary when PLANNOTATOR_INBOX_TEST_BINARY names one,
 * otherwise the CLI from source), the mod's own code on a Host of real
 * processes, HTTP and files (testing/claude-session.ts), and the person's
 * capture, Send and Ask through the routes the HUD posts to. The native app
 * never runs: the temp HOME has no ~/Applications app and neither build embeds
 * one, so `/plannotator-snapshot` summons and then reports the app missing.
 *
 * Gate: the mod stands down on Windows (no /bin/sh). On macOS the session
 * links at start, as register.ts does there; elsewhere it links on demand
 * when `/plannotator-snapshot` runs, so these proofs run on Linux too.
 *
 * Set INBOX_PROOF_DIR to keep a transcript of each proof under <dir>/claude-code-snapshots/.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createInboxWorld, stubBuiltHtml, worldEnv, type InboxWorld } from '../../../../tests/helpers/inbox-world'
import { startCliSnapshotsHub, stopCliSnapshotsHub, type CliSnapshotsHub } from '../../../../tests/helpers/snapshots-world'
import { SNAPSHOTS_APP_MISSING_TEXT } from './snapshots'
import { ClaudeSession, PLUGIN_FRAME } from './testing/claude-session'

const darwin = process.platform === 'darwin'
let stubs: string[] = []
const worlds: InboxWorld[] = []
const sessions: ClaudeSession[] = []

beforeAll(() => {
  stubs = stubBuiltHtml()
})
afterAll(() => {
  const { rmSync } = require('node:fs') as typeof import('node:fs')
  for (const path of stubs) rmSync(path, { force: true })
})
afterEach(() => {
  const { rmSync } = require('node:fs') as typeof import('node:fs')
  for (const session of sessions.splice(0)) session.quit()
  for (const w of worlds.splice(0)) {
    stopCliSnapshotsHub(w)
    rmSync(w.root, { recursive: true, force: true })
  }
})

function world(name: string): InboxWorld {
  const w = createInboxWorld('plannotator-snapshots-mod-', name, 'claude-code-snapshots')
  worlds.push(w)
  return w
}

/** One Claude Code process with Snapshots on, linked as register.ts links it (at start on macOS). */
async function open(w: InboxWorld, sessionId: string): Promise<ClaudeSession> {
  const session = await ClaudeSession.start({
    env: { ...worldEnv(w), PLANNOTATOR_SNAPSHOTS: '1' },
    cwd: w.project,
    store: new Map(),
    sessionId,
    dataDir: w.dataDir,
    snapshots: { processId: `test-${sessionId}` },
  })
  sessions.push(session)
  // Every turn is ended by the test: the delivery turn plainly, the Ask turn with a streamed answer.
  session.holdPluginTurns = true
  if (darwin) session.mod.snapshots!.start()
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

/** The HUD's own token, for the PATCH a note goes through (the helper covers attach, capture, send and ask). */
async function hudHeaders(hub: CliSnapshotsHub): Promise<Record<string, string>> {
  const attach = await fetch(`${hub.url}/api/snapshots/attach`, {
    method: 'POST',
    headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
    body: '{}',
  })
  const { hudToken } = (await attach.json()) as { hudToken: string }
  return { authorization: `Bearer ${hudToken}`, 'content-type': 'application/json' }
}

/** `/plannotator-snapshot`, as register.ts's command.run answers it. */
async function runSlashCommand(w: InboxWorld, session: ClaudeSession, hub: CliSnapshotsHub): Promise<string> {
  const text = await session.mod.snapshots!.summon('')
  w.proof(`> /plannotator-snapshot\n${text}\n`)
  // Off macOS the CLI refuses before it summons (capture is macOS only): the HUD's picker or a
  // summon does it there. The routing is what the test needs; the CLI's summon is proved on macOS.
  if (!darwin) await hub.summon('claude-code', session.sessionId)
  return text
}

const linked = (hub: CliSnapshotsHub, sessionId: string) =>
  hub.waitForState((state) => (state.connections as Array<{ host: string; sessionId: string }>).some((c) => c.host === 'claude-code' && c.sessionId === sessionId), 20_000)

describe.skipIf(process.platform === 'win32')('Claude Code ↔ Plannotator Snapshots (real hub started by the CLI, real processes)', () => {
  test('the session links, /plannotator-snapshot summons it, and the Send arrives as exactly one plugin turn with the image path and the notes', async () => {
    const w = world('01-summon-send-once')
    const hub = await startCliSnapshotsHub(w)
    const session = await open(w, 'session-snap')

    const reply = await runSlashCommand(w, session, hub)
    // No native app in the temp HOME. On macOS the real CLI summoned this session first, so the
    // reply says the session is linked and how to install the app; elsewhere the CLI refuses.
    if (darwin) expect(reply).toBe(SNAPSHOTS_APP_MISSING_TEXT)
    else expect(reply).toContain('runs on macOS for now')
    await linked(hub, 'session-snap')

    const { collectionId, snapshotId } = await hub.capture()
    const state = await hub.state()
    expect(state.collection.destination).toMatchObject({ host: 'claude-code', sessionId: 'session-snap', reason: 'summoned' })

    const hud = await hudHeaders(hub)
    const patched = await fetch(`${hub.url}/api/snapshots/snapshot/${snapshotId}`, { method: 'PATCH', headers: hud, body: JSON.stringify({ note: 'The total is off by one cent.' }) })
    expect(patched.status).toBe(200)
    const noted = await fetch(`${hub.url}/api/snapshots/collection/${collectionId}`, { method: 'POST', headers: hud, body: JSON.stringify({ note: 'Fix the rounding before the release.' }) })
    expect(noted.status).toBe(200)

    const sent = await hub.send(collectionId)
    w.proof(`> the person presses Send (${sent.sendId})\n${sent.text}\n`)

    const turn = await waitFor('the delivery turn', () => session.running && session.running.text.startsWith(PLUGIN_FRAME) ? session.running : null)
    session.endTurn('Looking at the image now.')
    expect(session.host.submits).toEqual([sent.text])
    expect(turn.text).toBe(`${PLUGIN_FRAME}${sent.text}`)
    expect(sent.text).toStartWith('Plannotator: 1 snapshot from you')
    expect(sent.text).toMatch(new RegExp(`Image: ${w.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/snapshots/\\S+\\.png`))
    expect(sent.text).toContain('The total is off by one cent.')
    expect(sent.text).toContain('Fix the rounding before the release.')

    const delivered = await hub.waitForState((s) => s.lastSent?.send?.state === 'delivered')
    expect(delivered.lastSent.send).toMatchObject({ sendId: sent.sendId, host: 'claude-code', sessionId: 'session-snap' })

    // Past the hub's 5 s re-send window: still one turn.
    await Bun.sleep(7_000)
    expect(session.host.submits).toHaveLength(1)
    expect(session.turns.filter((t) => t.text.startsWith(PLUGIN_FRAME))).toHaveLength(1)
    w.proof(`delivered once: ${JSON.stringify(delivered.lastSent.send)}; turns after 7 s: ${session.turns.length}`)
  }, 60_000)

  test('Ask from the HUD is answered by the session as a real turn, streamed back', async () => {
    const w = world('02-ask-as-a-turn')
    const hub = await startCliSnapshotsHub(w)
    const session = await open(w, 'session-ask')
    await runSlashCommand(w, session, hub)
    await linked(hub, 'session-ask')
    await hub.capture()

    const answer = 'The cents column rounds half-down; use banker’s rounding.'
    const asked = hub.ask('Why is the total off by a cent?')
    const turn = await waitFor('the ask turn', () => session.running && session.running.text.startsWith(PLUGIN_FRAME) ? session.running : null)
    expect(turn.text).toContain('Why is the total off by a cent?')
    // The model's response, as register.ts feeds turn.step's chunks to the tracker.
    session.mod.onTurnStep(turn.id)
    const [first, second] = [answer.slice(0, 20), answer.slice(20)]
    session.mod.turns.onText(turn.id, first)
    session.mod.turns.onText(turn.id, second)
    session.mod.onTurnStepStop(turn.id, 'end_turn')
    session.endTurn(answer)

    const result = await asked
    w.proof(`> Ask from the HUD\n${turn.text}\n< ${result.text}\n`)
    expect(result.text).toBe(answer)
    expect(result.messages.some((m) => m.type === 'text_delta')).toBe(true)
    // An Ask is a question, not a send: nothing was delivered.
    expect((await hub.state()).lastSent).toBeNull()
  }, 60_000)
})
