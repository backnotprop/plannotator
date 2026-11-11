import { afterEach, expect, test } from 'bun:test';
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { lazyPart } = (hasDom ? await import('./lazyParts') : {}) as typeof import('./lazyParts');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function Reader({ title }: { title: string }) {
  return <p data-reader="">{title}</p>;
}

function renderNow(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
  return host;
}

test.skipIf(!hasDom)('a part fetched in idle time draws on its first open in the same commit, with no fallback', async () => {
  let loads = 0;
  const part = lazyPart(async () => {
    loads++;
    return { default: Reader };
  });
  await part.preload();
  const el = renderNow(
    <Suspense fallback={<p data-fallback="" />}>
      <part.Part title="Token refresh" />
    </Suspense>,
  );
  expect(el.querySelector('[data-fallback]')).toBeNull();
  expect(el.querySelector('[data-reader]')?.textContent).toBe('Token refresh');
  await part.preload();
  expect(loads).toBe(1);
});

test.skipIf(!hasDom)('a part opened before its fetch is done still opens, through Suspense', async () => {
  let land: (mod: { default: typeof Reader }) => void = () => {};
  const part = lazyPart(() => new Promise<{ default: typeof Reader }>((resolve) => (land = resolve)));
  const el = renderNow(
    <Suspense fallback={<p data-fallback="" />}>
      <part.Part title="Token refresh" />
    </Suspense>,
  );
  expect(el.querySelector('[data-fallback]')).not.toBeNull();
  await act(async () => land({ default: Reader }));
  for (let i = 0; i < 20 && !el.querySelector('[data-reader]'); i++) await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(el.querySelector('[data-reader]')?.textContent).toBe('Token refresh');
});

test.skipIf(!hasDom)('a fetch that failed is tried again on the next preload', async () => {
  let tries = 0;
  const part = lazyPart(async () => {
    tries++;
    if (tries === 1) throw new TypeError('Failed to fetch dynamically imported module');
    return { default: Reader };
  });
  await expect(part.preload()).rejects.toThrow('Failed to fetch');
  await part.preload();
  expect(tries).toBe(2);
  const el = renderNow(<part.Part title="Again" />);
  expect(el.querySelector('[data-reader]')?.textContent).toBe('Again');
});
