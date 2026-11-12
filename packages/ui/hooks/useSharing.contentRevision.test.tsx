import React, { useCallback, useMemo, useState } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSharing } from './useSharing';
import { AnnotationType, type Annotation, type DocumentRenderAs } from '../types';

const hasDom = typeof document !== 'undefined';
const originalFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
});

type SharingResult = ReturnType<typeof useSharing>;

async function waitForPasteRequest(issued: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !issued(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(issued()).toBe(true);
}

function Harness({
  revision,
  annotationText = '',
  onResult,
}: {
  revision: number;
  annotationText?: string;
  onResult: (result: SharingResult) => void;
}) {
  const [markdown, setMarkdown] = useState('');
  const annotations = useMemo<Annotation[]>(() => annotationText ? [{
    id: 'annotation-1',
    blockId: 'block-1',
    startOffset: 0,
    endOffset: 4,
    type: AnnotationType.COMMENT,
    text: annotationText,
    originalText: 'Same',
    createdA: 1,
  }] : [], [annotationText]);
  const setAnnotations = (() => {}) as Parameters<typeof useSharing>[4];
  const [attachments, setAttachments] = useState<Parameters<typeof useSharing>[2]>([]);
  const [rawHtml, setRawHtml] = useState('<h1>Same HTML</h1>');
  const [shareHtml, setShareHtml] = useState('');
  const [, setRenderAs] = useState<DocumentRenderAs>('html');
  const result = useSharing(
    markdown,
    annotations,
    attachments,
    setMarkdown,
    setAnnotations,
    setAttachments,
    undefined,
    'https://share.example.test',
    'https://paste.example.test',
    rawHtml,
    async () => shareHtml || rawHtml,
    setRawHtml,
    setShareHtml,
    setRenderAs,
    revision,
  );
  onResult(result);
  return null;
}

describe.if(hasDom)('useSharing request invalidation', () => {
  test('discards an in-flight short link when rendered HTML refreshes without changing text', async () => {
    let resolvePaste: ((response: Response) => void) | null = null;
    globalThis.fetch = (() => new Promise<Response>((resolve) => {
      resolvePaste = resolve;
    })) as unknown as typeof fetch;

    let latest: SharingResult | null = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Harness revision={0} onResult={(result) => { latest = result; }} />);
    });

    let pendingShortUrl: Promise<string | null> | null = null;
    await act(async () => {
      pendingShortUrl = latest?.generateShortUrl() ?? null;
      await waitForPasteRequest(() => resolvePaste !== null);
    });
    expect(latest?.isGeneratingShortUrl).toBe(true);

    await act(async () => {
      root?.render(<Harness revision={1} onResult={(result) => { latest = result; }} />);
    });
    expect(latest?.isGeneratingShortUrl).toBe(false);
    expect(latest?.shortShareUrl).toBe('');

    await act(async () => {
      resolvePaste?.(Response.json({ id: 'stale1' }));
      expect(await pendingShortUrl).toBeNull();
    });
    expect(latest?.shortShareUrl).toBe('');
  });

  test('discards an in-flight short link when annotations change', async () => {
    let resolvePaste: ((response: Response) => void) | null = null;
    globalThis.fetch = (() => new Promise<Response>((resolve) => {
      resolvePaste = resolve;
    })) as unknown as typeof fetch;

    let latest: SharingResult | null = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Harness revision={0} onResult={(result) => { latest = result; }} />);
    });

    let pendingShortUrl: Promise<string | null> | null = null;
    await act(async () => {
      pendingShortUrl = latest?.generateShortUrl() ?? null;
      await waitForPasteRequest(() => resolvePaste !== null);
    });

    await act(async () => {
      root?.render(
        <Harness
          revision={0}
          annotationText="Current feedback"
          onResult={(result) => { latest = result; }}
        />,
      );
    });

    await act(async () => {
      resolvePaste?.(Response.json({ id: 'stale2' }));
      expect(await pendingShortUrl).toBeNull();
    });
    expect(latest?.shortShareUrl).toBe('');
  });

  test('keeps a short link whose resolver cached portable HTML mid-request', async () => {
    let resolvePaste: ((response: Response) => void) | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/share-html')) {
        return Response.json({ shareHtml: '<h1>Portable</h1>' });
      }
      return new Promise<Response>((resolve) => { resolvePaste = resolve; });
    }) as unknown as typeof fetch;

    function CachingResolverHarness({ onResult }: { onResult: (result: SharingResult) => void }) {
      const [markdown, setMarkdown] = useState('');
      const [annotations] = useState<Annotation[]>([]);
      const setAnnotations = (() => {}) as Parameters<typeof useSharing>[4];
      const [attachments, setAttachments] = useState<Parameters<typeof useSharing>[2]>([]);
      const [rawHtml, setRawHtml] = useState('<h1>Doc</h1>');
      const [shareHtml, setShareHtml] = useState('');
      const [, setRenderAs] = useState<DocumentRenderAs>('html');
      const resolveRawHtmlForShare = useCallback(async (): Promise<string | null> => {
        if (shareHtml) return shareHtml;
        const res = await fetch('/api/share-html');
        const data = (await res.json()) as { shareHtml: string };
        setShareHtml(data.shareHtml);
        return data.shareHtml;
      }, [shareHtml]);
      const result = useSharing(
        markdown, annotations, attachments, setMarkdown, setAnnotations, setAttachments,
        undefined, 'https://share.example.test', 'https://paste.example.test',
        rawHtml, resolveRawHtmlForShare, setRawHtml, setShareHtml, setRenderAs, 0,
      );
      onResult(result);
      return null;
    }

    let latest: SharingResult | null = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<CachingResolverHarness onResult={(result) => { latest = result; }} />);
    });

    let pendingShortUrl: Promise<string | null> = Promise.resolve(null);
    await act(async () => {
      pendingShortUrl = latest?.generateShortUrl() ?? Promise.resolve(null);
      await waitForPasteRequest(() => resolvePaste !== null);
    });

    let shortUrl: string | null = null;
    await act(async () => {
      resolvePaste?.(Response.json({ id: 'ok123' }));
      shortUrl = await pendingShortUrl;
    });

    expect(shortUrl).not.toBeNull();
    expect(latest?.isGeneratingShortUrl).toBe(false);
  });
});
