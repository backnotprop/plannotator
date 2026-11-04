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
import { prImageSrc, prImageSrcset, proxiesGitHubImages, resolvePRImage } from './prImage';

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
});

describe('proxiesGitHubImages', () => {
  test('only a PR on github.com proxies attachment images', () => {
    expect(proxiesGitHubImages({ platform: 'github', url: 'https://github.com/acme/widgets/pull/1' })).toBe(true);
    expect(proxiesGitHubImages({ platform: 'github', url: 'https://github.example.com/acme/widgets/pull/1' })).toBe(false);
    expect(proxiesGitHubImages({ platform: 'gitlab', url: 'https://gitlab.com/acme/widgets/-/merge_requests/7' })).toBe(false);
    expect(proxiesGitHubImages(null)).toBe(false);
  });
});
