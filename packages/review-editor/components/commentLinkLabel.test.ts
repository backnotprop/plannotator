/**
 * The words of a PR comment's link to its forge. What this catches: a Forgejo comment that says "View on GitHub",
 * a GitHub comment on an owner named `pulls` (or a Forgejo host named `gitlab…`) naming the wrong forge, and the
 * three existing forges' words changing.
 */
import { describe, expect, test } from 'bun:test';
import { commentLinkLabel } from './PRCommentsTab';

describe('commentLinkLabel', () => {
  test("each forge's own PRs keep their words", () => {
    expect(commentLinkLabel('github', 'https://github.com/acme/widgets/pull/3#issuecomment-9')).toBe('View on GitHub');
    expect(commentLinkLabel('gitlab', 'https://gitlab.com/g/p/-/merge_requests/3#note_9')).toBe('View on GitLab');
    expect(commentLinkLabel('bitbucket', 'https://bitbucket.org/ws/repo/pull-requests/3#comment-9')).toBe('View on Bitbucket');
    expect(commentLinkLabel('forgejo', 'https://codeberg.org/acme/widgets/pulls/3#issuecomment-9')).toBe('View on Forgejo');
  });

  test('the PR names the forge, not the text of the link', () => {
    // A GitHub owner named `pulls`, a GitHub owner with gitlab in its name, a Forgejo host named gitlab-something.
    expect(commentLinkLabel('github', 'https://github.com/pulls/widgets/pull/3#issuecomment-9')).toBe('View on GitHub');
    expect(commentLinkLabel('github', 'https://github.com/acme/x/pulls/3')).toBe('View on GitHub');
    expect(commentLinkLabel('github', 'https://github.com/gitlab-org/x/pull/3#issuecomment-9')).toBe('View on GitHub');
    expect(commentLinkLabel('forgejo', 'https://gitlab-mirror.acme.corp/acme/widgets/pulls/3#issuecomment-9')).toBe('View on Forgejo');
  });

  test('with no PR loaded, the link guesses as before', () => {
    expect(commentLinkLabel(undefined, 'https://gitlab.com/g/p/-/merge_requests/3#note_9')).toBe('View on GitLab');
    expect(commentLinkLabel(undefined, 'https://bitbucket.org/ws/repo/pull-requests/3')).toBe('View on Bitbucket');
    expect(commentLinkLabel(undefined, 'https://github.com/acme/widgets/pull/3')).toBe('View on GitHub');
  });
});
