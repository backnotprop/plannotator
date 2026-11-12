import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RenderedMarkdown } from '@plannotator/ui/components/RenderedMarkdown';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import type { ReviewState } from '../dock/ReviewStateContext';
import { renderPRDescriptionVideo } from './PRDescriptionVideo';

const hasDom = typeof document !== 'undefined';
const src = 'https://github.com/user-attachments/assets/580b308b-6736-47a5-975c-deb0bd573eb1';
const proxy = `/api/pr-artifact-content?${new URLSearchParams({ url: src })}`;

describe.if(hasDom)('PR description attachment videos', () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  let restoreFetch: (() => void) | undefined;

  function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(handler, { preconnect: original.preconnect });
    restoreFetch = () => { globalThis.fetch = original; };
  }

  async function render(markdown: string, enabled = true) {
    if (!host) {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    }
    await act(async () => {
      root!.render(<RenderedMarkdown markdown={markdown} renderParagraph={enabled ? renderPRDescriptionVideo : undefined} />);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    return host;
  }

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    restoreFetch?.();
  });

  test('an extensionless bare URL becomes a proxied video after its content type and metadata load', async () => {
    let requested: { url: string; range: string | null } | undefined;
    let respond: ((response: Response) => void) | undefined;
    mockFetch((input, init) => {
      requested = { url: String(input), range: new Headers(init?.headers).get('range') };
      return new Promise(resolve => { respond = resolve; });
    });
    const page = await render(src);
    expect(page.querySelector('a')?.getAttribute('href')).toBe(src);
    expect(page.querySelector('video')).toBeNull();
    const response = new Response('x', { status: 206, headers: { 'Content-Type': 'video/mp4' } });
    await act(async () => { respond!(response); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(requested).toEqual({ url: proxy, range: 'bytes=0-0' });
    const video = page.querySelector('video');
    expect(video?.getAttribute('src')).toBe(proxy);
    expect(video?.controls).toBe(true);
    expect(video?.autoplay).toBe(false);
    expect(video?.parentElement?.hidden).toBe(true);
    expect(page.querySelector('a')?.getAttribute('href')).toBe(src);
    await act(async () => { video?.dispatchEvent(new Event('loadedmetadata')); });
    expect(video?.parentElement?.hidden).toBe(false);
    expect(page.querySelector('a')).toBeNull();
    expect(page.querySelectorAll('[data-block-id]').length).toBe(1);
    await act(async () => { video?.dispatchEvent(new Event('error')); });
    expect(page.querySelector('video')).toBeNull();
    expect(page.querySelector('a')?.getAttribute('href')).toBe(src);
  });

  test('images, labeled links, prose, code, and other hosts keep their existing rendering', async () => {
    let calls = 0;
    mockFetch(async () => { calls++; return new Response('image', { headers: { 'Content-Type': 'image/png' } }); });
    const page = await render(`![screenshot](${src})\n\n[Download](${src})\n\nWatch ${src}\n\n\`\`\`\n${src}\n\`\`\`\n\nhttps://example.com/clip.mp4`);
    expect(calls).toBe(0);
    expect(page.querySelector('img')?.getAttribute('src')).toBe(src);
    expect(page.querySelectorAll('a').length).toBeGreaterThan(0);
    await render(src);
    expect(calls).toBe(1);
    expect(page.querySelector('video')).toBeNull();
    expect(page.querySelector('a')?.getAttribute('href')).toBe(src);
  });

  test('failed probes leave the link, and hosts without the seam never probe', async () => {
    let calls = 0;
    mockFetch(async () => { calls++; throw new Error('offline'); });
    const page = await render(src, false);
    expect(calls).toBe(0);
    await render(src);
    expect(calls).toBe(1);
    expect(page.querySelector('a')?.getAttribute('href')).toBe(src);
    expect(page.querySelector('video')).toBeNull();
  });

  test('the player opens its item in Artifacts, as the comments player does', async () => {
    mockFetch(async () => new Response('x', { status: 206, headers: { 'Content-Type': 'video/mp4' } }));
    const { ReviewStateProvider } = await import('../dock/ReviewStateContext');
    const { buildPRArtifacts } = await import('../utils/prArtifacts');
    const metadata = { platform: 'github', host: 'github.com', owner: 'acme', repo: 'widgets', number: 42, url: 'https://github.com/acme/widgets/pull/42' } as never;
    const artifacts = buildPRArtifacts(metadata, { body: src, comments: [], reviews: [], reviewThreads: [] } as never);
    const clip = artifacts.find((artifact) => artifact.url === src)!;
    const opened: string[] = [];
    const state = { prMetadata: metadata, prArtifacts: artifacts, openPRArtifact: (id: string) => opened.push(id) } as unknown as ReviewState;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ReviewStateProvider value={state}><RenderedMarkdown markdown={src} renderParagraph={renderPRDescriptionVideo} /></ReviewStateProvider>);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    await act(async () => { host!.querySelector('video')!.dispatchEvent(new Event('loadedmetadata')); });
    const button = [...host.querySelectorAll('button')].find((el) => el.textContent?.includes('Open in Artifacts'));
    await act(async () => { button!.click(); });
    expect(opened).toEqual([clip.id]);
  });

  test('changing the description aborts the pending probe', async () => {
    let signal: AbortSignal | null | undefined;
    mockFetch((_url, init) => {
      signal = init?.signal;
      return new Promise(() => {});
    });
    await render(src);
    expect(signal?.aborted).toBe(false);
    await render('Updated description');
    expect(signal?.aborted).toBe(true);
  });
});

describe.if(hasDom)('PR description comments next to an attachment video', () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  let restoreFetch: (() => void) | undefined;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    restoreFetch?.();
  });

  test('a comment saved while the video showed restores onto its own text before the probe answers', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), { preconnect: original.preconnect });
    restoreFetch = () => { globalThis.fetch = original; };
    const { AnnotatableDescription } = await import('./AnnotatableDescription');
    const { ReviewStateProvider } = await import('../dock/ReviewStateContext');
    const comment: Annotation = {
      id: 'second-note',
      blockId: '',
      startOffset: 0,
      endOffset: 11,
      type: AnnotationType.COMMENT,
      originalText: 'Second note',
      createdA: 1,
      startMeta: { parentTagName: 'P', parentIndex: 1, textOffset: 0 },
      endMeta: { parentTagName: 'P', parentIndex: 1, textOffset: 11 },
    };
    const state = {
      descriptionAnnotations: [comment],
      selectedDescriptionAnnotationId: null,
      onAddDescriptionAnnotation: () => {},
      onSelectDescriptionAnnotation: () => {},
      prMetadata: { platform: 'github', url: 'https://github.com/backnotprop/plannotator/pull/1' },
    } as unknown as ReviewState;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ReviewStateProvider value={state}>
          <AnnotatableDescription markdown={`${src}\n\nFirst note\n\nSecond note`} />
        </ReviewStateProvider>,
      );
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(host.querySelector('a')?.getAttribute('href')).toBe(src);
    const painted = [...host.querySelectorAll('[data-highlight-id="second-note"], [data-bind-id="second-note"]')].map(el => el.textContent).join('');
    expect(painted).toBe('Second note');
  });
});
