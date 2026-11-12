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
