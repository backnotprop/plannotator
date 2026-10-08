import { afterEach, describe, expect, test } from 'bun:test'
import { PlannotatorMod } from './controller'
import { resolveSnapshotsEnabled } from './enabled'
import type { HttpResult } from './host'
import { SNAPSHOTS_UNDELIVERED_AFTER_MS, SNAPSHOTS_UPDATE_TEXT, SnapshotsLink, snapshotsSessionDirOf } from './snapshots'
import { fakeHost, type FakeHost } from './testing/fake-host'
import { TurnTracker } from './turns'

const DATA = '/data'
const SESSION = 'session-1'
const HUB = 'http://127.0.0.1:4000'
const SEND = { type: 'deliver', sendId: 'hs-0123456789ab', text: 'Plannotator: 1 snapshot from you.' }

/** Real macrotask turns, so the links' async loops run. */
async function settle(rounds = 30): Promise<void> {
  for (let index = 0; index < rounds; index++) await new Promise((resolve) => setTimeout(resolve, 0))
}

interface FakeHub {
  hellos: string[]
  events: Array<Record<string, unknown>>
  byes: number
  /** Hand commands to every poll that is waiting (and the next one, when none is). */
  push(commands: Array<Record<string, unknown>>): void
  waitingPolls(): number
}

/**
 * The hub as the links see it over `$.http.fetch`: one connection, polls that
 * wait until the test pushes commands (as a long poll does), and the claim
 * script's mkdir rule in the shared file map, so two links on one host are
 * two Claude Code processes on one session.
 */
function withFakeHub(host: FakeHost): FakeHub {
  host.files.set(`${DATA}/snapshots/hub.json`, JSON.stringify({ v: 1, url: HUB, token: 't'.repeat(64) }))
  let waiting: Array<(result: HttpResult) => void> = []
  let queued: Array<Record<string, unknown>> = []
  const hub: FakeHub = {
    hellos: [],
    events: [],
    byes: 0,
    push(commands) {
      const answer = { status: 200, ok: true, text: JSON.stringify({ commands }) }
      if (waiting.length === 0) queued.push(...commands)
      for (const resolve of waiting.splice(0)) resolve(answer)
    },
    waitingPolls: () => waiting.length,
  }
  host.onFetch = (url, body) => {
    const path = url.slice(HUB.length)
    if (path === '/api/connections/hello') {
      hub.hellos.push(String((body as { processId?: string }).processId))
      return { status: 200, ok: true, text: JSON.stringify({ connectionId: 'c1' }) }
    }
    if (path === '/api/connections/c1/poll') {
      if (queued.length > 0) {
        const commands = queued
        queued = []
        return { status: 200, ok: true, text: JSON.stringify({ commands }) }
      }
      return new Promise<HttpResult>((resolve) => waiting.push(resolve))
    }
    if (path === '/api/connections/c1/event') {
      const value = body as { events?: Array<Record<string, unknown>> } & Record<string, unknown>
      hub.events.push(...(Array.isArray(value.events) ? value.events : [value]))
      return { status: 200, ok: true, text: '{}' }
    }
    if (path === '/api/connections/c1/bye') {
      hub.byes += 1
      return { status: 200, ok: true, text: '{}' }
    }
    return { status: 404, ok: false, text: '' }
  }
  host.onRun = (call) => {
    if (call.argv[3] !== 'plannotator-snapshots-claim') return
    const dir = call.argv[4] as string
    const me = call.argv[5] as string
    const by = host.files.get(`${dir}/by`)
    if (by !== undefined) return { exitCode: by === me ? 0 : 3, stdout: '', stderr: '' }
    host.files.set(`${dir}/by`, me)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return hub
}

function link(host: FakeHost, instanceId: string): SnapshotsLink {
  return new SnapshotsLink({ host, dataDir: DATA, sessionId: SESSION, processId: `proc-${instanceId}`, instanceId, turns: new TurnTracker() })
}

const claimDir = (sendId: string) => `${snapshotsSessionDirOf(DATA, SESSION)}/claims/${sendId}`

describe('SnapshotsLink: two Claude Code processes on one session', () => {
  test('only the process the person used last links, and a send is ONE turn even when both get it', async () => {
    const host = fakeHost()
    const hub = withFakeHub(host)
    const first = link(host, 'aaaa')
    first.start()
    await settle()
    expect(first.isLeader).toBe(true)
    expect(hub.hellos).toEqual(['proc-aaaa'])

    // The person moves to a second process on the same session (claude --continue).
    host.clock += 1_000
    const second = link(host, 'bbbb')
    second.start()
    await settle()
    expect(second.isLeader).toBe(true)
    expect(hub.hellos).toEqual(['proc-aaaa', 'proc-bbbb'])

    // Before the first one's lease check runs, both are polling: the worst case. Both get the send.
    expect(hub.waitingPolls()).toBe(2)
    hub.push([SEND])
    await settle()
    expect(host.submits).toEqual([SEND.text])
    expect(host.files.get(`${claimDir(SEND.sendId)}/delivered`)).toBeDefined()
    expect(hub.events.filter((event) => event.type === 'delivered' && event.sendId === SEND.sendId).length).toBeGreaterThanOrEqual(1)

    // The first process's lease check: the second one holds it now.
    await host.tick()
    await settle()
    expect(first.isLeader).toBe(false)

    // The hub hands the send out again (a hello): acknowledged, never a second turn.
    hub.push([SEND])
    await settle()
    expect(host.submits).toEqual([SEND.text])

    // Typing in the first process pulls the link back to it.
    host.clock += 1_000
    first.noteHumanInput('back here')
    await settle()
    expect(first.isLeader).toBe(true)
    await host.tick()
    await settle()
    expect(second.isLeader).toBe(false)

    first.dispose()
    second.dispose()
  })

  test('a send claimed by a process that quit is reported as not delivered, once', async () => {
    const host = fakeHost()
    const hub = withFakeHub(host)
    const only = link(host, 'aaaa')
    only.start()
    await settle()
    // Another process claimed it and then stopped saying it is alive.
    host.files.set(`${claimDir(SEND.sendId)}/by`, 'gone')
    host.files.set(`${claimDir(SEND.sendId)}/alive`, String(host.clock))
    hub.push([SEND])
    await settle()
    expect(host.submits).toEqual([])
    expect(hub.events).toContainEqual({ type: 'deliver_accepted', sendId: SEND.sendId, queued: true })

    host.clock += SNAPSHOTS_UNDELIVERED_AFTER_MS + 1
    await host.tick()
    await settle()
    expect(hub.events.filter((event) => event.type === 'deliver_failed')).toHaveLength(1)
    expect(host.files.get(`${claimDir(SEND.sendId)}/reported`)).toBe('1')
    expect(host.submits).toEqual([])
    only.dispose()
  })

  test('a malformed send id is ignored, and only the linking process says goodbye', async () => {
    const host = fakeHost()
    const hub = withFakeHub(host)
    const first = link(host, 'aaaa')
    first.start()
    await settle()
    hub.push([{ type: 'deliver', sendId: '../../x', text: 'nope' }])
    await settle()
    expect(host.submits).toEqual([])
    expect([...host.files.keys()].some((path) => path.includes('/claims/../'))).toBe(false)

    host.clock += 1_000
    const second = link(host, 'bbbb')
    second.start()
    await settle()
    await host.tick()
    await settle()
    expect(first.isLeader).toBe(false)
    first.dispose()
    expect(hub.byes).toBe(0)
    second.dispose()
    await settle()
    expect(hub.byes).toBe(1)
  })
})

describe('Snapshots switched off', () => {
  test('PLANNOTATOR_SNAPSHOTS=0 or { "snapshots": false } turns it off, and a mod without it makes no link', async () => {
    expect(resolveSnapshotsEnabled(undefined, '{"snapshots": false}')).toBe(false)
    expect(resolveSnapshotsEnabled('0', '{"snapshots": true}')).toBe(false)
    expect(resolveSnapshotsEnabled('0', null)).toBe(false)

    const host = fakeHost()
    const hub = withFakeHub(host)
    const mod = new PlannotatorMod(host, { sessionId: SESSION, dataDir: DATA, interactive: true })
    expect(mod.snapshots).toBeNull()
    await mod.restore().catch(() => undefined)
    mod.onPromptEntered({ text: 'hello', originKind: 'composer' } as never)
    await settle()
    expect(hub.hellos).toEqual([])
    expect(host.runs.some((call) => call.argv.includes('snapshot'))).toBe(false)
    expect([...host.files.keys()].some((path) => path.includes('/snapshots/') && !path.endsWith('hub.json'))).toBe(false)
    mod.dispose()
  })
})

const updateLinks: SnapshotsLink[] = []
afterEach(() => {
  while (updateLinks.length > 0) updateLinks.pop()!.dispose()
})

function linkOn(host: FakeHost): SnapshotsLink {
  // A real wait, so the link's look for a hub never spins.
  host.sleep = () => new Promise((resolve) => setTimeout(resolve, 5))
  const link = new SnapshotsLink({ host, dataDir: '/data', sessionId: 's-1', processId: 'p-1', instanceId: 'cccc', turns: new TurnTracker() })
  updateLinks.push(link)
  return link
}

describe('/plannotator-snapshot in the mod', () => {
  // The plugin installs from main while the binary updates separately: an
  // older plannotator has no `snapshot`, and its raw refusal reads as a bug.
  test('a plannotator from before Snapshots: the person is told to update', async () => {
    for (const stderr of ["Unknown command: snapshot\n\nRun 'plannotator --help' for the list of commands.\n", 'No plan content in hook event\n']) {
      const host = fakeHost()
      host.onRun = (call) => (call.argv[1] === 'snapshot' ? { exitCode: 1, stdout: '', stderr } : undefined)
      expect(await linkOn(host).summon('')).toBe(SNAPSHOTS_UPDATE_TEXT)
    }
  })

  test('nothing is spawned until a hub exists', async () => {
    const host = fakeHost()
    linkOn(host).start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(host.runs).toEqual([])
  })
})
