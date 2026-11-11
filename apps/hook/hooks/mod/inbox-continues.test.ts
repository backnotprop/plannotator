/**
 * A branched conversation tells the Inbox which session it continues
 * (INBOX_CONTINUES_POLL_FIELD), so the person's reply to the old session id
 * reaches it. Claude Code writes `forkedFrom: { sessionId, messageUuid }` on
 * every row it copies into a branch's transcript. The failures these guard:
 * a branch that never names its source (its replies wait on the old id for
 * good); a conversation that is no branch naming one (it would take another
 * session's replies); message text that quotes such a row taken as one; a
 * transcript that is not there yet never looked for again; the transcript
 * read on every poll.
 *
 * A conversation handed over to a new session names nothing in its own
 * transcript: Claude Code ends the OLD transcript with
 * `{"type":"continued-in","sessionId":<old>,"continuedInSessionId":<new>}`.
 * The failures these guard: the new session never finding the one handed over
 * to it (the reported case); a line of hand-overs cut short; records that
 * point at each other looping; a broken or stale record taken for a
 * hand-over; a stranger's hand-over taken; the folder read on every poll.
 *
 * Real files and a real `/bin/sh` in a temp folder, and a memory host for the
 * poll: never the person's own ~/.claude, no Inbox. Every id is made up.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Host } from './host'
import {
  InboxLink,
  inboxRegistryPathOf,
  TRANSCRIPT_CONTINUED_IN_CHAIN_MAX,
  TRANSCRIPT_CONTINUED_IN_LOOK_AGAIN_MS,
  TRANSCRIPT_CONTINUED_IN_LOOKS_MAX,
  TRANSCRIPT_CONTINUED_IN_RETRY_MS,
  TRANSCRIPT_FORKED_FROM_RETRY_MS,
  TranscriptContinuedIn,
  TranscriptForkedFrom,
  transcriptContinuedLineOf,
  transcriptForkedFromOf,
} from './inbox'
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

describe('the sessions whose transcripts say they were continued in this one', () => {
  const A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const C = '33333333-cccc-4ccc-8ccc-cccccccccccc'
  const STRANGER = '44444444-dddd-4ddd-8ddd-dddddddddddd'
  const handover = (from: string, to: string) => line({ type: 'continued-in', timestamp: '2026-01-02T03:04:05.000Z', sessionId: from, continuedInSessionId: to })
  const turn = (sessionId: string, text: string) => line({ parentUuid: null, type: 'user', sessionId, message: { role: 'user', content: text }, uuid: 'u1' })
  const reply = (sessionId: string, text: string) =>
    line({ parentUuid: 'u1', type: 'assistant', sessionId, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }, uuid: 'a1' })
  const compacted = (sessionId: string) =>
    line({ type: 'system', subtype: 'compact_boundary', sessionId, compactMetadata: { trigger: 'manual' } }) + turn(sessionId, 'This session continues an earlier conversation.')

  let folderCount = 0
  /** A project folder of transcripts, as Claude Code lays one out: `<session id>.jsonl` each. */
  function project(files: Record<string, string>): string {
    const dir = join(scratch, `project-${(folderCount += 1)}`)
    mkdirSync(dir)
    for (const [sessionId, text] of Object.entries(files)) writeFileSync(join(dir, `${sessionId}.jsonl`), text)
    return dir
  }
  const finder = (dir: string, sessionId: string) => {
    const { host, state } = realHost()
    return { state, found: new TranscriptContinuedIn(host, sessionId, async () => [join(dir, `${sessionId}.jsonl`)]) }
  }

  test('a session handed a conversation finds the old session, though its own transcript names nothing; read once', async () => {
    const dir = project({
      [A]: turn(A, 'Which runner?') + reply(A, 'ARM.') + handover(A, B),
      [B]: compacted(B),
      [STRANGER]: turn(STRANGER, 'Unrelated.') + reply(STRANGER, 'Yes.'),
    })
    const { found, state } = finder(dir, B)
    expect(await found.read()).toEqual([A])
    expect(await found.read()).toEqual([A])
    expect(state.runs).toBe(1)
    // The same transcript names no branch source: this case is found only through the old one.
    const { host } = realHost()
    expect(await new TranscriptForkedFrom(host, B, async () => [join(dir, `${B}.jsonl`)]).read()).toEqual([])
  })

  test('bookkeeping rows after the record change nothing', async () => {
    const dir = project({
      [A]: turn(A, 'Which runner?') + reply(A, 'ARM.') + handover(A, B) + line({ type: 'custom-title', customTitle: 'Runner', sessionId: A }) + line({ type: 'last-prompt', sessionId: A, lastPrompt: 'Which runner?' }),
      [B]: compacted(B),
    })
    expect(await finder(dir, B).found.read()).toEqual([A])
  })

  test('a line of two hand-overs is followed, nearest first', async () => {
    const dir = project({
      [A]: turn(A, 'One.') + reply(A, 'Two.') + handover(A, B),
      [B]: compacted(B) + reply(B, 'Three.') + handover(B, C),
      [C]: compacted(C),
    })
    expect(await finder(dir, C).found.read()).toEqual([B, A])
    expect(await finder(dir, B).found.read()).toEqual([A])
  })

  test('records that point at each other end the line and never name the session itself', async () => {
    const dir = project({
      [A]: turn(A, 'One.') + handover(A, B),
      [B]: turn(B, 'Two.') + handover(B, A),
      [C]: turn(C, 'Three.') + handover(C, C),
    })
    expect(await finder(dir, A).found.read()).toEqual([B])
    expect(await finder(dir, B).found.read()).toEqual([A])
    expect(transcriptContinuedLineOf([{ from: A, to: B }, { from: B, to: C }, { from: C, to: A }], A)).toEqual([C, B])
    // A long line stops at the most the poll takes.
    const long = Array.from({ length: 20 }, (_, i) => ({ from: `s${i + 1}`, to: `s${i}` }))
    expect(transcriptContinuedLineOf(long, 's0')).toEqual(Array.from({ length: TRANSCRIPT_CONTINUED_IN_CHAIN_MAX }, (_, i) => `s${i + 1}`))
  })

  test('a missing, cut or garbled record, and another session\'s, hand nothing over; looked for a few times at once, then now and then', async () => {
    const whole = handover(A, B)
    const dir = project({
      // No record at all.
      [A]: turn(A, 'One.') + reply(A, 'Two.'),
      // Cut short (the write did not finish).
      '55555555-eeee-4eee-8eee-eeeeeeeeeeee': turn(A, 'One.') + whole.slice(0, whole.length - 12),
      // Not JSON.
      '66666666-ffff-4fff-8fff-ffffffffffff': `{"type":"continued-in","sessionId":"${A}","continuedInSessionId":"${B}",,}\n`,
      // No id, an id that is no id, and its own id.
      '77777777-aaaa-4aaa-8aaa-000000000001': line({ type: 'continued-in', sessionId: A }) ,
      '77777777-aaaa-4aaa-8aaa-000000000002': line({ type: 'continued-in', sessionId: '../../etc', continuedInSessionId: B }),
      // A message that quotes such a record: inside a string the quotes are escaped.
      '77777777-aaaa-4aaa-8aaa-000000000003': reply(STRANGER, `the row was ${whole}`) ,
      // Another session's hand-over.
      '77777777-aaaa-4aaa-8aaa-000000000005': handover(STRANGER, C),
      [B]: compacted(B),
    })
    const { found, state } = finder(dir, B)
    expect(await found.read()).toEqual([])
    // Looked for again a few times (the record is written just after the new session starts)...
    for (let i = 1; i < TRANSCRIPT_CONTINUED_IN_LOOKS_MAX; i += 1) {
      state.now += TRANSCRIPT_CONTINUED_IN_RETRY_MS * 2 ** (i - 1)
      expect(await found.read()).toEqual([])
    }
    expect(state.runs).toBe(TRANSCRIPT_CONTINUED_IN_LOOKS_MAX)
    // ...then only every TRANSCRIPT_CONTINUED_IN_LOOK_AGAIN_MS, however often the session polls.
    for (let i = 0; i < 50; i += 1) {
      state.now += 1_000
      expect(await found.read()).toEqual([])
    }
    expect(state.runs).toBe(TRANSCRIPT_CONTINUED_IN_LOOKS_MAX)
    state.now += TRANSCRIPT_CONTINUED_IN_LOOK_AGAIN_MS
    expect(await found.read()).toEqual([])
    expect(state.runs).toBe(TRANSCRIPT_CONTINUED_IN_LOOKS_MAX + 1)
    // A record that turns up long after the session started is found at the next of those looks.
    writeFileSync(join(dir, `${A}.jsonl`), turn(A, 'One.') + handover(A, B))
    state.now += TRANSCRIPT_CONTINUED_IN_LOOK_AGAIN_MS
    expect(await found.read()).toEqual([A])
  })

  // An old transcript may go on growing after the hand-over (bookkeeping rows, or the person going back to it):
  // the record was looked for only in its last 8 KB, and one conversation could then be listed as two agents.
  test('a record deep in a large transcript is found', async () => {
    const later = (line({ type: 'system', subtype: 'informational', sessionId: A, content: 'x'.repeat(4_000) })).repeat(3_000)
    expect(later.length).toBeGreaterThan(12_000_000)
    const dir = project({ [A]: turn(A, 'One.') + reply(A, 'Two.') + handover(A, B) + later, [B]: compacted(B) })
    expect(await finder(dir, B).found.read()).toEqual([A])
  })

  test('real turns after the record do not undo it: whether the old session still goes on is the Inbox\'s to judge', async () => {
    const dir = project({ [A]: turn(A, 'One.') + handover(A, B) + turn(A, 'Back here.') + reply(A, 'Welcome back.'), [B]: compacted(B) })
    expect(await finder(dir, B).found.read()).toEqual([A])
  })

  test('a line of three is followed through a middle session that went on after its hand-over', async () => {
    const D = '88888888-dddd-4ddd-8ddd-dddddddddddd'
    const dir = project({
      [A]: turn(A, 'One.') + handover(A, B),
      [B]: compacted(B) + handover(B, C) + turn(B, 'Still here.') + reply(B, 'Yes.'),
      [C]: compacted(C) + reply(C, 'Three.') + handover(C, D),
      [D]: compacted(D),
    })
    expect(await finder(dir, D).found.read()).toEqual([C, B, A])
  })

  test('a session handed over twice names both; two sessions that just share a folder continue nothing', async () => {
    const dir = project({ [A]: turn(A, 'One.') + handover(A, B) + turn(A, 'Back.') + reply(A, 'Yes.') + handover(A, C), [B]: compacted(B), [C]: compacted(C) })
    expect(await finder(dir, B).found.read()).toEqual([A])
    expect(await finder(dir, C).found.read()).toEqual([A])
    const two = project({ [A]: turn(A, 'One.') + reply(A, 'Two.'), [B]: turn(B, 'Other window.') + reply(B, 'Yes.') })
    expect(await finder(two, A).found.read()).toEqual([])
    expect(await finder(two, B).found.read()).toEqual([])
  })

  test('a record written after the first look is found on a later one, never on every poll', async () => {
    const dir = project({ [A]: turn(A, 'One.') + reply(A, 'Two.'), [B]: compacted(B) })
    const { found, state } = finder(dir, B)
    expect(await found.read()).toEqual([])
    writeFileSync(join(dir, `${A}.jsonl`), turn(A, 'One.') + reply(A, 'Two.') + handover(A, B))
    expect(await found.read()).toEqual([])
    expect(state.runs).toBe(1)
    state.now += TRANSCRIPT_CONTINUED_IN_RETRY_MS
    expect(await found.read()).toEqual([A])
    expect(state.runs).toBe(2)
  })

  test('only the end of a long transcript is read, and a folder that is not there is nothing', async () => {
    const dir = project({ [A]: turn(A, 'x'.repeat(3 * 1024 * 1024)) + reply(A, 'Two.') + handover(A, B), [B]: compacted(B) })
    expect(await finder(dir, B).found.read()).toEqual([A])
    expect(await finder(join(scratch, 'no-such-folder'), B).found.read()).toEqual([])
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
