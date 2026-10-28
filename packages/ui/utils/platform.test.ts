/**
 * rootPlatform decides which pages get the Linux-only font-feature rule
 * (#1961): desktop Linux must, and macOS, iOS, Windows, Android and ChromeOS
 * must not (their look stays as it was). Real navigator values, including the
 * ones that also say "Linux" (Android, ChromeOS).
 */
import { expect, test } from 'bun:test';
import { rootPlatform } from './platform';

const cases: Array<[string, Parameters<typeof rootPlatform>[0], ReturnType<typeof rootPlatform>]> = [
  ['Chrome on macOS', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', userAgentData: { platform: 'macOS' } }, 'apple'],
  ['Safari on macOS', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' }, 'apple'],
  ['Safari on iPhone', { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }, 'apple'],
  ['Chrome on Windows', { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', userAgentData: { platform: 'Windows' } }, 'windows'],
  ['Chrome on Linux', { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', userAgentData: { platform: 'Linux' } }, 'linux'],
  ['Firefox on Linux', { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }, 'linux'],
  ['Firefox on FreeBSD', { platform: 'FreeBSD amd64', userAgent: 'Mozilla/5.0 (X11; FreeBSD amd64; rv:140.0) Gecko/20100101 Firefox/140.0' }, 'linux'],
  ['Chrome on Android', { platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', userAgentData: { platform: 'Android' } }, 'android'],
  ['Chrome on ChromeOS', { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', userAgentData: { platform: 'Chrome OS' } }, 'chromeos'],
];

for (const [name, nav, expected] of cases) {
  test(`${name} is ${expected}`, () => {
    expect(rootPlatform(nav)).toBe(expected);
  });
}

test('no navigator is other', () => {
  expect(rootPlatform(null)).toBe('other');
});
