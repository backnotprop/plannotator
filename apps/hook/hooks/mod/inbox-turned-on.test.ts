import { describe, expect, test } from 'bun:test'
import { inboxTurnedOnHere } from './inbox-turned-on'
import { fakeHost } from './testing/fake-host'

// The mod's read of the Inbox gate (packages/shared/inbox/turned-on.ts, same mark, same rule). The failure this
// guards: Claude Code registering plannotator_inbox and its reminder where the Inbox never ran, or going without it
// where it did (an install from before the mark, or a person's Inbox started by an older plannotator).
const DATA = '/data'
const MARK = `${DATA}/inbox/turned-on`

describe('the mod reads the Inbox gate', () => {
  test('a computer where the Inbox never ran: off, nothing written', async () => {
    const host = fakeHost()
    expect(await inboxTurnedOnHere(host, DATA, false)).toBe(false)
    expect(host.files.has(MARK)).toBe(false)
  })

  test('the mark decides; one that cannot be parsed reads on', async () => {
    const host = fakeHost()
    host.files.set(MARK, '{"on":true,"by":"command"}')
    expect(await inboxTurnedOnHere(host, DATA, false)).toBe(true)
    host.files.set(MARK, '')
    expect(await inboxTurnedOnHere(host, DATA, false)).toBe(true)
  })

  test('an Inbox ran here with no mark (from before the mark, or an older plannotator): on, and the mark written on', async () => {
    const host = fakeHost()
    host.files.set(`${DATA}/inbox/inbox.json`, '{"version":"0.29.0"}')
    expect(await inboxTurnedOnHere(host, DATA, false)).toBe(true)
    expect(JSON.parse(host.files.get(MARK)!)).toMatchObject({ on: true, by: 'update-existing' })
  })

  test('a check for inbox.json that fails: on for this read, and nothing written (a fresh computer is never marked on by an error)', async () => {
    const host = fakeHost()
    const exists = host.exists
    host.exists = async (path) => {
      if (path.endsWith('/inbox/inbox.json')) throw new Error('EIO')
      return exists(path)
    }
    expect(await inboxTurnedOnHere(host, DATA, false)).toBe(true)
    expect(host.files.has(MARK)).toBe(false)
  })

  test("a test run's knob counts a data dir with no mark as on", async () => {
    expect(await inboxTurnedOnHere(fakeHost(), DATA, true)).toBe(true)
  })
})
