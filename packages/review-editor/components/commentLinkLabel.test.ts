/**
 * The words of a PR comment's link to its forge. What this catches: a Forgejo comment that says "View on GitHub".
 */
import { describe, expect, test } from 'bun:test';
import { commentLinkLabel } from './PRCommentsTab';

describe('commentLinkLabel', () => {
  test('each forge names itself from its own link shape', () => {
    expect(commentLinkLabel('https://gitlab.com/g/p/-/merge_requests/3#note_9')).toBe('View on GitLab');
    expect(commentLinkLabel('https://bitbucket.org/ws/repo/pull-requests/3#comment-9')).toBe('View on Bitbucket');
    expect(commentLinkLabel('https://codeberg.org/acme/widgets/pulls/3#issuecomment-9')).toBe('View on Forgejo');
    expect(commentLinkLabel('https://git.acme.com/acme/widgets/pulls/3#issuecomment-9')).toBe('View on Forgejo');
    expect(commentLinkLabel('https://github.com/acme/widgets/pull/3#issuecomment-9')).toBe('View on GitHub');
  });

  test('a GitHub Enterprise comment is still GitHub, and /pulls without a number is not a pull request', () => {
    expect(commentLinkLabel('https://github.acme.com/acme/widgets/pull/3#discussion_r1')).toBe('View on GitHub');
    expect(commentLinkLabel('https://github.com/acme/widgets/pulls')).toBe('View on GitHub');
  });
});
