import { describe, expect, test } from 'bun:test'
import type { Host } from './host'
import { discoverInboxTools, STORE_INBOX_TOOLS } from './inbox'
import { inboxBodyWithBro, type InboxToolInfo } from './inbox-contract'

// The mod's copy of "a stopped Inbox gives the off words" (approval "bro-mode"): a list remembered from an Inbox with
// Bro mode on must not outlive the person turning it off, and only a running Inbox can say it is on.
const SERVED = 'The message, markdown. The rest of what the Inbox says.'
const listWith = (body: string): InboxToolInfo[] => [{ name: 'send_message', description: 'Send.', inputSchema: { type: 'object', properties: { body: { type: 'string', description: body } } } }]

/** No registry: the Inbox is stopped, and the store holds what it last answered. */
const stopped = (body: string) =>
  ({
    exists: async () => false,
    storeGet: async (key: string) => (key === STORE_INBOX_TOOLS ? { tools: listWith(body) } : null),
  }) as unknown as Host

describe('the tool list remembered for a stopped Inbox', () => {
  test('kept from an Inbox that had Bro mode on: the off words, byte for byte', async () => {
    expect(await discoverInboxTools(stopped(inboxBodyWithBro(SERVED)), '/nowhere')).toEqual(listWith(SERVED))
  })

  test('kept with it off: unchanged', async () => {
    expect(await discoverInboxTools(stopped(SERVED), '/nowhere')).toEqual(listWith(SERVED))
  })
})
