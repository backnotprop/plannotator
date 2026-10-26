import { describe, expect, test } from 'bun:test'
import {
  parsePlannotatorToolInput,
  plannotatorCommandToToolInput,
  plannotatorToolArgs,
  plannotatorToolOpenedText,
  PLANNOTATOR_TOOL_DESCRIPTION,
  PLANNOTATOR_TOOL_INPUT_SCHEMA,
  PLANNOTATOR_TOOL_NAME,
  PLANNOTATOR_TOOL_TAILSCALE_DESCRIPTION,
  PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA,
  PLANNOTATOR_TOOL_TAILSCALE_LINE,
} from './plannotator-tool'

// #2166: `tailscale` is an opt-in of the contract for a host that can publish
// over the tailnet (the Claude Code mod). The failures guarded: a host that
// did not opt in (Pi, OpenCode 2, T3) starts sending a different tool
// definition or accepting the field; or the opt-in maps to the wrong CLI words.

describe('the plain contract is unchanged for every other host', () => {
  // Deliberately frozen: the sha256 of the plain tool definition (name,
  // description, schema) as it was before #2166. Pi and OpenCode send this
  // definition with every request, so a change here changes their prompt.
  test('the plain name, description and schema are byte for byte the ones before #2166', () => {
    const definition = JSON.stringify({ d: PLANNOTATOR_TOOL_DESCRIPTION, s: PLANNOTATOR_TOOL_INPUT_SCHEMA, name: PLANNOTATOR_TOOL_NAME })
    const sha = new Bun.CryptoHasher('sha256').update(definition).digest('hex')
    expect(sha).toBe('c894a10c388e121888ab145097ce4537ba0f3044672b69763a764863439cb44f')
  })

  test('without the option, tailscale is an unknown field and `--tailscale` runs as written', () => {
    expect(parsePlannotatorToolInput({ action: 'review', tailscale: true })).toEqual({ ok: false, error: 'Invalid plannotator call: unknown field "tailscale".' })
    expect(parsePlannotatorToolInput({ action: 'review', tailscale: false })).toEqual({ ok: false, error: 'Invalid plannotator call: unknown field "tailscale".' })
    expect(plannotatorCommandToToolInput('plannotator review --tailscale')).toBeNull()
    expect(plannotatorCommandToToolInput('plannotator annotate notes.md --tailscale')).toBeNull()
  })

  test('a call without tailscale maps to the same words with or without the option', () => {
    for (const call of [
      { action: 'annotate', target: 'notes.md', gate: true, options: { markdown: true } },
      { action: 'review', target: '../wt', options: { base: 'main' } },
      { action: 'last' },
    ]) {
      const plain = parsePlannotatorToolInput(call)
      const opted = parsePlannotatorToolInput(call, { tailscale: true })
      expect(opted).toEqual(plain)
      if (plain.ok) expect(plannotatorToolArgs(plain.input)).not.toContain('--tailscale')
    }
    expect(plannotatorToolOpenedText('notes.md', 'http://localhost:1', false, 'pn-abcdef')).not.toContain('tailnet')
  })
})

describe('the tailscale opt-in', () => {
  const parse = (value: unknown) => parsePlannotatorToolInput(value, { tailscale: true })

  test('the schema and description add exactly the tailscale property and line', () => {
    const { tailscale, ...rest } = PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA.properties
    expect(tailscale.type).toBe('boolean')
    expect(rest).toEqual(PLANNOTATOR_TOOL_INPUT_SCHEMA.properties)
    expect(PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA.additionalProperties).toBe(false)
    expect(PLANNOTATOR_TOOL_TAILSCALE_DESCRIPTION.replace(`${PLANNOTATOR_TOOL_TAILSCALE_LINE}\n`, '')).toBe(PLANNOTATOR_TOOL_DESCRIPTION)
    // Claude Code cuts an MCP tool description at 2,048 characters.
    expect(PLANNOTATOR_TOOL_TAILSCALE_DESCRIPTION.length).toBeLessThan(2048)
  })

  test('annotate, review and last take it and pass --tailscale; list and close refuse it; false is tolerated', () => {
    const args = (value: unknown) => {
      const parsed = parse(value)
      if (!parsed.ok) throw new Error(parsed.error)
      return plannotatorToolArgs(parsed.input)
    }
    expect(args({ action: 'annotate', target: 'notes.md', gate: true, tailscale: true })).toEqual(['notes.md', '--gate', '--tailscale'])
    expect(args({ action: 'annotate', target: ['a.md', 'b.md'], tailscale: true })).toEqual(['a.md', 'b.md', '--tailscale'])
    expect(args({ action: 'review', options: { base: 'main' }, tailscale: true })).toEqual(['--base', 'main', '--tailscale'])
    expect(args({ action: 'review', target: 'https://github.com/o/r/pull/1', tailscale: true })).toEqual(['--tailscale', 'https://github.com/o/r/pull/1'])
    expect(args({ action: 'last', tailscale: true })).toEqual(['--tailscale'])
    expect(args({ action: 'last', tailscale: false })).toEqual([])
    expect(parse({ action: 'close', session: 'all', tailscale: true })).toEqual({ ok: false, error: 'Invalid plannotator call: tailscale is for actions "annotate", "review" and "last" only.' })
    expect(parse({ action: 'list', tailscale: 'yes' })).toEqual({ ok: false, error: 'Invalid plannotator call: tailscale must be true or false.' })
    expect(parse({ action: 'list', tailscale: false })).toEqual({ ok: true, input: { action: 'list' } })
  })

  test('the shell take-over reads --tailscale only for a host that opted in', () => {
    const opts = { tailscale: true }
    expect(plannotatorCommandToToolInput('plannotator review --tailscale', opts)).toEqual({ action: 'review', tailscale: true })
    expect(plannotatorCommandToToolInput('plannotator annotate-last --tailscale', opts)).toEqual({ action: 'last', tailscale: true })
    expect(plannotatorCommandToToolInput('plannotator annotate notes.md --tailscale --tailscale', opts)).toBeNull()
    // Script-only flags still run as written.
    expect(plannotatorCommandToToolInput('plannotator annotate notes.md --tailscale --gate --json --require-approval', opts)).toBeNull()
  })

  test('the opened text names the tailnet and who gets Ask this session', () => {
    const asked = plannotatorToolOpenedText('notes.md', 'https://m.ts.net:1/', true, 'pn-abcdef', undefined, { ask: true })
    expect(asked).toContain("served over the user's tailnet")
    expect(asked).toContain('only for the Tailscale login that owns this computer')
    expect(plannotatorToolOpenedText('notes.md', 'https://m.ts.net:1/', true, 'pn-abcdef', undefined, { ask: false })).toContain('not available on the other device')
  })
})
