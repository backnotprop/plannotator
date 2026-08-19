import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GuideExportButton } from './GuideExportButton';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
});

async function render(jobId: string) {
  // A second render inside one test replaces the previous tree instead of leaking it into document.body.
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<GuideExportButton jobId={jobId} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const EXPORT_INFO = { bytes: 345_678, filename: 'guided-review-x.html', languages: ['typescript'] };

interface StubCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Routes the export-info / share-info preflights and the share create/delete
 * calls; records every call so tests can assert what was (not) sent.
 */
function stubFetch(routes: {
  exportInfo?: Response | (() => Response);
  shareInfo?: Response | (() => Response);
  share?: (method: string, body: unknown) => Response;
}): StubCall[] {
  const calls: StubCall[] = [];
  const resolve = (r: Response | (() => Response) | undefined) => (typeof r === 'function' ? r() : r);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/export-info')) {
      return Promise.resolve(resolve(routes.exportInfo) ?? Response.json(EXPORT_INFO));
    }
    if (url.endsWith('/share-info')) {
      return Promise.resolve(resolve(routes.shareInfo) ?? Response.json({ enabled: true, serviceUrl: 'https://guides.show' }));
    }
    if (url.endsWith('/share') && routes.share) {
      return Promise.resolve(routes.share(method, body));
    }
    return Promise.resolve(new Response('not stubbed', { status: 500 }));
  }) as typeof fetch;
  return calls;
}

const dialog = () => document.querySelector('[data-testid="guide-share-dialog"]');
const shareButton = () => host!.querySelector('button[data-testid="guide-share"]');

describe('GuideExportButton', () => {
  test.skipIf(!hasDom)('offers the download with the server-reported size when the guide is exportable', async () => {
    const calls = stubFetch({});
    await render('saved:1000-x');
    expect(calls.map((c) => c.url).sort()).toEqual([
      '/api/guide/saved%3A1000-x/export-info',
      '/api/guide/saved%3A1000-x/share-info',
    ]);
    const link = host!.querySelector('a[data-testid="guide-export"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/api/guide/saved%3A1000-x/export');
    expect(link!.getAttribute('download')).toBe('guided-review-x.html');
    expect(link!.textContent).toContain('346 KB');
  });

  test.skipIf(!hasDom)('renders nothing when the guide is not exportable or the preflight fails', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ error: 'not retained' }), { status: 404 }))) as typeof fetch;
    await render('job-1');
    expect(host!.querySelector('[data-testid="guide-export"]')).toBeNull();
    expect(shareButton()).toBeNull();
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await render('job-2');
    expect(host!.querySelector('[data-testid="guide-export"]')).toBeNull();
    expect(shareButton()).toBeNull();
  });

  test.skipIf(!hasDom)('hides the share control when sharing is disabled or share-info fails, keeping the download', async () => {
    stubFetch({ shareInfo: () => Response.json({ enabled: false, serviceUrl: 'https://guides.show' }) });
    await render('job-1');
    expect(host!.querySelector('a[data-testid="guide-export"]')).not.toBeNull();
    expect(shareButton()).toBeNull();

    stubFetch({ shareInfo: () => new Response('nope', { status: 404 }) });
    await render('job-2');
    expect(host!.querySelector('a[data-testid="guide-export"]')).not.toBeNull();
    expect(shareButton()).toBeNull();
  });

  test.skipIf(!hasDom)('creates the link only on Create and shows the URL and one-time delete token', async () => {
    const calls = stubFetch({
      share: (method) =>
        method === 'POST'
          ? Response.json({ id: 'abc', url: 'https://guides.show/g/abc#key=k1', deleteToken: 'tok-1', bytes: 345_678, recorded: true })
          : new Response(null, { status: 405 }),
    });
    await render('saved:1000-x');
    await click(shareButton());
    // Opening the dialog uploads nothing.
    expect(calls.filter((c) => c.url.endsWith('/share'))).toHaveLength(0);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('346 KB');

    await click(document.querySelector('[data-testid="guide-share-create"]'));
    const uploads = calls.filter((c) => c.url.endsWith('/share'));
    expect(uploads).toEqual([{ url: '/api/guide/saved%3A1000-x/share', method: 'POST', body: {} }]);
    expect(document.querySelector('[data-testid="guide-share-url"]')?.textContent).toBe('https://guides.show/g/abc#key=k1');
    expect(document.querySelector('[data-testid="guide-share-delete-token"]')?.textContent).toBe('tok-1');
    // The header control now knows a link exists.
    expect(shareButton()!.textContent).toContain('Share link');
  });

  test.skipIf(!hasDom)('a link the server could not record is neither offered for removal nor re-created', async () => {
    // Guide history off: the upload succeeds but no envelope holds the token,
    // so the server answers recorded: false and DELETE would 404.
    const calls = stubFetch({
      share: (method) =>
        method === 'POST'
          ? Response.json({ id: 'abc', url: 'https://guides.show/g/abc#key=k1', deleteToken: 'tok-1', bytes: 1, recorded: false })
          : Response.json({ error: 'No share link for this guide' }, { status: 404 }),
    });
    await render('job-1');
    await click(shareButton());
    await click(document.querySelector('[data-testid="guide-share-create"]'));
    expect(document.querySelector('[data-testid="guide-share-delete-token"]')?.textContent).toBe('tok-1');
    expect(document.querySelector('[data-testid="guide-share-remove"]')).toBeNull();
    // Close and reopen: the same link and its one-time token are shown again; a
    // second Create would orphan the first upload, whose token is unrecoverable.
    await click(document.querySelector('[data-testid="guide-share-dialog"] button[data-pn-touch-target]'));
    await click(shareButton());
    expect(document.querySelector('[data-testid="guide-share-delete-token"]')?.textContent).toBe('tok-1');
    expect(document.querySelector('[data-testid="guide-share-remove"]')).toBeNull();
    expect(document.querySelector('[data-testid="guide-share-create"]')).toBeNull();
    expect(calls.filter((c) => c.url.endsWith('/share'))).toHaveLength(1);
  });

  test.skipIf(!hasDom)('"Allow link previews" sends public: true', async () => {
    const calls = stubFetch({
      share: () => Response.json({ id: 'abc', url: 'https://guides.show/g/abc', deleteToken: 'tok-1', bytes: 1 }),
    });
    await render('job-1');
    await click(shareButton());
    await click(document.querySelector('[data-testid="guide-share-public"]'));
    await click(document.querySelector('[data-testid="guide-share-create"]'));
    expect(calls.filter((c) => c.url.endsWith('/share')).map((c) => c.body)).toEqual([{ public: true }]);
  });

  test.skipIf(!hasDom)('shows the server error inline and does not pretend a link exists', async () => {
    stubFetch({ share: () => Response.json({ error: 'sharing disabled' }, { status: 403 }) });
    await render('job-1');
    await click(shareButton());
    await click(document.querySelector('[data-testid="guide-share-create"]'));
    expect(document.querySelector('[data-testid="guide-share-error"]')?.textContent).toBe('sharing disabled');
    expect(document.querySelector('[data-testid="guide-share-url"]')).toBeNull();
    expect(shareButton()!.textContent).toContain('Create share link');
  });

  test.skipIf(!hasDom)('an existing link shows the URL with Remove link, and removing clears it', async () => {
    const calls = stubFetch({
      shareInfo: () =>
        Response.json({
          enabled: true,
          serviceUrl: 'https://guides.show',
          existing: { url: 'https://guides.show/g/old#key=k0', createdAt: '2026-08-15T10:00:00.000Z' },
        }),
      share: (method) => (method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(null, { status: 405 })),
    });
    await render('saved:1000-x');
    expect(shareButton()!.textContent).toContain('Share link');
    await click(shareButton());
    expect(document.querySelector('[data-testid="guide-share-url"]')?.textContent).toBe('https://guides.show/g/old#key=k0');
    expect(document.querySelector('[data-testid="guide-share-create"]')).toBeNull();

    await click(document.querySelector('[data-testid="guide-share-remove"]'));
    expect(calls.filter((c) => c.url.endsWith('/share'))).toEqual([
      { url: '/api/guide/saved%3A1000-x/share', method: 'DELETE', body: undefined },
    ]);
    // Back to the create form, and the header control no longer claims a link.
    expect(document.querySelector('[data-testid="guide-share-create"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="guide-share-remove"]')).toBeNull();
    expect(shareButton()!.textContent).toContain('Create share link');
  });
});
