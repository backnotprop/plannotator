import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HtmlBlock } from './HtmlBlock';

const hasDom = typeof document !== 'undefined';
const VIDEO_BLOCK = {
  id: 'video', type: 'html' as const, order: 0, startLine: 1,
  content: '<video controls src="media/demo.webm"><source src="media/demo.mp4" type="video/mp4"></video><video controls src="https://example.com/movie.mp4"></video><a href="notes.md">notes</a>',
};

describe.if(hasDom)('annotated Markdown video paths', () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  test('local video and source URLs resolve beside the document; remote URLs and links remain unchanged', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(
      <HtmlBlock
        block={VIDEO_BLOCK}
        imageBaseDir="/docs/proof"
      />,
    ));
    const videos = host.querySelectorAll('video');
    expect(videos[0]?.getAttribute('src')).toBe('/api/annotate-media?path=media%2Fdemo.webm&base=%2Fdocs%2Fproof');
    expect(videos[0]?.querySelector('source')?.getAttribute('src')).toBe('/api/annotate-media?path=media%2Fdemo.mp4&base=%2Fdocs%2Fproof');
    expect(videos[1]?.getAttribute('src')).toBe('https://example.com/movie.mp4');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('notes.md');
    await act(async () => root?.render(<HtmlBlock block={VIDEO_BLOCK} imageBaseDir="/docs/proof" />));
    expect(host.querySelector('video')).toBe(videos[0]);
    await act(async () => root?.render(
      <HtmlBlock block={VIDEO_BLOCK} imageBaseDir="/docs/linked" />,
    ));
    expect(host.querySelector('video')?.getAttribute('src')).toContain('base=%2Fdocs%2Flinked');
    await act(async () => root?.render(<HtmlBlock block={VIDEO_BLOCK} imageBaseDir="/docs/proof" />));
    expect(host.querySelector('video')?.getAttribute('src')).toContain('base=%2Fdocs%2Fproof');
  });
});
