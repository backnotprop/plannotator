import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileHeader } from './FileHeader';
import { loadOpenInApps } from '@plannotator/ui/hooks/useOpenInApps';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let realObserver: typeof ResizeObserver | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (realObserver) globalThis.ResizeObserver = realObserver;
});

describe.if(hasDom)('a file header scrolling into view', () => {
  test('mounts in one render: no measured width, no menu or tooltip until someone reaches for it', async () => {
    realObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([{ contentRect: { width: 420 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ available: true, apps: [{ id: 'reveal', label: 'Finder', kind: 'file-manager', icon: 'finder' }] }), { status: 200 })) as unknown as typeof fetch;
    await loadOpenInApps('/api/open-in/apps');
    globalThis.fetch = realFetch;
    let renders = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <Profiler id="header" onRender={() => { renders += 1; }}>
          <FileHeader filePath="src/a.ts" patch={'@@ -1 +1 @@\n-a\n+b\n'} onToggleViewed={() => {}} onFileComment={() => {}} />
        </Profiler>,
      );
    });
    expect(renders).toBe(1);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(host.querySelector('[data-open-in-trigger]')?.getAttribute('aria-haspopup')).toBe('menu');
  });
});
