/**
 * The mark next to a PR in the review page (header, file tree, post destination). What can regress: a Forgejo
 * PR drawn with GitHub's mark, or one host's mark changing for another.
 */
import { expect, test } from 'bun:test';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitHubIcon } from './GitHubIcon';
import { GitLabIcon } from './GitLabIcon';
import { BitbucketIcon, ForgejoIcon, PRPlatformIcon } from './PRPlatformIcon';

const mark = (platform: string) => renderToStaticMarkup(createElement(PRPlatformIcon, { platform, className: 'm' }));
const icon = (component: FC<{ className?: string }>) => renderToStaticMarkup(createElement(component, { className: 'm' }));

test('each platform gets its own mark, and a Forgejo PR is never drawn with GitHub\'s', () => {
  expect(mark('github')).toBe(icon(GitHubIcon));
  expect(mark('gitlab')).toBe(icon(GitLabIcon));
  expect(mark('bitbucket')).toBe(icon(BitbucketIcon));
  expect(mark('forgejo')).toBe(icon(ForgejoIcon));
  expect(mark('forgejo')).not.toBe(icon(GitHubIcon));
});
