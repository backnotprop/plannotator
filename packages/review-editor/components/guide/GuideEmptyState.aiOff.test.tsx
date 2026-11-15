import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// With AI features off the Guide page still lists the saved guides (they are
// still served) and opens one; only starting a new guide is gone.

const hasDom = typeof document !== 'undefined';
const Empty = hasDom ? (await import('./GuideEmptyState')).GuideEmptyState : null;
const originalFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
});

test.skipIf(!hasDom)('AI off: the saved guides are listed and open; no Generate', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url === '/api/guides'
      ? [{ id: 'g1', label: 'PR #12', title: 'Locale fallback chain', savedAt: Date.now() - 60_000, progress: { reviewed: 1, total: 3 }, moved: false }]
      : '';
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const opened: string[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    const GuideEmptyState = Empty!;
    root!.render(<GuideEmptyState capabilities={null} launchJob={async () => null} onBack={() => {}} onOpenSavedGuide={(id) => opened.push(id)} launchOff />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(host.querySelector('h1')?.textContent).toBe('Saved guides');
  const entry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Locale fallback chain'));
  expect(entry).toBeDefined();
  await act(async () => entry!.click());
  expect(opened).toEqual(['saved:g1']);
  expect(Array.from(host.querySelectorAll('button')).some((b) => /generate/i.test(b.textContent ?? ''))).toBe(false);
});
