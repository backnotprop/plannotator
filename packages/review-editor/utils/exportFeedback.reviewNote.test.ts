import { describe, expect, it } from 'bun:test';
import { exportReviewFeedback } from './exportFeedback';
import type { CodeAnnotation } from '@plannotator/ui/types';

/**
 * The review-level note produced by the Send control's "Send with additional
 * feedback" action is a scope:'general' CodeAnnotation. These guard the export
 * shape it depends on — the whole feature rides the existing ## General
 * section, with no new export code.
 */

const note = (text: string): CodeAnnotation => ({
  id: 'review-note-1',
  type: 'comment',
  scope: 'general',
  filePath: '',
  lineStart: 0,
  lineEnd: 0,
  side: 'new',
  text,
  createdAt: 1,
});

const lineComment = (): CodeAnnotation => ({
  id: 'c1',
  type: 'comment',
  filePath: 'src/index.ts',
  lineStart: 10,
  lineEnd: 10,
  side: 'new',
  text: 'this branch is unreachable',
  createdAt: 2,
});

describe('exportReviewFeedback - review-level note', () => {
  // Guards giving the note a filePath or scope:'line', which would export it as
  // a comment on a file that is not in the diff (and create a group for "").
  it('renders under ## General and creates no file group', () => {
    const output = exportReviewFeedback([note('rebase before merging')]);
    const generalIndex = output.indexOf('## General');
    expect(generalIndex).toBeGreaterThan(-1);
    expect(output.indexOf('rebase before merging')).toBeGreaterThan(generalIndex);
    // No group header for the empty sentinel path.
    expect(output).not.toContain('## \n');
    expect(output).not.toMatch(/^## $/m);
  });

  // Guards the general/placed partition being bypassed, which would drop one
  // side or the other when a note is sent together with annotations.
  it('co-exists with placed annotations: both the file group and General survive', () => {
    const output = exportReviewFeedback([lineComment(), note('and split the migration')]);
    expect(output).toContain('## src/index.ts');
    expect(output).toContain('this branch is unreachable');
    expect(output).toContain('## General');
    expect(output).toContain('and split the migration');
  });

  it('a note alone is real feedback, not the empty-review message', () => {
    const output = exportReviewFeedback([note('ship it after the docs land')]);
    expect(output).not.toContain('No feedback provided.');
  });
});
