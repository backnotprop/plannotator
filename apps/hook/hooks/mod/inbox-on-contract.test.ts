import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The mod cannot import packages/shared, so inbox-on-contract.ts is a copy of
// the record that says whether the person turned the Inbox on. The failure this
// guards: the two drift, and the mod registers plannotator_inbox (or gives the
// reminder) on a computer the CLI and every other host keep the Inbox off on.
describe('Inbox on contract copy', () => {
  test('the contract section is byte for byte the shared one', () => {
    const contract = (path: string) => {
      const text = readFileSync(path, 'utf8')
      const start = text.indexOf('// --- CONTRACT')
      expect(start).toBeGreaterThan(-1)
      return text.slice(start)
    }
    const shared = contract(join(import.meta.dir, '..', '..', '..', '..', 'packages', 'shared', 'inbox', 'inbox-on-contract.ts'))
    const mine = contract(join(import.meta.dir, 'inbox-on-contract.ts'))
    expect(mine).toBe(shared)
  })
})
