import React, { useState } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { compress, decompress } from '@plannotator/core/compress';
import { encrypt } from '@plannotator/core/crypto';
import { useSharing } from './useSharing';
import { AnnotationType, type Annotation, type ImageAttachment } from '../types';
import type { SharePayload } from '../utils/sharing';

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
  window.history.replaceState({}, '', '/');
});

type SharingResult = ReturnType<typeof useSharing>;

interface SharingControls {
  readonly setMarkdown: React.Dispatch<React.SetStateAction<string>>;
  readonly setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>;
  readonly setAttachments: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
}

interface HarnessCapture {
  result: SharingResult | null;
  controls: SharingControls | null;
}

function Harness({
  contentRevision,
  onResult,
  onControls,
}: {
  contentRevision: number;
  onResult: (result: SharingResult) => void;
  onControls: (controls: SharingControls) => void;
}) {
  const [markdown, setMarkdown] = useState('');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [rawHtml, setRawHtml] = useState('');
  const [shareHtml, setShareHtml] = useState('');
  const [, setRenderAs] = useState<'markdown' | 'html'>('markdown');
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
    rawHtml || undefined,
    async () => shareHtml || rawHtml,
    setRawHtml,
    setShareHtml,
    setRenderAs,
    contentRevision,
  );

  onResult(result);
  onControls({ setMarkdown, setAnnotations, setAttachments });
  return null;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(condition()).toBe(true);
}

async function installIncomingPaste(
  payload: SharePayload,
  pasteId: string,
): Promise<{ readonly incomingUrl: string; readonly getPasteResponse: Response }> {
  const compressed = await compress(payload);
  const encrypted = await encrypt(compressed);
  window.location.href = `http://localhost/p/${pasteId}#key=${encrypted.key}`;
  return {
    incomingUrl: window.location.href,
    getPasteResponse: Response.json({ data: encrypted.ciphertext }),
  };
}

async function mountHarness(
  contentRevision: number,
  capture: HarnessCapture,
): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    renderHarness(contentRevision, capture);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderHarness(contentRevision: number, capture: HarnessCapture): void {
  root?.render(
    <React.StrictMode>
      <Harness
        contentRevision={contentRevision}
        onResult={(result) => { capture.result = result; }}
        onControls={(controls) => { capture.controls = controls; }}
      />
    </React.StrictMode>,
  );
}

describe.if(hasDom)('useSharing short URL lifecycle', () => {
  test('preserves an incoming short URL through hydration, then invalidates immutable snapshots after material edits', async () => {
    const payload: SharePayload = {
      p: '# Shared plan\n\nOriginal document',
      a: [['C', 'Original document', 'Initial feedback', null]],
      g: [['data:image/png;base64,aW5pdGlhbA==', 'initial.png']],
    };
    const incoming = await installIncomingPaste(payload, 'AbCd1234');
    let postCount = 0;
    // SAFETY: This boundary fake implements the fetch calls exercised by useSharing and returns real Response values.
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/paste/AbCd1234')) return incoming.getPasteResponse.clone();
      if (url.endsWith('/api/paste') && init?.method === 'POST') {
        postCount += 1;
        return Response.json({ id: `Local00${postCount}` }, { status: 201 });
      }
      return Response.json({ error: 'Unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const capture: HarnessCapture = {
      result: null,
      controls: null,
    };
    await mountHarness(0, capture);
    await waitFor(() => capture.result?.isLoadingShared === false);

    expect(capture.result?.shortShareUrl).toBe(incoming.incomingUrl);
    expect(capture.result?.isSharedSession).toBe(true);
    await waitFor(() => Boolean(capture.result?.shareUrl));
    const hydratedShareUrl = capture.result?.shareUrl ?? '';

    await act(async () => {
      capture.controls?.setAnnotations((current) => [...current, {
        id: 'teammate-annotation',
        blockId: 'block-1',
        startOffset: 0,
        endOffset: 8,
        type: AnnotationType.COMMENT,
        originalText: 'Original',
        text: 'Teammate feedback',
        createdA: 2,
      }]);
    });
    expect(capture.result?.shortShareUrl).toBe('');
    expect(postCount).toBe(0);

    await waitFor(() => Boolean(capture.result?.shareUrl) && capture.result?.shareUrl !== hydratedShareUrl);
    const annotatedPayload = await decompress(capture.result?.shareUrl.split('#')[1] ?? '');
    // SAFETY: generateShareUrl produced this compressed SharePayload in the same hook.
    const annotatedSharePayload = annotatedPayload as SharePayload;
    expect(annotatedSharePayload.a).toHaveLength(2);

    let firstLocalUrl: string | null = null;
    await act(async () => {
      firstLocalUrl = await capture.result?.generateShortUrl() ?? null;
    });
    expect(firstLocalUrl).toContain('/p/Local001#key=');
    expect(capture.result?.shortShareUrl).toBe(firstLocalUrl);

    await act(async () => {
      renderHarness(0, capture);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(capture.result?.shortShareUrl).toBe(firstLocalUrl);

    await act(async () => {
      capture.controls?.setAttachments((current) => [...current, {
        path: 'data:image/png;base64,bmV3',
        name: 'new.png',
      }]);
    });
    expect(capture.result?.shortShareUrl).toBe('');
    expect(postCount).toBe(1);

    await act(async () => {
      await capture.result?.generateShortUrl();
    });
    expect(capture.result?.shortShareUrl).toContain('/p/Local002#key=');

    await act(async () => {
      capture.controls?.setMarkdown('# Shared plan\n\nEdited document');
    });
    expect(capture.result?.shortShareUrl).toBe('');
    expect(postCount).toBe(2);
  });

  test('clears a failed short-link error only after the represented content changes', async () => {
    let postCount = 0;
    // SAFETY: This boundary fake implements the paste POST exercised by useSharing.
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'POST') {
        postCount += 1;
        if (postCount === 1) {
          return Response.json({ id: 'LocalSuccess' }, { status: 201 });
        }
        return Response.json({ error: 'Unavailable' }, { status: 503 });
      }
      return Response.json({ error: 'Unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const capture: HarnessCapture = {
      result: null,
      controls: null,
    };
    await mountHarness(0, capture);

    await act(async () => {
      capture.controls?.setMarkdown('# Local plan\n\nOriginal content');
    });
    await waitFor(() => Boolean(capture.result?.shareUrl));

    let initialShortUrl: string | null = null;
    await act(async () => {
      initialShortUrl = await capture.result?.generateShortUrl() ?? null;
    });
    expect(initialShortUrl).toContain('/p/LocalSuccess#key=');
    expect(capture.result?.shortShareUrl).toBe(initialShortUrl);

    await act(async () => {
      expect(await capture.result?.generateShortUrl()).toBeNull();
    });
    expect(postCount).toBe(2);
    expect(capture.result?.shortShareUrl).toBe('');
    expect(capture.result?.shortUrlError).toBe('Short URL service unavailable');

    await act(async () => {
      renderHarness(0, capture);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(capture.result?.shortUrlError).toBe('Short URL service unavailable');

    await act(async () => {
      capture.controls?.setMarkdown('# Local plan\n\nEdited content');
    });
    expect(capture.result?.shortShareUrl).toBe('');
    expect(capture.result?.shortUrlError).toBe('');
    expect(postCount).toBe(2);
  });

  test('invalidates a hydrated HTML short URL when the portable content revision changes', async () => {
    const payload: SharePayload = {
      p: '',
      a: [],
      h: '<!doctype html><html><body><h1>Shared HTML</h1></body></html>',
      r: 'html',
    };
    const incoming = await installIncomingPaste(payload, 'Html1234');
    // SAFETY: This boundary fake implements the single paste fetch exercised by the hydrated HTML share.
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith('/api/paste/Html1234')) return incoming.getPasteResponse.clone();
      return Response.json({ error: 'Unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const capture: HarnessCapture = {
      result: null,
      controls: null,
    };
    await mountHarness(0, capture);
    await waitFor(() => capture.result?.isLoadingShared === false);
    expect(capture.result?.shortShareUrl).toBe(incoming.incomingUrl);
    expect(capture.result?.shareUrl).toBe('');

    await act(async () => {
      renderHarness(1, capture);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(capture.result?.shortShareUrl).toBe('');
    expect(capture.result?.shareUrl).toBe('');
  });
});
