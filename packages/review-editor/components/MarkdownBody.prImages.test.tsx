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
