/**
 * Outdated PR comments (#1590) in the two outputs a reviewer's comments reach:
 * the agent feedback export and a hosted PR review submission.
 */
import { describe, expect, test } from 'bun:test';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { exportReviewFeedback, OUTDATED_ANNOTATION_LABEL } from './exportFeedback';
import { buildReviewSubmission } from '../components/ReviewSubmissionDialog';

const PR_URL = 'https://github.com/acme/widgets/pull/42';

function comment(partial: Partial<CodeAnnotation>): CodeAnnotation {
  return {
    id: 'c',
    type: 'comment',
    scope: 'line',
    filePath: 'src/a.ts',
    lineStart: 12,
    lineEnd: 12,
    side: 'new',
    text: 'Rename this.',
    createdAt: 1,
    prUrl: PR_URL,
    ...partial,
  };
}

describe('agent feedback export', () => {
  test('labels an outdated comment and only that one', () => {
    const out = exportReviewFeedback([
      comment({ id: 'stale', text: 'Stale remark', outdated: true }),
      comment({ id: 'fresh', text: 'Fresh remark', lineStart: 20, lineEnd: 20 }),
    ]);
    expect(out.split(OUTDATED_ANNOTATION_LABEL).length - 1).toBe(1);
    const staleAt = out.indexOf('Stale remark');
    const labelAt = out.indexOf(OUTDATED_ANNOTATION_LABEL);
    expect(labelAt).toBeGreaterThan(-1);
    expect(labelAt).toBeLessThan(staleAt);
    expect(labelAt).toBeLessThan(out.indexOf('Line 20'));
  });

  test('exports without the field are unchanged by it', () => {
    const plain = comment({});
    expect(exportReviewFeedback([plain])).toBe(exportReviewFeedback([{ ...plain, outdated: undefined }]));
    expect(exportReviewFeedback([plain])).not.toContain(OUTDATED_ANNOTATION_LABEL);
  });
});

describe('hosted PR review submission', () => {
  test('an outdated line comment is never posted inline at its stale line; it rides the review body', () => {
    const submission = buildReviewSubmission(
      [
        comment({ id: 'stale', text: 'Stale remark', outdated: true }),
        comment({ id: 'fresh', text: 'Fresh remark', lineStart: 20, lineEnd: 20 }),
      ],
      [],
      PR_URL,
      new Set(['src/a.ts']),
    );
    const [target] = submission.targets;
    expect(target.fileComments.map((c) => c.line)).toEqual([20]);
    expect(target.fileScopedBody).toContain('Stale remark');
    expect(target.fileScopedBody).toContain(OUTDATED_ANNOTATION_LABEL);
    expect(target.fileScopedBody).toContain('src/a.ts');
  });

  test('a comment on a PR whose snapshot this page never saw is posted inline, not as Outdated', () => {
    // Regression (#1592): PR 42 comment, switch to 43 and comment, back to 42,
    // reload, restore, Post. After the reload only 42's snapshot is known, and
    // 43's untouched comment was posted to its body labelled Outdated.
    const OTHER = 'https://github.com/acme/widgets/pull/43';
    const submission = buildReviewSubmission(
      [
        comment({ id: 'other', prUrl: OTHER, text: 'On 43', lineStart: 12, lineEnd: 12, anchorSnapshot: 's43', anchorText: 'const x = 1;' }),
        comment({ id: 'here', text: 'On 42', lineStart: 20, lineEnd: 20, anchorSnapshot: 'now' }),
      ],
      [],
      PR_URL,
      new Set(['src/a.ts']),
      undefined,
      new Map([[PR_URL, 'now']]),
    );
    const other = submission.targets.find((t) => t.prUrl === OTHER)!;
    const here = submission.targets.find((t) => t.prUrl === PR_URL)!;
    expect(other.fileComments.map((c) => c.line)).toEqual([12]);
    expect(other.fileScopedBody).not.toContain(OUTDATED_ANNOTATION_LABEL);
    expect(here.fileComments.map((c) => c.line)).toEqual([20]);
  });

  test('a comment stamped on a snapshot its PR has moved past rides the body with its code, but is not labelled Outdated', () => {
    const OTHER = 'https://github.com/acme/widgets/pull/43';
    const submission = buildReviewSubmission(
      [comment({ id: 'other', prUrl: OTHER, text: 'On 43', anchorSnapshot: 'gone', anchorText: 'const legacy = 1;' })],
      [],
      PR_URL,
      new Set(['src/a.ts']),
      undefined,
      new Map([[PR_URL, 'now'], [OTHER, 's43-new']]),
    );
    const [other] = submission.targets;
    expect(other.fileComments).toEqual([]);
    expect(other.fileScopedBody).toContain('On 43');
    expect(other.fileScopedBody).toContain('const legacy = 1;');
    expect(other.fileScopedBody).not.toContain(OUTDATED_ANNOTATION_LABEL);
  });
});
