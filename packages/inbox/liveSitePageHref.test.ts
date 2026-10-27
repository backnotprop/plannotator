/**
 * The live pane's "Open in browser" link: the page comes from the bridge,
 * which the proxied app's own script can forge, so only a path on the site
 * is used; anything else opens the site's own address.
 */
import { expect, test } from 'bun:test';
import { LIVE_FRAME_SANDBOX, pageHref } from './components/LiveSitePane';

const SITE = 'http://localhost:5173/';

test('a path on the site opens that page', () => {
  expect(pageHref(SITE, '/settings?tab=billing')).toBe('http://localhost:5173/settings?tab=billing');
  expect(pageHref(SITE, null)).toBe(SITE);
});

test('anything off the site opens the site itself', () => {
  for (const page of ['//evil.example/login', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', 'settings', '/a\nb', `/${'a'.repeat(2048)}`]) {
    expect([page, pageHref(SITE, page)]).toEqual([page, SITE]);
  }
});

test('the live frame may never navigate the Inbox window', () => {
  expect(LIVE_FRAME_SANDBOX.split(' ')).not.toContain('allow-top-navigation');
  expect(LIVE_FRAME_SANDBOX.split(' ')).not.toContain('allow-top-navigation-by-user-activation');
});
