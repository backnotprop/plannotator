import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { compress, decompress } from '@plannotator/core/compress';
import { decrypt, encrypt } from '@plannotator/core/crypto';
import { useSharing } from './useSharing';
import { AnnotationType, type Annotation, type ImageAttachment } from '../types';
import { fromShareable, loadFromPasteId, type SharePayload } from '../utils/sharing';
import { ExportModal } from '../components/ExportModal';

const hasDom = typeof document !== 'undefined';
let originalFetch: typeof fetch;
let originalUrl: string;
let originalHistoryState: unknown;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  if (!hasDom) return;
  originalFetch = globalThis.fetch;
  originalUrl = window.location.href;
  originalHistoryState = window.history.state;
  window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  window.location.href = originalUrl;
  window.history.replaceState(originalHistoryState, '', originalUrl);
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

interface ModalOptions {
  sharingEnabled?: boolean;
  shortLinksSupported?: boolean;
}

function Harness({
  contentRevision,
  onResult,
  onControls,
  modal,
}: {
  contentRevision: number;
  onResult: (result: SharingResult) => void;
  onControls: (controls: SharingControls) => void;
  modal?: ModalOptions;
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
  return modal ? (
    <ExportModal
      isOpen
      onClose={() => {}}
      shareUrl={result.shareUrl}
      shareUrlSize={result.shareUrlSize}
      shortShareUrl={result.shortShareUrl}
      isGeneratingShortUrl={result.isGeneratingShortUrl}
      shortUrlError={result.shortUrlError}
      onGenerateShortUrl={modal.shortLinksSupported === false ? undefined : result.generateShortUrl}
      sharingEnabled={modal.sharingEnabled}
      annotationsOutput=""
      annotationCount={annotations.length}
      markdown={markdown}
    />
  ) : null;
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
  modal?: ModalOptions,
): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    renderHarness(contentRevision, capture, modal);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderHarness(contentRevision: number, capture: HarnessCapture, modal?: ModalOptions): void {
  root?.render(
    <React.StrictMode>
      <Harness
        contentRevision={contentRevision}
        onResult={(result) => { capture.result = result; }}
        onControls={(controls) => { capture.controls = controls; }}
        modal={modal}
      />
    </React.StrictMode>,
  );
}

function installPasteService(initial: Record<string, string> = {}) {
  const pastes = new Map(Object.entries(initial));
  const uploads: string[] = [];
  const rejectedMutations: string[] = [];
  // SAFETY: Only the in-memory paste endpoint is implemented, with real Request/Response bodies.
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === 'https://paste.example.test' && url.pathname === '/api/paste' && request.method === 'POST') {
      const body = await request.json() as { data: string };
      const id = `Local00${uploads.length + 1}`;
      uploads.push(body.data);
      pastes.set(id, body.data);
      return Response.json({ id }, { status: 201 });
    }
    if (request.method !== 'GET') {
      rejectedMutations.push(`${request.method} ${request.url}`);
      return Response.json({ error: 'Immutable paste' }, { status: 405 });
    }
    const id = url.pathname.match(/^\/api\/paste\/([A-Za-z0-9]+)$/)?.[1];
    const data = url.origin === 'https://paste.example.test' && id ? pastes.get(id) : undefined;
    return data === undefined
      ? Response.json({ error: 'Unknown paste' }, { status: 404 })
      : Response.json({ data });
  }) as typeof fetch;
  return { pastes, uploads, rejectedMutations };
}

function createShortLinkButton(): HTMLButtonElement | undefined {
  // Deliberately select the user-facing action, not the surrounding explanatory copy.
  return Array.from(host?.querySelectorAll('button') ?? [])
    .find((button) => button.textContent?.trim() === 'Create short link');
}

function displayedShortUrl(): string {
  return host?.querySelector<HTMLInputElement>('input[readonly]')?.value ?? '';
}

describe.if(hasDom)('useSharing short URL lifecycle', () => {
  test('offers an explicit replacement for an edited small incoming encrypted snapshot', async () => {
    const originalPayload: SharePayload = {
      p: '# Shared plan\n\nOriginal document',
      a: [['C', 'Original document', 'Initial feedback', null]],
    };
    const incoming = await installIncomingPaste(originalPayload, 'AbCd1234');
    const { data: originalCiphertext } = await incoming.getPasteResponse.json() as { data: string };
    const service = installPasteService({ AbCd1234: originalCiphertext });
    const capture: HarnessCapture = { result: null, controls: null };
    const modal: ModalOptions = {};
    await mountHarness(0, capture, modal);
    await waitFor(() => capture.result?.isLoadingShared === false && Boolean(capture.result?.shareUrl));

    expect(displayedShortUrl()).toBe(incoming.incomingUrl);
    expect(service.uploads).toEqual([]);
    const hydratedShareUrl = capture.result!.shareUrl;
    expect(hydratedShareUrl.length).toBeLessThan(2048);
    await act(async () => {
      renderHarness(0, capture, modal);
    });
    expect(displayedShortUrl()).toBe(incoming.incomingUrl);
    expect(service.uploads).toEqual([]);

    const editedMarkdown = '# Shared plan\n\nEdited document';
    function expectEditedDocument(payload: SharePayload): void {
      expect(payload.p).toBe(editedMarkdown);
      expect(fromShareable(payload.a)).toEqual([
        expect.objectContaining({
          type: AnnotationType.COMMENT,
          originalText: 'Original document',
          text: 'Updated feedback',
        }),
      ]);
    }
    await act(async () => {
      capture.controls!.setMarkdown(editedMarkdown);
      capture.controls!.setAnnotations((current) => current.map((annotation) => ({
        ...annotation,
        text: 'Updated feedback',
      })));
    });
    expect(displayedShortUrl()).toBe('');
    await waitFor(() => Boolean(capture.result?.shareUrl) && capture.result?.shareUrl !== hydratedShareUrl);
    const fullUrl = host!.querySelector('textarea')!.value;
    expect(fullUrl.length).toBeLessThan(2048);
    expectEditedDocument(await decompress(new URL(fullUrl).hash.slice(1)) as SharePayload);
    expect(createShortLinkButton()).toBeDefined();
    expect(service.uploads).toEqual([]);

    await act(async () => {
      renderHarness(0, capture, modal);
    });
    expect(service.uploads).toEqual([]);
    await act(async () => {
      createShortLinkButton()!.click();
    });
    await waitFor(() => displayedShortUrl() !== '');
    const newUrl = new URL(displayedShortUrl());
    expect(newUrl.href).not.toBe(incoming.incomingUrl);
    expect(newUrl.pathname).toBe('/p/Local001');
    expect(service.uploads).toHaveLength(1);
    const newCiphertext = service.pastes.get('Local001')!;
    expect(newCiphertext).not.toBe(originalCiphertext);
    const newKey = new URLSearchParams(newUrl.hash.slice(1)).get('key')!;
    expectEditedDocument(await decompress(await decrypt(newCiphertext, newKey)) as SharePayload);

    const originalKey = new URLSearchParams(new URL(incoming.incomingUrl).hash.slice(1)).get('key')!;
    expect(await loadFromPasteId('AbCd1234', 'https://paste.example.test', originalKey)).toEqual(originalPayload);
    expect(service.pastes.get('AbCd1234')).toBe(originalCiphertext);
    expect(service.rejectedMutations).toEqual([]);
    expect(service.uploads).toHaveLength(1);
  });

  test('offers short-link creation for a fresh small plan without uploading until clicked', async () => {
    const service = installPasteService();
    const capture: HarnessCapture = { result: null, controls: null };
    const modal: ModalOptions = {};
    await mountHarness(0, capture, modal);
    await waitFor(() => capture.result?.isLoadingShared === false && Boolean(capture.result?.shareUrl));
    const emptyPlanUrl = capture.result!.shareUrl;
    await act(async () => {
      capture.controls!.setMarkdown('# Fresh small plan');
    });
    await waitFor(() => Boolean(capture.result?.shareUrl) && capture.result?.shareUrl !== emptyPlanUrl);
    expect(capture.result?.isSharedSession).toBe(false);
    expect(displayedShortUrl()).toBe('');
    const fullUrl = host!.querySelector('textarea')!.value;
    expect(fullUrl.length).toBeLessThan(2048);
    expect(await decompress(new URL(fullUrl).hash.slice(1))).toEqual({ p: '# Fresh small plan', a: [] });
    expect(createShortLinkButton()).toBeDefined();
    await act(async () => {
      renderHarness(0, capture, modal);
    });
    expect(service.uploads).toEqual([]);

    await act(async () => {
      createShortLinkButton()!.click();
    });
    await waitFor(() => displayedShortUrl() !== '');
    expect(service.uploads).toHaveLength(1);
    const url = new URL(displayedShortUrl());
    const key = new URLSearchParams(url.hash.slice(1)).get('key')!;
    expect(await loadFromPasteId(url.pathname.split('/').pop()!, 'https://paste.example.test', key))
      .toEqual({ p: '# Fresh small plan', a: [] });
    expect(service.rejectedMutations).toEqual([]);
  });

  test('does not expose creation when sharing is disabled or short links are unsupported', async () => {
    const service = installPasteService();
    const capture: HarnessCapture = { result: null, controls: null };
    await mountHarness(0, capture, { sharingEnabled: false });
    await waitFor(() => capture.result?.isLoadingShared === false && Boolean(capture.result?.shareUrl));
    const emptyPlanUrl = capture.result!.shareUrl;
    await act(async () => {
      capture.controls!.setMarkdown('# Private plan');
    });
    await waitFor(() => Boolean(capture.result?.shareUrl) && capture.result?.shareUrl !== emptyPlanUrl);
    expect(createShortLinkButton()).toBeUndefined();

    await act(async () => {
      renderHarness(0, capture, { shortLinksSupported: false });
    });
    // Full URL sharing still works on a surface that has no paste-generation callback.
    const fullUrl = host!.querySelector('textarea')!.value;
    expect(await decompress(new URL(fullUrl).hash.slice(1))).toEqual({ p: '# Private plan', a: [] });
    expect(createShortLinkButton()).toBeUndefined();
    expect(service.uploads).toEqual([]);
    expect(service.rejectedMutations).toEqual([]);
  });

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
