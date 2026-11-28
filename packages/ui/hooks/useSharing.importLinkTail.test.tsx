/**
 * A share link pasted into the import box with the punctuation of the sentence it was copied from
 * (`…#key=abc).`) still imports its annotations, as the same link does when it is opened as a page.
 */
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { compress } from '@plannotator/core/compress';
import { encrypt } from '@plannotator/core/crypto';
import { useSharing } from './useSharing';
import type { Annotation, ImageAttachment } from '../types';
import type { SharePayload } from '../utils/sharing';

const hasDom = typeof document !== 'undefined';
let originalFetch: typeof fetch;
let originalUrl: string;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  if (!hasDom) return;
  originalFetch = globalThis.fetch;
  originalUrl = window.location.href;
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, '', originalUrl);
});

type SharingResult = ReturnType<typeof useSharing>;

function Harness({ onResult }: { onResult: (result: SharingResult) => void }) {
  const [markdown, setMarkdown] = useState('# Plan');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  onResult(useSharing(
    markdown,
    annotations,
    attachments,
    setMarkdown,
    setAnnotations,
    setAttachments,
    undefined,
    'https://share.example.test',
    'https://paste.example.test',
  ));
  return null;
}

async function mount(): Promise<{ current: SharingResult | null }> {
  const capture: { current: SharingResult | null } = { current: null };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness onResult={(result) => { capture.current = result; }} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return capture;
}

const payload: SharePayload = { p: '# Plan', a: [['C', 'Ship it', 'Not before review', null]] };

function base64url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe.if(hasDom)('importing a pasted share link that ends with punctuation', () => {
  test('a hash link imports its annotations', async () => {
    const capture = await mount();
    const hash = await compress(payload);
    for (const tail of [').', '.', ',']) {
      let imported: Awaited<ReturnType<SharingResult['importFromShareUrl']>> | undefined;
      await act(async () => {
        imported = await capture.current!.importFromShareUrl(`https://share.example.test/#${hash}${tail}`);
      });
      expect([tail, imported?.success, imported?.planTitle]).toEqual([tail, true, 'Plan']);
    }
  });

  test('a short link reads its key and paste origin without the punctuation', async () => {
    const encrypted = await encrypt(await compress(payload));
    const fetched: string[] = [];
    // SAFETY: an in-memory paste service; only GET of one paste id answers.
    globalThis.fetch = (async (input) => {
      const url = new URL(new Request(input).url);
      fetched.push(url.origin + url.pathname);
      return url.pathname === '/api/paste/Local001'
        ? Response.json({ data: encrypted.ciphertext })
        : Response.json({ error: 'Unknown paste' }, { status: 404 });
    }) as typeof fetch;
    const capture = await mount();
    const links = [
      `https://share.example.test/p/Local001#key=${encrypted.key}).`,
      `https://share.example.test/p/Local001#key=${encrypted.key}&paste=${base64url('https://paste2.example.test')}).`,
    ];
    for (const link of links) {
      let imported: Awaited<ReturnType<SharingResult['importFromShareUrl']>> | undefined;
      await act(async () => {
        imported = await capture.current!.importFromShareUrl(link);
      });
      expect([link, imported?.success, imported?.planTitle]).toEqual([link, true, 'Plan']);
    }
    expect(fetched).toEqual(['https://paste.example.test/api/paste/Local001', 'https://paste2.example.test/api/paste/Local001']);
  });
});
