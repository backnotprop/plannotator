/**
 * `softLineBreaks` (set by the Inbox ref preview card) draws a bare newline in
 * forge text as a line break, as GitHub does. Off by default: files and plans
 * keep the CommonMark soft break. Code blocks are never touched.
 *
 * DOM-gated (DOM_TESTS=1), listed in tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RenderedMarkdown } from './RenderedMarkdown';

const hasDom = typeof document !== 'undefined';

const THREE = ['**Summary**: first line', '**Background**: second line', '**Goal**: third line'].join('\n');

describe.if(hasDom)('RenderedMarkdown softLineBreaks (DOM)', () => {
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
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    return host;
  }

  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    for (const host of hosts) host.remove();
    roots = [];
    hosts = [];
  });

  test('three single-newline lines draw as three lines', async () => {
    const el = await render(<RenderedMarkdown markdown={THREE} softLineBreaks />);
    expect(el.querySelectorAll('p')).toHaveLength(1);
    expect(el.querySelectorAll('br')).toHaveLength(2);
    expect(el.querySelectorAll('strong')).toHaveLength(3);
  });

  test('default options still draw one paragraph with no breaks', async () => {
    const el = await render(<RenderedMarkdown markdown={THREE} />);
    expect(el.querySelectorAll('br')).toHaveLength(0);
    expect(el.textContent).toContain('first line');
  });

  test('a blank line still separates paragraphs, not extra breaks', async () => {
    const el = await render(<RenderedMarkdown markdown={'one\ntwo\n\nthree'} softLineBreaks />);
    expect(el.querySelectorAll('p')).toHaveLength(2);
    expect(el.querySelectorAll('br')).toHaveLength(1);
  });

  test('a fenced code block is unchanged', async () => {
    const md = 'before\n\n```\nline a\nline b\n```\n';
    const on = await render(<RenderedMarkdown markdown={md} softLineBreaks />);
    const off = await render(<RenderedMarkdown markdown={md} />);
    expect(on.innerHTML).toBe(off.innerHTML);
    expect(on.querySelector('code')?.textContent).toContain('line a\nline b');
    expect(on.querySelectorAll('br')).toHaveLength(0);
  });
});
