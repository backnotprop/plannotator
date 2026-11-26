/**
 * The PR image rewriter (#2328): which image URLs in a PR's text load through
 * the server's `/api/pr-artifact-content` proxy, which reads them with the
 * reviewer's token.
 *
 * What regresses if this fails:
 *  - a private GitHub attachment loads directly again and shows broken;
 *  - any other image (a badge, a CDN, a relative path, a lookalike host) is
 *    sent to the proxy, which refuses it, so it stops loading;
 *  - a GitLab MR or a GitHub Enterprise PR proxies github.com attachments,
 *    which the server answers with 403 there;
 *  - a `<picture>`'s dark-mode `srcset` keeps a direct URL to a private image.
 */
import { describe, expect, test } from 'bun:test';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import { forgejoImageHandling, prImageSrc, prImageSrcset, proxiesGitHubImages, resolvePRImage } from './prImage';

const proxied = (url: string) => `/api/pr-artifact-content?${new URLSearchParams({ url })}`;

describe('prImageSrc', () => {
  test('routes the three GitHub attachment shapes through the proxy', () => {
    for (const url of [
      'https://github.com/user-attachments/assets/0f1e2d3c-4b5a',
      'https://github.com/user-attachments/files/123/report.png',
      'https://user-images.githubusercontent.com/1/shot.png',
      'https://private-user-images.githubusercontent.com/1/shot.png?jwt=abc',
    ]) {
      expect(prImageSrc(url)).toBe(proxied(url));
    }
  });

  test('leaves every other image URL untouched', () => {
    for (const url of [
      'https://img.shields.io/badge/ci-passing-green',
      'https://github.com/acme/widgets/blob/main/shot.png',
      'https://github.com/user-attachments-not/assets/1',
      'https://gist.github.com/user-attachments/assets/1',
      'https://user-images.githubusercontent.com.evil.example/1/shot.png',
      'http://github.com/user-attachments/assets/1',
      'https://github.com:8443/user-attachments/assets/1',
      'https://user:pass@github.com/user-attachments/assets/1',
      'docs/shot.png',
      '/shot.png',
      'data:image/png;base64,iVBORw0KGgo=',
    ]) {
      expect(prImageSrc(url)).toBe(url);
      expect(resolvePRImage(url)).toBeNull();
    }
  });

  test('a srcset keeps its descriptors and proxies only attachment candidates', () => {
    const dark = 'https://github.com/user-attachments/assets/dark';
    const badge = 'https://img.shields.io/badge/x-y-z';
    expect(prImageSrcset(`${dark} 2x, ${badge} 1x`)).toBe(`${proxied(dark)} 2x, ${badge} 1x`);
    expect(prImageSrcset(dark)).toBe(proxied(dark));
  });

  // A comma inside a candidate's URL is not a separator: splitting on it
  // would turn `data:image/png;base64,AAAA 2x` into two broken candidates.
  test('a data: candidate keeps the comma in its URL', () => {
    const dark = 'https://github.com/user-attachments/assets/dark';
    const inline = 'data:image/png;base64,AAAA';
    expect(prImageSrcset(`${inline} 2x, ${dark} 1x`)).toBe(`${inline} 2x, ${proxied(dark)} 1x`);
    expect(prImageSrcset(`${dark} 1x,${inline} 2x`)).toBe(`${proxied(dark)} 1x, ${inline} 2x`);
  });
});

describe('proxiesGitHubImages', () => {
  test('only a PR on github.com proxies attachment images', () => {
    expect(proxiesGitHubImages({ platform: 'github', url: 'https://github.com/acme/widgets/pull/1' })).toBe(true);
    expect(proxiesGitHubImages({ platform: 'github', url: 'https://github.example.com/acme/widgets/pull/1' })).toBe(false);
    expect(proxiesGitHubImages({ platform: 'gitlab', url: 'https://gitlab.com/acme/widgets/-/merge_requests/7' })).toBe(false);
    expect(proxiesGitHubImages(null)).toBe(false);
  });
});

/**
 * A Forgejo PR's own uploads in comment text. What regresses if this fails: the
 * Overview shows `![shot.png](/attachments/…)` as plain text again, or an image
 * from some other place is sent to the proxy.
 */
describe('forgejoImageHandling', () => {
  const pr = {
    platform: 'forgejo', host: 'forgejo.example.com', owner: 'acme', repo: 'widgets', number: 5, title: 't', author: 'a',
    baseBranch: 'main', headBranch: 'b', baseSha: 'x', headSha: 'y', url: 'https://forgejo.example.com/acme/widgets/pulls/5',
  } as PRMetadata;
  const uuid = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
  const handling = forgejoImageHandling(pr)!;

  test('makes the editor\'s relative upload links absolute on the PR\'s origin, in both shapes', () => {
    expect(handling.prepare(`Screenshot: ![dot.png](/attachments/${uuid})`)).toBe(`Screenshot: ![dot.png](https://forgejo.example.com/attachments/${uuid})`);
    expect(handling.prepare(`![a](/acme/widgets/attachments/${uuid})`)).toBe(`![a](https://forgejo.example.com/acme/widgets/attachments/${uuid})`);
  });

  test('leaves an upload link inside fenced or inline code as written', () => {
    const own = `![dot.png](/attachments/${uuid})`;
    const fenced = ['```md', own, '```', '~~~', own, '~~~'].join('\n');
    expect(handling.prepare(fenced)).toBe(fenced);
    expect(handling.prepare(`Write \`${own}\` to embed it.`)).toBe(`Write \`${own}\` to embed it.`);
    // Text after a closed fence, and beside a code span, is still rewritten.
    expect(handling.prepare(['```', 'code', '```', own].join('\n'))).toBe(['```', 'code', '```', `![dot.png](https://forgejo.example.com/attachments/${uuid})`].join('\n'));
    expect(handling.prepare(`\`x\` ${own}`)).toBe(`\`x\` ![dot.png](https://forgejo.example.com/attachments/${uuid})`);
  });

  test('leaves any other image as written', () => {
    for (const text of ['![x](/somewhere/else.png)', '![x](/other/repo/attachments/' + uuid + ')', '![x](https://example.com/attachments/' + uuid + ')', '![x](/attachments/not-a-uuid)']) {
      expect(handling.prepare(text)).toBe(text);
    }
  });

  test('loads the PR\'s own upload through the proxy, and nothing else', () => {
    const own = `https://forgejo.example.com/attachments/${uuid}`;
    expect(handling.src(own)).toBe(proxied(own));
    expect(handling.src(`https://evil.example/attachments/${uuid}`)).toBe(`https://evil.example/attachments/${uuid}`);
    expect(handling.src('https://forgejo.example.com/acme/widgets/raw/branch/main/a.png')).toBe('https://forgejo.example.com/acme/widgets/raw/branch/main/a.png');
  });

  test('resolves the PR\'s own upload, as written, for the description renderer; anything else keeps its default', () => {
    expect(handling.resolve(`/attachments/${uuid}`)).toEqual({ kind: 'src', src: proxied(`https://forgejo.example.com/attachments/${uuid}`) });
    expect(handling.resolve(`https://evil.example/attachments/${uuid}`)).toBeNull();
    expect(handling.resolve('/somewhere/else.png')).toBeNull();
  });

  test('is off for a PR that is not Forgejo', () => {
    expect(forgejoImageHandling({ ...pr, platform: 'github' } as unknown as PRMetadata)).toBeNull();
    expect(forgejoImageHandling(null)).toBeNull();
  });
});
