/**
 * Which PRs get a Post decisions button or menu row. The server posts decisions on GitHub, GitLab and Forgejo and
 * refuses a Bitbucket one (`forge_unsupported`), so the window must offer it exactly there. It regressed once the
 * other way: a Forgejo PR was offered the button before the server could post there, and the click came back refused.
 */
import { describe, expect, test } from 'bun:test';
import { canPostDecisionsOn } from './ThreadPulls';

describe('Post decisions is offered only where the server will post', () => {
  test.each([
    ['github', true],
    ['gitlab', true],
    ['bitbucket', false],
    ['forgejo', true],
  ] as const)('%s', (platform, offered) => {
    expect(canPostDecisionsOn({ platform })).toBe(offered);
  });
});
