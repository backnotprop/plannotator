import { describe, expect, test } from 'bun:test'
import { inboxTurnedOnHere } from './inbox-turned-on'
import { fakeHost } from './testing/fake-host'

// The mod's read of the Inbox's gate (packages/shared/inbox/turned-on.ts, same mark, same rule). The failure this
// guards: Claude Code registering plannotator_inbox and its reminder where the person never turned the Inbox on (a
// fresh computer, or an install only agents ever started), or going quiet where they used it before the update.
const DATA = '/data'
const MARK = `${DATA}/inbox/turned-on`

describe('the mod reads the Inbox gate', () => {
  test('a fresh computer: off, nothing written', async () => {
    const host = fakeHost()
    expect(await inboxTurnedOnHere(host, DATA, false)).toBe(false)
    expect(host.files.has(MARK)).toBe(false)
  })

  test('the mark decides', async () => {
    const host = fakeHost()
    host.files.set(MARK, '{"on":true,"by":"command"}')
    expect(await inboxTurnedOnHere(host, DATA, false)).toBe(true)
    host.files.set(MARK, '{"on":false,"by":"update-agent-only"}')
    expect(await inboxTurnedOnHere(host, DATA, false)).toBe(false)
  })

  test('from before the mark: agent-only stays off, a person file turns it on, and the answer is written', async () => {
    const agentOnly = fakeHost()
    agentOnly.files.set(`${DATA}/inbox/inbox.json`, '{}')
    expect(await inboxTurnedOnHere(agentOnly, DATA, false)).toBe(false)
    expect(JSON.parse(agentOnly.files.get(MARK)!)).toMatchObject({ on: false, by: 'update-agent-only' })

    const used = fakeHost()
    used.files.set(`${DATA}/inbox/inbox.json`, '{}')
    used.files.set(`${DATA}/inbox/agents.json`, '{}')
    expect(await inboxTurnedOnHere(used, DATA, false)).toBe(true)
    expect(JSON.parse(used.files.get(MARK)!)).toMatchObject({ on: true, by: 'update-used' })
  })

  test("a test run's knob counts a scratch dir with no mark as on", async () => {
    expect(await inboxTurnedOnHere(fakeHost(), DATA, true)).toBe(true)
  })
})
