/**
 * PR comment HTML with private GitHub attachments (#2328), as MarkdownBody
 * renders it with `authenticatedImages` (a PR on github.com).
 *
 * What regresses if this fails:
 *  - an attachment `<img>` in a comment loads directly and shows broken;
 *  - a README-style `<picture>` loses its dark-mode `<source>`, or keeps a
 *    direct URL to a private image in it;
 *  - a non-attachment image is sent to the proxy, which refuses it;
 *  - without `authenticatedImages` (any other PR) a comment's images change.
 *
 * happy-dom's parser drops the `<picture>` wrapper (its `<source>` stays), so
 * the source is found by its `media`.
 *
 * DOM-gated (DOM_TESTS=1, listed in tests/dom-test-list.txt).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarkdownBody } from './MarkdownBody';

const hasDom = typeof document !== 'undefined';

const LIGHT = 'https://github.com/user-attachments/assets/light';
const DARK = 'https://github.com/user-attachments/assets/dark';
const BADGE = 'https://img.shields.io/badge/ci-passing-green';
const COMMENT = [
  `<picture><source media="(prefers-color-scheme: dark)" srcset="${DARK}"><img src="${LIGHT}" alt="diagram"></picture>`,
  `<img src="${BADGE}" alt="badge">`,
].join(' ');

const BASE = "http://review.test";
const absolute = (value: string | null | undefined) =>
  new URL(value ?? "", typeof location !== "undefined" && location.origin !== "null" ? location.origin : BASE).href;
const proxied = (url: string) => absolute(`/api/pr-artifact-content?${new URLSearchParams({ url })}`);

describe.if(hasDom)('MarkdownBody PR images (DOM)', () => {
  let roots: Root[] = [];
  let hosts: HTMLElement[] = [];

  async function render(node: React.ReactElement): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    hosts.push(host);
    await act(async () => {
      root.render(node);
    });
    return host;
  }

  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    for (const host of hosts) host.remove();
    roots = [];
    hosts = [];
  });

  test('attachments load through the proxy, and the dark-mode source is kept', async () => {
    const el = await render(<MarkdownBody authenticatedImages markdown={COMMENT} />);
    const source = el.querySelector('source[media="(prefers-color-scheme: dark)"]');
    expect(absolute(source?.getAttribute('srcset'))).toBe(proxied(DARK));
    const [diagram, badge] = Array.from(el.querySelectorAll('img'));
    expect(absolute(diagram?.getAttribute('src'))).toBe(proxied(LIGHT));
    expect(badge?.getAttribute('src')).toBe(BADGE);
  });

  test('without authenticatedImages every image is left as written', async () => {
    const el = await render(<MarkdownBody markdown={COMMENT} />);
    expect(el.querySelector('source[media]')?.getAttribute('srcset')).toBe(DARK);
    expect(Array.from(el.querySelectorAll('img')).map((img) => img.getAttribute('src'))).toEqual([LIGHT, BADGE]);
  });
});
