import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PackageChangesCard } from './PackageChangesCard';
import { adoptPackageChangesConfig, resetPackageChangesSetting } from '@plannotator/ui/hooks/usePackageChangesSetting';
import { resetPackageChangesCache, type PackageCard } from '../hooks/usePackageChanges';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';

const hasDom = typeof document !== 'undefined';
const originalFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

const CARD: PackageCard = {
  path: 'package.json',
  ecosystem: 'npm',
  role: 'manifest',
  lockfile: 'package-lock.json',
  changes: [
    { name: 'pg', registryName: 'pg', kind: 'upgraded', section: 'dependencies', before: '^8.13.0', after: '^8.16.3', beforeVersion: '8.13.1', afterVersion: '8.16.3', major: false, source: 'registry' },
    { name: '@acme/billing', registryName: '@acme/billing', kind: 'upgraded', section: 'dependencies', before: '^1.0.0', after: '^2.0.0', beforeVersion: '1.0.0', afterVersion: '2.0.0', major: true, source: 'registry' },
  ],
  indirect: [{ name: 'pg-pool', before: ['3.7.0'], after: ['3.10.1'] }],
  lookup: { names: ['pg'], withheld: ['@acme/billing'] },
};

interface Call { url: string; body?: unknown }

/** The review has other cards too: one click sends 5 names in all, this card's 1 among them. */
const REVIEW_TOTAL = 5;

function stubServer(calls: Call[], opts: { lookupFails?: boolean; card?: PackageCard } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith('/api/package-changes?')) return Response.json({ snapshot: 's1', cards: [opts.card ?? CARD], lookup: { total: REVIEW_TOTAL } });
    if (url === '/api/config') return Response.json({ ok: true });
    if (url === '/api/package-changes/lookup') {
      if (opts.lookupFails) {
        return Response.json({ packages: [{ name: 'pg', version: '8.16.3', status: 'error' }], offline: true, failure: 'offline' });
      }
      return Response.json({ packages: [{ name: 'pg', version: '8.16.3', status: 'ok', license: 'MIT', weeklyDownloads: 43_200_000, publishedAt: '2025-06-27T14:52:44.894Z' }], offline: false });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function memoryStorage() {
  const map = new Map<string, string>();
  setStorageBackend({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) });
}

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<PackageChangesCard filePath="package.json" reviewSnapshotId="s1" />));
  // Let the cards fetch settle.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** happy-dom lays nothing out (every width is 0, the phone layout): give the card a desktop width. */
let restoreWidth: (() => void) | null = null;
function wideHost() {
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
  restoreWidth = () => {
    if (desc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', desc);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  };
}

const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(text));

afterEach(async () => {
  restoreWidth?.();
  restoreWidth = null;
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  resetPackageChangesSetting();
  resetPackageChangesCache();
  resetStorageBackend();
  if (hasDom) document.body.innerHTML = '';
});

describe('PackageChangesCard', () => {
  test.skipIf(!hasDom)('before consent: rows show, the button counts every name the click sends in the review, nothing is looked up', async () => {
    const calls: Call[] = [];
    stubServer(calls);
    adoptPackageChangesConfig({ packageChanges: { card: true, lookup: false } });
    await render();
    expect(document.querySelectorAll('[data-package-row]')).toHaveLength(2);
    const allow = document.querySelector('[data-package-lookup-allow]')!;
    expect(allow.textContent).toContain(String(REVIEW_TOTAL));
    expect(allow.getAttribute('aria-label')).toContain(`${REVIEW_TOTAL} package names`);
    expect(calls.some((c) => c.url.includes('/lookup'))).toBe(false);
    expect(document.body.textContent).not.toContain('Downloads');
  });

  test.skipIf(!hasDom)('columns read old then new; a section move has no previous version', async () => {
    wideHost();
    stubServer([], {
      card: {
        ...CARD,
        changes: [
          ...CARD.changes,
          { name: 'tsx', registryName: 'tsx', kind: 'moved', section: 'devDependencies', previousSection: 'dependencies', before: '^4.20.0', after: '^4.20.0', beforeVersion: '4.20.0', afterVersion: '4.20.0', major: false, source: 'registry' },
        ],
      },
    });
    adoptPackageChangesConfig({ packageChanges: { card: true, lookup: false } });
    await render();
    const heads = Array.from(document.querySelectorAll('thead th')).map((th) => th.textContent?.replace('▼', '').trim());
    expect(heads.slice(0, 3)).toEqual(['Package', 'Previous', 'Version']);
    const row = (name: string) => Array.from(document.querySelectorAll('[data-package-row]')).find((r) => r.querySelector('.truncate.font-mono')?.textContent === name)!;
    const pg = row('pg').querySelectorAll('td');
    expect([pg[0].textContent, pg[1].textContent]).toEqual(['8.13.1', '8.16.3']);
    // A breaking step is marked on the new version itself.
    expect(row('@acme/billing').querySelectorAll('td')[1].querySelector('.text-warning')).not.toBeNull();
    expect(pg[1].querySelector('.text-warning')).toBeNull();
    const moved = document.querySelector('[data-package-row="moved"]')!.querySelectorAll('td');
    expect([moved[0].textContent, moved[1].textContent]).toEqual(['—', '4.20.0']);

    // The phone layout keeps the same order on one line.
    restoreWidth?.();
    restoreWidth = null;
    await act(async () => root?.unmount());
    host?.remove();
    await render();
    expect(row('pg').textContent).toContain('8.13.1→8.16.3');
    expect(document.querySelector('[data-package-row="moved"]')!.textContent).not.toContain('→4.20.0');
  });

  test.skipIf(!hasDom)('a failed lookup shows its status and Retry, not columns of blanks', async () => {
    wideHost();
    stubServer([], { lookupFails: true });
    adoptPackageChangesConfig({ packageChanges: { card: true, lookup: true } });
    await render();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.querySelector('[data-package-lookup-state="failed"]')).not.toBeNull();
    expect(button('Retry')).toBeDefined();
    const heads = Array.from(document.querySelectorAll('thead th')).map((th) => th.textContent?.replace('▼', '').trim());
    expect(heads).toEqual(['Package', 'Previous', 'Version']);
  });

  test.skipIf(!hasDom)('one click saves the consent to config, then looks up this card', async () => {
    const calls: Call[] = [];
    stubServer(calls);
    adoptPackageChangesConfig({ packageChanges: { card: true, lookup: false } });
    await render();
    await act(async () => { (document.querySelector('[data-package-lookup-allow]') as HTMLButtonElement).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const config = calls.findIndex((c) => c.url === '/api/config');
    const lookup = calls.findIndex((c) => c.url === '/api/package-changes/lookup');
    expect(calls[config].body).toEqual({ packageChanges: { lookup: true } });
    expect(lookup).toBeGreaterThan(config);
    expect(calls[lookup].body).toEqual({ snapshot: 's1', path: 'package.json' });
    expect(document.body.textContent).toContain('MIT');
    expect(document.body.textContent).toContain('43.2M');
  });

  test.skipIf(!hasDom)('PLANNOTATOR_PACKAGE_LOOKUP=0 offers no lookup; the card switch off fetches nothing at all', async () => {
    const calls: Call[] = [];
    stubServer(calls);
    adoptPackageChangesConfig({ packageChanges: { card: true, lookup: false, lookupEnv: false } });
    await render();
    expect(document.querySelectorAll('[data-package-row]')).toHaveLength(2);
    expect(document.querySelector('[data-package-lookup-allow]')).toBeNull();
    await act(async () => root?.unmount());
    root = null;
    host?.remove();

    calls.length = 0;
    adoptPackageChangesConfig({ packageChanges: { card: false, lookup: true } });
    await render();
    expect(calls).toEqual([]);
    expect(document.querySelector('[data-package-changes]')).toBeNull();
  });

  test.skipIf(!hasDom)('folding is remembered for the next card', async () => {
    stubServer([]);
    memoryStorage();
    adoptPackageChangesConfig({ packageChanges: { card: true, lookup: false } });
    await render();
    const fold = document.querySelector('[aria-controls]') as HTMLButtonElement;
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    await act(async () => fold.click());
    await act(async () => root?.unmount());
    root = null;
    host?.remove();

    await render();
    expect((document.querySelector('[aria-controls]') as HTMLButtonElement).getAttribute('aria-expanded')).toBe('false');
  });
});
