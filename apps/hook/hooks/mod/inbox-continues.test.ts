/**
 * A branched conversation tells the Inbox which session it continues
 * (INBOX_CONTINUES_POLL_FIELD), so the person's reply to the old session id
 * reaches it. Claude Code writes `forkedFrom: { sessionId, messageUuid }` on
 * every row it copies into a branch's transcript. The failures these guard:
 * a branch that never names its source (its replies wait on the old id for
 * good); a conversation that is no branch naming one (it would take another
 * session's replies); message text that quotes such a row taken as one; a
 * transcript that is not there yet never looked for again; the transcript
 * read on every poll. Real files and a real `/bin/sh` in a temp folder, and
 * a memory host for the poll: never the person's own ~/.claude, no Inbox.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Host } from './host'
import { InboxLink, inboxRegistryPathOf, TRANSCRIPT_FORKED_FROM_RETRY_MS, TranscriptForkedFrom, transcriptForkedFromOf } from './inbox'
import { INBOX_BRIDGE_POLL_PATH, INBOX_CONTINUES_POLL_FIELD } from './inbox-contract'
import { fakeHost } from './testing/fake-host'

const scratch = mkdtempSync(join(tmpdir(), 'plannotator-continues-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const OLD = '3f6c2a1e-6b1d-4c55-9a3e-0d1c2b3a4f5e'
const NEW = '9d2b7c40-1a5e-4f0b-8c3d-6e7f8a9b0c1d'
const line = (record: unknown) => `${JSON.stringify(record)}\n`
const copied = (text: string, from = OLD) =>
  line({ type: 'user', sessionId: NEW, message: { role: 'user', content: text }, uuid: 'u1', forkedFrom: { sessionId: from, messageUuid: 'u1' } })
const plain = (text: string) => line({ type: 'user', sessionId: NEW, message: { role: 'user', content: text }, uuid: 'u2' })

let fileCount = 0
const pathOf = () => join(scratch, `t${(fileCount += 1)}.jsonl`)

/** A host on real files and real processes, counting the shell reads. */
function realHost() {
  const state = { now: 1_000_000, runs: 0 }
  const host: Pick<Host, 'fileSize' | 'run' | 'now'> = {
    now: async () => state.now,
    fileSize: async (path) => {
      try {
        const stat = statSync(path)
        return stat.isFile() ? stat.size : null
      } catch {
        return null
      }
    },
    run: async (argv) => {
      state.runs += 1
      const child = Bun.spawnSync([...argv], { stdout: 'pipe', stderr: 'pipe' })
      return { exitCode: child.exitCode ?? 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
    },
  }
  return { host, state }
}

describe("the session a branch's transcript names", () => {
  test('a branch names the session its rows were copied from, read once', async () => {
    const path = pathOf()
    writeFileSync(path, line({ type: 'custom-title', customTitle: 'Runner', sessionId: NEW }) + copied('Which runner?') + copied('ARM.') + plain('Go on.'))
    const { host, state } = realHost()
    const from = new TranscriptForkedFrom(host, NEW, async () => [join(scratch, 'missing.jsonl'), path])
    expect(await from.read()).toEqual([OLD])
    expect(await from.read()).toEqual([OLD])
    expect(state.runs).toBe(1)
  })

  test('a conversation that is no branch names nothing, and is not read again', async () => {
    const path = pathOf()
    // Its text quotes a branch's row: inside a string the quotes are escaped, so it is not one.
    writeFileSync(path, plain('Hello.') + plain(`look at this row: ${copied('x')}`))
    const { host, state } = realHost()
    const from = new TranscriptForkedFrom(host, NEW, async () => [path])
    expect(await from.read()).toEqual([])
    state.now += 10 * 60_000
    expect(await from.read()).toEqual([])
    expect(state.runs).toBe(1)
  })

  test('a transcript that is not there yet is looked for again after a wait, never on every poll', async () => {
    const path = pathOf()
    const { host, state } = realHost()
    const from = new TranscriptForkedFrom(host, NEW, async () => [path])
    expect(await from.read()).toEqual([])
    writeFileSync(path, copied('Which runner?'))
    // Within the wait: not looked for.
    expect(await from.read()).toEqual([])
    expect(state.runs).toBe(0)
    state.now += TRANSCRIPT_FORKED_FROM_RETRY_MS
    expect(await from.read()).toEqual([OLD])
  })

  test('only a session id that is not its own counts', () => {
    expect(transcriptForkedFromOf(`"forkedFrom":{"sessionId":"${OLD}"\n`, NEW)).toBe(OLD)
    expect(transcriptForkedFromOf(`"forkedFrom":{"sessionId":"${NEW}"\n`, NEW)).toBeNull()
    expect(transcriptForkedFromOf('"forkedFrom":{"sessionId":""\n', NEW)).toBeNull()
    expect(transcriptForkedFromOf('', NEW)).toBeNull()
    expect(transcriptForkedFromOf('"forkedFrom":{"sessionId":"../../etc"\n', NEW)).toBeNull()
  })
})

describe('what the poll says', () => {
  const DATA = '/data'
  const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })

  async function pollsOf(continues?: () => Promise<readonly string[]>) {
    const host = fakeHost()
    host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
    const polls: Record<string, unknown>[] = []
    host.onFetch = (url, body) => {
      if (url.endsWith(INBOX_BRIDGE_POLL_PATH)) polls.push(body as Record<string, unknown>)
      return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
    }
    const link = new InboxLink({ host, dataDir: DATA, sessionId: NEW, tools: [], isBusy: () => false, instanceId: 'me', ...(continues ? { continues } : {}) })
    link.start()
    for (let i = 0; i < 4; i += 1) {
      host.clock += 1_000
      await host.tick()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    link.dispose()
    expect(polls.length).toBeGreaterThan(0)
    return polls
  }

  test('a branch sends the session it continues on every poll', async () => {
    for (const poll of await pollsOf(async () => [OLD])) expect(poll[INBOX_CONTINUES_POLL_FIELD]).toEqual([OLD])
  })

  test('a conversation that continues nothing, or whose source cannot be read, sends no such field', async () => {
    for (const poll of await pollsOf(async () => [])) expect(INBOX_CONTINUES_POLL_FIELD in poll).toBe(false)
    for (const poll of await pollsOf(async () => Promise.reject(new Error('no shell')))) expect(INBOX_CONTINUES_POLL_FIELD in poll).toBe(false)
    for (const poll of await pollsOf()) expect(INBOX_CONTINUES_POLL_FIELD in poll).toBe(false)
  })
})
