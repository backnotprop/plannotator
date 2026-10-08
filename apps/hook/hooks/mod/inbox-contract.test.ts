import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The mod cannot import packages/shared, so inbox-contract.ts is a copy of the
// Inbox connection contract. The failure this guards: the two drift, and the
// mod builds a plannotator_inbox tool, polls a route or words a wake that the
// Inbox server and the other connections no longer share.
describe('Inbox connection contract copy', () => {
  test('the contract section is byte for byte the shared one', () => {
    const contract = (path: string) => {
      const text = readFileSync(path, 'utf8')
      const start = text.indexOf('// --- CONTRACT')
      expect(start).toBeGreaterThan(-1)
      return text.slice(start)
    }
    const shared = contract(join(import.meta.dir, '..', '..', '..', '..', 'packages', 'shared', 'inbox', 'connection.ts'))
    const mine = contract(join(import.meta.dir, 'inbox-contract.ts'))
    expect(mine).toBe(shared)
  })
})
