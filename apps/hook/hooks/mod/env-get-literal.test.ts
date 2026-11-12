import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKIP_RM_PROMPTS_VARIABLE } from './skip-rm-prompts'

const dir = import.meta.dir
const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
  .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))

describe('$.env.get in the hooks module', () => {
  test('every call names its variable as a string literal', () => {
    const bad: string[] = []
    for (const { name, text } of sources) {
      for (const match of text.matchAll(/\$\.env\.get\(\s*([^)]*)\)/g)) {
        if (!/^(['"])[A-Z0-9_]+\1$/.test(match[1].trim())) bad.push(`${name}: $.env.get(${match[1]})`)
      }
    }
    expect(bad).toEqual([])
  })

  test('register.ts reads the skip-rm-prompts variable under its exact name', () => {
    const register = sources.find((s) => s.name === 'register.ts')!.text
    expect(register.includes(`$.env.get('${SKIP_RM_PROMPTS_VARIABLE}')`)).toBe(true)
  })
})
