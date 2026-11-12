import { describe, expect, test } from 'bun:test'
import type { Host } from './host'
import { discoverInboxTools, STORE_INBOX_TOOLS } from './inbox'
import { inboxBodyWithBro, type InboxToolInfo } from './inbox-contract'

const SERVED = 'The message, markdown. The rest of what the Inbox says.'
const listWith = (body: string): InboxToolInfo[] => [{ name: 'send_message', description: 'Send.', inputSchema: { type: 'object', properties: { body: { type: 'string', description: body } } } }]

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
