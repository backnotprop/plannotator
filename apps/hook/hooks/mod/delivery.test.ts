import { describe, expect, test } from 'bun:test'
import { DEFAULT_ANNOTATE_APPROVED_WITH_NOTES_PROMPT, DEFAULT_REVIEW_APPROVED_PROMPT, DEFAULT_REVIEW_APPROVED_WITH_NOTES_PROMPT } from '@plannotator/shared/prompts'
import {
  deliveryFor,
  LEGACY_ANNOTATE_APPROVED_WITH_NOTES_HEADING,
  LEGACY_ANNOTATE_NO_FEEDBACK_TEXTS,
  LEGACY_REVIEW_APPROVED_TEXT,
  LEGACY_REVIEW_APPROVED_WITH_NOTES_HEADING,
  legacyResult,
  PLAN_APPROVAL_NEXT_STEP,
  parseHostResult,
  type HostResultRecord,
} from './delivery'
import { splitShellWords } from './shell-words'
import { ANNOTATE_NO_FEEDBACK_SENTENCE } from '../../../../packages/editor/annotateSubmission'
import { exportMessageAnnotations } from '@plannotator/ui/utils/parser'

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

  // Every status line the review editor posts after a platform submission
  // (`statusMessage` in packages/review-editor/App.tsx), built the same way.
  test('every editor status line still logs as the platform post', () => {
    const lines = [
      ...['Pull request', 'Merge request'].flatMap((kind) =>
        ['approved', 'reviewed'].map((verb) => `${kind} ${verb} on GitLab: https://x/-/merge_requests/9`),
      ),
      'Changes requested on GitHub: https://x/pull/412',
      'Pull request reviewed on Bitbucket',
    ]
    for (const message of lines) {
      const delivery = deliveryFor(record({ surface: 'review', noop: true, platform: true, message }), CONTEXT)
      expect(delivery.action).toBe('log')
    }
  })

  // Old-CLI guard: 0.28.0 to 0.28.3 marked feedback with zero code annotations
  // (PR description / PR comment / editor comments only) as the platform post.
  test('an old CLI record that marked description-only feedback as the platform post is delivered', () => {
    const feedback = '## PR description\n\n> Adds the parser\n\nExplain why the fallback exists.'
    const delivery = deliveryFor(
      record({ surface: 'review', decision: 'annotated', noop: true, platform: true, annotationCount: 0, message: feedback }),
      { ...CONTEXT, subject: 'PR #412' },
    )
    expect(delivery.action).toBe('submit')
    expect(delivery.action === 'submit' && delivery.text).toContain('Explain why the fallback exists.')
    expect(delivery.action === 'submit' && delivery.text).toContain('Changes requested')
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

// An older CLI (no host result file, e.g. 0.27.25) only prints the decision
// on stdout; these are the outputs it was observed to print.
describe('legacyResult (a CLI that predates the host result file)', () => {
  test('a review approval is an LGTM, not "Changes requested"', () => {
    const lgtm = legacyResult('review', `${DEFAULT_REVIEW_APPROVED_PROMPT}\n`)
    expect(deliveryFor(lgtm, CONTEXT).action).toBe('log')
  })

  test('a review approval with notes is delivered under its own outcome', () => {
    const printed = DEFAULT_REVIEW_APPROVED_WITH_NOTES_PROMPT.replace('{{feedback}}', 'rename foo')
    const delivery = deliveryFor(legacyResult('review', printed), CONTEXT)
    expect(delivery.action).toBe('submit')
    expect(delivery.text.split('\n')[0]).toBe('Plannotator: notes.md — Approved with notes.')
    expect(delivery.text).toContain('rename foo')
  })

  // Plaintext --gate prints this when the reviewer approves with a note; a
  // launch whose result.json is missing must not read it as feedback.
  test('an annotate approval with notes is delivered under its own outcome', () => {
    const printed = DEFAULT_ANNOTATE_APPROVED_WITH_NOTES_PROMPT
      .replace('{{contextBlock}}', 'File: /x/page.html\n\n')
      .replace('{{feedback}}', 'rename the header')
    for (const kind of ['annotate', 'last'] as const) {
      const delivery = deliveryFor(legacyResult(kind, printed), CONTEXT)
      expect(delivery.action).toBe('submit')
      expect(delivery.text.split('\n')[0]).toBe('Plannotator: notes.md — Approved with notes.')
      expect(delivery.text).toContain('rename the header')
    }
    // Feedback that merely quotes the heading mid-text stays feedback.
    expect(deliveryFor(legacyResult('annotate', 'fix this\n# Approved with Notes'), CONTEXT).text).not.toContain('Approved with notes')
  })

  test('feedback, close and the annotate approval line', () => {
    expect(deliveryFor(legacyResult('review', '# Code Review Feedback\n\nfix'), CONTEXT).text).toContain('Changes requested')
    expect(deliveryFor(legacyResult('review', 'Review session closed without feedback.'), CONTEXT).action).toBe('log')
    expect(deliveryFor(legacyResult('annotate', 'The user approved.'), CONTEXT).action).toBe('log')
    expect(deliveryFor(legacyResult('annotate', ''), CONTEXT).action).toBe('log')
  })

  test('an annotate Done with nothing to send starts no turn', () => {
    for (const text of LEGACY_ANNOTATE_NO_FEEDBACK_TEXTS) {
      expect(deliveryFor(legacyResult('annotate', `${text}\n`), CONTEXT).action).toBe('log')
      expect(deliveryFor(legacyResult('last', text), CONTEXT).action).toBe('log')
    }
    // Only an annotate sentence: a review's stdout never carries it.
    expect(deliveryFor(legacyResult('review', LEGACY_ANNOTATE_NO_FEEDBACK_TEXTS[0]!), CONTEXT).action).toBe('submit')
  })

  // The mod cannot import the editor: its copies must follow the editor's payloads.
  test('the recognized no-feedback texts are what the editor posts', () => {
    expect([...LEGACY_ANNOTATE_NO_FEEDBACK_TEXTS]).toEqual([ANNOTATE_NO_FEEDBACK_SENTENCE, exportMessageAnnotations([])])
  })

  // The mod cannot import packages/shared: its copies must follow the CLI's defaults.
  test('the recognized approval texts are the CLI defaults', () => {
    expect(LEGACY_REVIEW_APPROVED_TEXT).toBe(DEFAULT_REVIEW_APPROVED_PROMPT)
    expect(DEFAULT_REVIEW_APPROVED_WITH_NOTES_PROMPT.split('\n')[0]).toBe(LEGACY_REVIEW_APPROVED_WITH_NOTES_HEADING)
    expect(DEFAULT_ANNOTATE_APPROVED_WITH_NOTES_PROMPT.split('\n')[0]).toBe(LEGACY_ANNOTATE_APPROVED_WITH_NOTES_HEADING)
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
