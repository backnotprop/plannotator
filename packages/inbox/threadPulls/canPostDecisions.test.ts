/**
 * Which PRs get a Post decisions button or menu row. The server posts decisions on GitHub and GitLab only and refuses
 * a Bitbucket or Forgejo one (`forge_unsupported`), so the window must not offer it there. What regressed: a Forgejo
 * PR was offered the button and the person's click came back as a refusal.
 */
import { describe, expect, test } from 'bun:test';
import { canPostDecisionsOn } from './ThreadPulls';

describe('Post decisions is offered only where the server will post', () => {
  test.each([
    ['github', true],
    ['gitlab', true],
    ['bitbucket', false],
    ['forgejo', false],
  ] as const)('%s', (platform, offered) => {
    expect(canPostDecisionsOn({ platform })).toBe(offered);
  });
});
