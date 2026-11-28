import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HtmlBlock } from './HtmlBlock';
import { resetImageSrcResolver, setImageSrcResolver } from '../ImageThumbnail';

const hasDom = typeof document !== 'undefined';
const VIDEO_BLOCK = {
  id: 'video', type: 'html' as const, order: 0, startLine: 1,
  content: '<video controls src="media/demo.webm"><source src="media/demo.mp4" type="video/mp4"></video><video controls src="https://example.com/movie.mp4"></video><a href="notes.md">notes</a>',
};

describe.if(hasDom)('annotated Markdown video paths', () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;

  afterEach(async () => {
    resetImageSrcResolver();
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

  test('a media fragment stays on the rewritten URL, a relative poster loads beside the document', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const block = { ...VIDEO_BLOCK, content: '<video controls poster="media/poster.png" src="media/demo.mp4?v=2#t=5"></video>' };
    await act(async () => root?.render(<HtmlBlock block={block} imageBaseDir="/docs/proof" />));
    const video = host.querySelector('video');
    expect(video?.getAttribute('src')).toBe('/api/annotate-media?path=media%2Fdemo.mp4&base=%2Fdocs%2Fproof#t=5');
    expect(video?.getAttribute('poster')).toBe('/api/image?path=media%2Fposter.png&base=%2Fdocs%2Fproof');
  });

  test('a re-render with new callbacks keeps the playing video element', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<HtmlBlock block={VIDEO_BLOCK} imageBaseDir="/docs/proof" onOpenLinkedDoc={() => {}} onNavigateAnchor={() => {}} />));
    const video = host.querySelector('video');
    expect(video).not.toBeNull();
    await act(async () => root?.render(<HtmlBlock block={VIDEO_BLOCK} imageBaseDir="/docs/proof" onOpenLinkedDoc={() => {}} onNavigateAnchor={() => {}} />));
    expect(host.querySelector('video')).toBe(video);
    expect(video?.isConnected).toBe(true);
  });

  test('a host with its own image resolver keeps its video URLs as written', async () => {
    setImageSrcResolver((path) => `https://assets.example/${path}`);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<HtmlBlock block={VIDEO_BLOCK} imageBaseDir="/docs/proof" />));
    expect(host.querySelector('video')?.getAttribute('src')).toBe('media/demo.webm');
  });
});
