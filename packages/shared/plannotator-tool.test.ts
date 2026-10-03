import { describe, expect, test } from 'bun:test'
import { parsePlannotatorToolInput, plannotatorToolArgs, PLANNOTATOR_TOOL_INPUT_SCHEMA } from './plannotator-tool'

function args(value: unknown): string[] {
  const parsed = parsePlannotatorToolInput(value)
  if (!parsed.ok) throw new Error(parsed.error)
  return plannotatorToolArgs(parsed.input)
}

function error(value: unknown): string {
  const parsed = parsePlannotatorToolInput(value)
  if (parsed.ok) throw new Error(`accepted ${JSON.stringify(value)}`)
  return parsed.error
}

describe('plannotator tool: arguments', () => {
  // The failure: a call maps to argv the slash command would not produce
  // (a lost flag, a target split in two, a flag order the CLI misreads).
  test('maps each action to the slash command words', () => {
    expect(args({ action: 'annotate', target: 'docs/my notes.md' })).toEqual(['docs/my notes.md'])
    expect(args({ action: 'annotate', target: 'spec.md', gate: true, options: { markdown: true } })).toEqual(['spec.md', '--gate', '--markdown'])
    expect(args({ action: 'review' })).toEqual([])
    expect(args({ action: 'review', target: 'https://github.com/o/r/pull/7' })).toEqual(['https://github.com/o/r/pull/7'])
    expect(args({ action: 'review', target: '../wt', options: { base: 'feature/part-1' } })).toEqual(['--base', 'feature/part-1', '../wt'])
    expect(args({ action: 'last' })).toEqual([])
  })

  test('false defaults a model fills in are ignored, not errors', () => {
    expect(args({ action: 'review', gate: false, options: { markdown: false } })).toEqual([])
    expect(args({ action: 'last', gate: false, options: {} })).toEqual([])
  })
})

describe('plannotator tool: strict validation', () => {
  test('refuses what the CLI would misread or the action does not take', () => {
    expect(error(null)).toContain('object')
    expect(error({ action: 'plan' })).toContain('action')
    expect(error({ action: 'annotate' })).toContain('needs a target')
    expect(error({ action: 'annotate', target: '--hook' })).toContain('"-"')
    expect(error({ action: 'annotate', target: 'a.md\nb.md' })).toContain('control')
    expect(error({ action: 'annotate', target: '  ' })).toContain('empty')
    expect(error({ action: 'last', target: 'x.md' })).toContain('no target')
    expect(error({ action: 'review', gate: true })).toContain('gate')
    expect(error({ action: 'annotate', target: 'a.md', options: { base: 'main' } })).toContain('options.base')
    expect(error({ action: 'review', options: { base: '-c' } })).toContain('"-"')
    expect(error({ action: 'review', options: { base: 'a b' } })).toContain('spaces')
    expect(error({ action: 'review', options: { markdown: true } })).toContain('options.markdown')
    expect(error({ action: 'review', json: true })).toContain('unknown field')
    expect(error({ action: 'review', options: { diffType: 'staged' } })).toContain('unknown option')
    expect(error({ action: 'annotate', target: 'a.md', gate: 'yes' })).toContain('gate')
  })

  test('the schema names exactly the fields the validator accepts', () => {
    expect(Object.keys(PLANNOTATOR_TOOL_INPUT_SCHEMA.properties).sort()).toEqual(['action', 'gate', 'options', 'target'])
    expect(Object.keys(PLANNOTATOR_TOOL_INPUT_SCHEMA.properties.options.properties).sort()).toEqual(['base', 'markdown'])
  })
})
