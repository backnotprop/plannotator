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

describe('a Forgejo on a host the person has not named is not offered it', () => {
  const problem = (code: string) => ({ code, kind: 'tool' as const, title: 'x', detail: 'y', at: '' });

  test('only the "host not named" reason hides it; a refused token or a failed read still shows it', () => {
    expect(canPostDecisionsOn({ platform: 'forgejo', problem: problem('forgejo.unsupported') })).toBe(false);
    expect(canPostDecisionsOn({ platform: 'forgejo', problem: problem('forgejo.signed_out') })).toBe(true);
    expect(canPostDecisionsOn({ platform: 'forgejo', problem: problem('forgejo.unavailable') })).toBe(true);
    expect(canPostDecisionsOn({ platform: 'forgejo' })).toBe(true);
  });

  test('another forge with a problem of its own is unaffected', () => {
    expect(canPostDecisionsOn({ platform: 'github', problem: problem('tool.unsupported') })).toBe(true);
    expect(canPostDecisionsOn({ platform: 'gitlab', problem: problem('forgejo.unsupported') })).toBe(true);
  });
});
