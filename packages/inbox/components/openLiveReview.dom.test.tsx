import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.skipIf(!hasDom)('Open it again from an ended review', () => {
  test('the Inbox window starts the review once and takes the marker out of its address', async () => {
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:49999/?open-review=msg_T1#thread=msg_T1');
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ url: 'http://localhost:51234' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const replaced: string[] = [];
    const originalReplace = window.location.replace;
    Object.defineProperty(window.location, 'replace', { configurable: true, value: (u: string) => replaced.push(u) });
    try {
      const { OpenLiveReview } = await import('./ReviewAnchorLine');
      expect(window.location.search).toBe('');
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => root!.render(<OpenLiveReview threadId="msg_T1" title="fix/charge" />));
      await act(async () => {});
      expect(calls).toEqual(['/api/inbox/review-threads/msg_T1/open']);
      expect(replaced).toEqual(['http://localhost:51234']);
      await act(async () => root!.render(<OpenLiveReview threadId="msg_T1" title="fix/charge" />));
      expect(calls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(window.location, 'replace', { configurable: true, value: originalReplace });
    }
  });
});
