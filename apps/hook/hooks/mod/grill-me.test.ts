import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The mod cannot import packages/shared, so grill-me.ts is a copy of the
// shared grill-me note. The failure this guards: the two drift, and Claude
// Code reads a note (or matches names) the other hosts no longer share.
describe('grill-me note copy', () => {
  test('the contract section is byte for byte the shared one', () => {
    const contract = (path: string) => {
      const text = readFileSync(path, 'utf8')
      const start = text.indexOf('// --- CONTRACT')
      expect(start).toBeGreaterThan(-1)
      return text.slice(start)
    }
    const shared = contract(join(import.meta.dir, '..', '..', '..', '..', 'packages', 'shared', 'inbox', 'grill-me.ts'))
    const mine = contract(join(import.meta.dir, 'grill-me.ts'))
    expect(mine).toBe(shared)
  })
})
