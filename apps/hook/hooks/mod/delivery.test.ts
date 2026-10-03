import { describe, expect, test } from 'bun:test'
import { deliveryFor, PLAN_APPROVAL_NEXT_STEP, parseHostResult, type HostResultRecord } from './delivery'
import { splitShellWords } from './shell-words'

const CONTEXT = { subject: 'notes.md', overflowPath: '/data/x/feedback.md' }

function record(overrides: Partial<HostResultRecord>): HostResultRecord {
  return { v: 1, surface: 'annotate', decision: 'annotated', message: 'fix it', noop: false, ...overrides }
}

describe('deliveryFor', () => {
  test('feedback is submitted with one line naming subject and outcome, the message unchanged', () => {
    const delivery = deliveryFor(record({ annotationCount: 3, message: '# Markdown Annotations\n\nfix it' }), CONTEXT)
    expect(delivery).toEqual({ action: 'submit', text: 'Plannotator: notes.md — Feedback · 3 comments.\n\n# Markdown Annotations\n\nfix it' })
  })

  test('Done, LGTM and Close never start a turn', () => {
    for (const noop of [
      record({ noop: true, message: '' }),
      record({ surface: 'review', decision: 'approved', noop: true, message: '' }),
      record({ decision: 'dismissed', noop: true, message: '' }),
    ]) {
      expect(deliveryFor(noop, CONTEXT).action).toBe('log')
    }
  })

  test('a review posted to the PR platform logs and suggests the follow-up', () => {
    const delivery = deliveryFor(
      record({ surface: 'review', noop: true, platform: true, message: 'Pull request reviewed on GitHub: https://x/pull/412' }),
      { ...CONTEXT, subject: 'PR #412' },
    )
    expect(delivery.action).toBe('log')
    expect(delivery.action === 'log' && delivery.suggest).toBe('address the review comments on PR #412')
  })

  test('a plan approval asks for the ExitPlanMode call that completes it', () => {
    const delivery = deliveryFor(record({ surface: 'plan', decision: 'approved', message: 'Plan approved.' }), { ...CONTEXT, subject: 'Plan v2' })
    expect(delivery.action === 'submit' && delivery.text.endsWith(PLAN_APPROVAL_NEXT_STEP)).toBe(true)
  })

  test('feedback over the limit goes to a file in full and Claude is told to read it', () => {
    const big = 'x'.repeat(13 * 1024)
    const delivery = deliveryFor(record({ message: big }), CONTEXT)
    expect(delivery.action).toBe('submit')
    if (delivery.action !== 'submit') return
    expect(delivery.overflow?.text.trimEnd()).toBe(big)
    expect(delivery.text).toContain(CONTEXT.overflowPath)
    expect(delivery.text.length).toBeLessThan(1000)
  })
})

describe('parseHostResult', () => {
  test('refuses records that are not the CLI host result', () => {
    expect(parseHostResult('{"v":1,"surface":"plan","decision":"approved","message":"m","noop":false}')).not.toBeNull()
    expect(parseHostResult('{"decision":"approved"}')).toBeNull()
    expect(parseHostResult('{"v":1,"surface":"plan","decision":"maybe","message":"","noop":false}')).toBeNull()
    expect(parseHostResult('not json')).toBeNull()
  })
})

describe('splitShellWords', () => {
  test('splits like the shell line the skill used, without expanding anything', () => {
    expect(splitShellWords('')).toEqual([])
    expect(splitShellWords('  a  b ')).toEqual(['a', 'b'])
    expect(splitShellWords(`"my file.md" 'it''s' a\\ b`)).toEqual(['my file.md', 'its', 'a b'])
    expect(splitShellWords('"say \\"hi\\"" $HOME *.md')).toEqual(['say "hi"', '$HOME', '*.md'])
    expect(splitShellWords('--base "feature one"')).toEqual(['--base', 'feature one'])
  })
})
