/** DOM coverage for a narrow file header (a phone's): the folder kept with `keepsFolder`, the name alone without. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileHeader } from './FileHeader';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let realObserver: typeof ResizeObserver | undefined;

/** Every header measures this wide (a 390 px phone's header). */
const WIDTH = 340;

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

beforeEach(() => {
  if (!hasDom) return;
  realObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback([{ contentRect: { width: WIDTH } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) globalThis.ResizeObserver = realObserver!;
});

describe.if(hasDom)('FileHeader, narrow', () => {
  const patch = '@@ -1 +1 @@\n-a\n+b\n';

  test('keepsFolder: two files of one name read apart, the folder before the whole name', async () => {
    const el = await mount(
      <>
        <FileHeader filePath="src/admin/Layout.tsx" patch={patch} keepsFolder />
        <FileHeader filePath="src/settings/Layout.tsx" patch={patch} keepsFolder />
      </>,
    );
    const labels = [...el.querySelectorAll('[data-file-header] span[title]')].map((span) => span.textContent);
    expect(labels).toEqual(['src/admin/Layout.tsx', 'src/settings/Layout.tsx']);
    // The folder and the name are spans of their own, the folder first (which gives way first is the stylesheet's).
    const folder = el.querySelector<HTMLElement>('[data-file-header-folder]')!;
    expect(folder.textContent).toBe('src/admin/');
    expect(folder.nextElementSibling!.textContent).toBe('Layout.tsx');
  });

  test('without keepsFolder (the review app), the name alone, as before', async () => {
    const el = await mount(<FileHeader filePath="src/admin/Layout.tsx" patch={patch} />);
    expect(el.querySelector('[data-file-header] span[title]')!.textContent).toBe('Layout.tsx');
    expect(el.querySelector('[data-file-header-folder]')).toBeNull();
  });
});
