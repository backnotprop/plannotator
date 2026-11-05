import { describe, expect, test } from 'bun:test';
import { forgeFileUrl, isLiveLink } from './descriptionLinks';

const github = { url: 'https://github.com/acme/app/pull/12', platform: 'github' as const, repo: 'acme/app', head: 'kim/retry', head_repo: 'acme/app', head_sha: 'a'.repeat(40) };
const gitlab = { url: 'https://gitlab.example/group/app/-/merge_requests/9', platform: 'gitlab' as const, repo: 'group/app', head: 'kim/retry', head_repo: 'group/app', head_sha: null };

describe("a path in a PR's description", () => {
  test('is the file on the forge, at the head commit, its anchor kept', () => {
    expect(forgeFileUrl(github, null, 'docs/guide.md#setup')).toBe(`https://github.com/acme/app/blob/${'a'.repeat(40)}/docs/guide.md#setup`);
    expect(forgeFileUrl(github, 'b'.repeat(40), './src/app.ts')).toBe(`https://github.com/acme/app/blob/${'b'.repeat(40)}/src/app.ts`);
  });

  test("a path from the forge's root is the repository's: it never names this window's address", () => {
    expect(forgeFileUrl(github, null, '/api/inbox/settings')).toBe(`https://github.com/acme/app/blob/${'a'.repeat(40)}/api/inbox/settings`);
  });

  test('GitLab has its own address; with no commit known, the branch, its slash kept', () => {
    expect(forgeFileUrl(gitlab, null, 'docs/guide.md')).toBe('https://gitlab.example/group/app/-/blob/kim/retry/docs/guide.md');
  });

  test('a fork with no commit known has no address here: the branch is not in this repository', () => {
    expect(forgeFileUrl({ ...github, head_repo: 'kim/app', head_sha: null }, null, 'docs/guide.md')).toBeNull();
  });

  test('none past the repository, for a drive path, or for nothing at all', () => {
    expect(forgeFileUrl(github, null, '../../../../settings')).toBeNull();
    expect(forgeFileUrl(github, null, 'C:\\Windows\\x')).toBeNull();
    expect(forgeFileUrl(github, null, '/')).toBeNull();
  });
});

describe('which links stay live', () => {
  test("the web's schemes only, as the browser parses the link", () => {
    for (const href of ['https://a.example/', 'http://a.example/', 'mailto:kim@a.example']) expect(isLiveLink(new URL(href))).toBe(true);
    for (const href of ['vscode://file/etc/passwd', 'ssh://a.example', 'tel:123', 'java\tscript:alert(1)', 'file:///etc/passwd']) expect(isLiveLink(new URL(href))).toBe(false);
  });
});
