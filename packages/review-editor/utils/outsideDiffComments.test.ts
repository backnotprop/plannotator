/**
 * Comments outside the diff (approved design record "review-explorer",
 * answer 3): a comment on a file the review does not change, or on a changed
 * file's lines outside its hunks.
 *
 * Regressions guarded:
 *  - such a comment posted inline on a PR (every platform refuses it) instead
 *    of in the review body with the quoted code and a permalink;
 *  - the agent getting it without the code or without the "(not in the diff)"
 *    label;
 *  - a diff re-check (a push, a restored draft) marking it Outdated because
 *    its lines are not in the patch;
 *  - the Whole file view's change bars on the wrong lines.
 */
import { describe, expect, test } from 'bun:test';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { prBlobPermalink, type PRMetadata } from '@plannotator/shared/pr-types';
import { buildReviewSubmission, OUTSIDE_DIFF_BODY_HEADING, OUTSIDE_DIFF_QUOTE_MAX_LINES } from '../components/ReviewSubmissionDialog';
import { exportReviewFeedback, OUTSIDE_DIFF_ANNOTATION_LABEL } from './exportFeedback';
import { canPostInline, reanchorCodeAnnotations } from './codeAnnotationAnchor';
import { wholeFileMarks, wholeFileMarksCss } from './wholeFileMarks';
import type { DiffFile } from '../types';

const PR = 'https://github.com/acme/app/pull/7';
const github = {
  platform: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'app',
  number: 7,
  url: PR,
  headSha: 'abc123def',
} as unknown as PRMetadata;

function comment(overrides: Partial<CodeAnnotation>): CodeAnnotation {
  return {
    id: overrides.id ?? 'c1',
    type: 'comment',
    scope: 'line',
    filePath: 'src/a.ts',
    lineStart: 10,
    lineEnd: 11,
    side: 'new',
    text: 'note',
    createdAt: 1,
    prUrl: PR,
    prNumber: 7,
    prTitle: 'Change',
    prRepo: 'acme/app',
    ...overrides,
  };
}

const outside = comment({
  id: 'out',
  filePath: 'packages/ui/utils/diffFileTree.ts',
  lineStart: 49,
  lineEnd: 52,
  text: 'Should this move to a worker?',
  outsideDiff: true,
  anchorText: 'function buildTrie() {\n  const root = {};',
});
const inline = comment({ id: 'in', text: 'Inline note' });

describe('a PR review: comments outside the diff go in the review body', () => {
  test('never inline; in the body with the code and a permalink at the head commit', () => {
    const { targets } = buildReviewSubmission(
      [inline, outside],
      [],
      PR,
      new Set(['src/a.ts']),
      undefined,
      undefined,
      'github',
      (path, start, end) => prBlobPermalink(github, path, start, end),
    );
    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(target.fileComments.map((c) => c.body)).toEqual(['Inline note']);
    expect(target.outsideDiffCount).toBe(1);
    expect(target.fileScopedBody).toBe(
      [
        `**${OUTSIDE_DIFF_BODY_HEADING}**`,
        '',
        '**[packages/ui/utils/diffFileTree.ts (L49-L52)](https://github.com/acme/app/blob/abc123def/packages/ui/utils/diffFileTree.ts#L49-L52):** Should this move to a worker?',
        '',
        '```',
        'function buildTrie() {\n  const root = {};',
        '```',
      ].join('\n'),
    );
  });

  test('a long quote is capped (the permalink shows the rest), so the body stays under the platform limit', () => {
    const long = comment({
      id: 'long',
      filePath: 'src/big.ts',
      lineStart: 1,
      lineEnd: 500,
      outsideDiff: true,
      anchorText: Array.from({ length: 500 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'),
    });
    const { targets } = buildReviewSubmission([long], [], PR, new Set(), undefined, undefined, 'github', (p, a, b) => prBlobPermalink(github, p, a, b));
    const body = targets[0].fileScopedBody;
    expect(body).toContain(`const line${OUTSIDE_DIFF_QUOTE_MAX_LINES} = ${OUTSIDE_DIFF_QUOTE_MAX_LINES};\n…\n`);
    expect(body).not.toContain(`const line${OUTSIDE_DIFF_QUOTE_MAX_LINES + 1} =`);
    expect(body).toContain('#L1-L500');
  });

  test('each comment links to lines at its own PR head (a stacked review)', () => {
    const lower = 'https://github.com/acme/app/pull/6';
    const fromLower = comment({ id: 'low', prUrl: lower, prNumber: 6, outsideDiff: true, anchorText: 'x', filePath: 'a.ts', lineStart: 2, lineEnd: 2 });
    const heads: Record<string, PRMetadata> = { [PR]: github, [lower]: { ...github, url: lower, number: 6, headSha: 'lowerhead' } as unknown as PRMetadata };
    const { targets } = buildReviewSubmission([fromLower], [], PR, new Set(), undefined, undefined, 'github',
      (p, a, b, annotation) => prBlobPermalink(heads[annotation?.prUrl ?? PR], p, a, b));
    const lowerTarget = targets.find((t) => t.prUrl === lower) ?? targets[0];
    expect(lowerTarget.fileScopedBody).toContain('/blob/lowerhead/a.ts#L2');
  });

  test('a review with no comment outside the diff says nothing about them', () => {
    const { targets } = buildReviewSubmission([inline], [], PR, new Set(['src/a.ts']), undefined, undefined, 'github');
    expect(targets[0].outsideDiffCount).toBeUndefined();
    expect(targets[0].fileScopedBody).toBe('');
  });

  test('canPostInline refuses it whatever the snapshots say', () => {
    expect(canPostInline(outside, undefined, PR)).toBe(false);
    expect(canPostInline(inline, undefined, PR)).toBe(true);
  });
});

describe('permalinks per platform', () => {
  test('GitHub, GitLab and Bitbucket line links', () => {
    expect(prBlobPermalink(github, 'a b/c.ts', 3, 3)).toBe('https://github.com/acme/app/blob/abc123def/a%20b/c.ts#L3');
    const gitlab = { platform: 'gitlab', host: 'gitlab.example.com', projectPath: 'g/p', iid: 2, headSha: 'f00' } as unknown as PRMetadata;
    expect(prBlobPermalink(gitlab, 'x.ts', 4, 6)).toBe('https://gitlab.example.com/g/p/-/blob/f00/x.ts#L4-6');
    const bitbucket = { platform: 'bitbucket', host: 'bitbucket.org', workspace: 'w', repo: 'r', number: 1, headSha: 'beef' } as unknown as PRMetadata;
    expect(prBlobPermalink(bitbucket, 'x.ts', 4, 6)).toBe('https://bitbucket.org/w/r/src/beef/x.ts#lines-4:6');
  });
});

describe('to the agent', () => {
  test('labelled "(not in the diff)" with the code fenced', () => {
    const markdown = exportReviewFeedback([outside]);
    expect(markdown).toContain(`### Lines 49-52 (new) ${OUTSIDE_DIFF_ANNOTATION_LABEL}`);
    expect(markdown).toContain('Should this move to a worker?');
    expect(markdown).toContain('**Code:**\n```\nfunction buildTrie() {\n  const root = {};\n```');
    // An ordinary comment keeps its heading.
    expect(exportReviewFeedback([inline])).not.toContain(OUTSIDE_DIFF_ANNOTATION_LABEL);
  });
});

describe('a diff re-check leaves it alone', () => {
  test('never marked Outdated by a new patch', () => {
    const files: DiffFile[] = [
      { path: 'src/a.ts', patch: '@@ -1,1 +1,1 @@\n-a\n+b', additions: 1, deletions: 1, status: 'modified' },
    ];
    const stamped = { ...outside, anchorSnapshot: 'old-snapshot' };
    const result = reanchorCodeAnnotations([stamped], files, { currentSnapshot: 'new-snapshot', patchChanged: true });
    expect(result[0].outdated).toBeUndefined();
  });
});

describe('change bars for the Whole file view', () => {
  test('added, modified and removed runs on the new side', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,6 +1,7 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '+inserted',
      ' four',
      '-five',
      ' six',
      '@@ -20,2 +21,3 @@',
      ' twenty',
      '+new last',
      ' end',
    ].join('\n');
    expect(wholeFileMarks(patch)).toEqual({ added: [4, 22], modified: [2], removedBefore: [6] });
    const css = wholeFileMarksCss(wholeFileMarks(patch));
    expect(css).toContain('[data-gutter] [data-column-number="2"]');
    expect(css).toContain('--diffs-modified-base');
    expect(css).toContain('--diffs-deletion-base');
  });
});
