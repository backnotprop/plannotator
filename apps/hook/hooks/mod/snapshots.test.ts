import { afterEach, describe, expect, test } from 'bun:test'
import { SnapshotsLink, SNAPSHOTS_UPDATE_TEXT } from './snapshots'
import { fakeHost, type FakeHost } from './testing/fake-host'
import { TurnTracker } from './turns'

const links: SnapshotsLink[] = []
afterEach(() => {
  while (links.length > 0) links.pop()!.dispose()
})

function linkOn(host: FakeHost): SnapshotsLink {
  // A real wait, so the link's look for a hub never spins.
  host.sleep = () => new Promise((resolve) => setTimeout(resolve, 5))
  const link = new SnapshotsLink({ host, dataDir: '/data', sessionId: 's-1', processId: 'p-1', turns: new TurnTracker() })
  links.push(link)
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
