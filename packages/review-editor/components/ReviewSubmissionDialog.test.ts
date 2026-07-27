import { describe, expect, test } from 'bun:test';
import {
  buildPlatformReviewBody,
  type SubmissionTarget,
} from './ReviewSubmissionDialog';

const inlineComment: SubmissionTarget['fileComments'][number] = {
  path: 'src/example.ts',
  line: 12,
  side: 'RIGHT',
  body: 'Handle the error here.',
};

describe('buildPlatformReviewBody', () => {
  test('contains only user-authored top-level feedback when present', () => {
    expect(buildPlatformReviewBody('comment', 'github', 'Overall feedback', {
      fileComments: [inlineComment],
      fileScopedBody: '**src/example.ts:** File-level feedback',
    })).toBe('Overall feedback\n\n**src/example.ts:** File-level feedback');
  });

  test('uses a neutral GitHub body for an inline-only comment review', () => {
    expect(buildPlatformReviewBody('comment', 'github', '   ', {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('See inline comments.');
  });

  test('does not manufacture a GitLab note for inline-only comments', () => {
    expect(buildPlatformReviewBody('comment', 'gitlab', undefined, {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('');
  });

  test('does not manufacture an approval body', () => {
    expect(buildPlatformReviewBody('approve', 'github', undefined, {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('');
  });
});
