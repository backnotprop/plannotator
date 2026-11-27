import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '@plannotator/ui/config';
import type { SemDiffClient } from '@plannotator/review-editor/semDiff/semDiffClient';
import { loadSemDiffAdvert, resetSemDiffAdvertForTests } from '../semDiffAdvert';
import { useSemDiffClient } from './useSemDiffClient';

const hasDom = typeof document !== 'undefined';
const realFetch = globalThis.fetch;
const roots: Root[] = [];

const answer = (grammar: string) =>
  (async () =>
    new Response(JSON.stringify({ advert: { runtime: '/assets/sem-diff/runtime.js', grammars: { typescript: `/assets/sem-diff/${grammar}` } } }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

function Probe({ seen }: { seen: (SemDiffClient | null)[] }) {
  seen.push(useSemDiffClient());
  return null;
}

async function reader(): Promise<(SemDiffClient | null)[]> {
  const seen: (SemDiffClient | null)[] = [];
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  await act(async () => root.render(<Probe seen={seen} />));
  return seen;
}

const semantic = (on: boolean) => act(async () => configStore.seed('diffSemantic', on));

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  globalThis.fetch = realFetch;
  resetSemDiffAdvertForTests();
  configStore.seed('diffSemantic', true);
  configStore.seed('semanticDiffEnabled', true);
});

test.skipIf(!hasDom)('a reader keeps the client it made when a different advert arrives later', async () => {
  resetSemDiffAdvertForTests();
  configStore.seed('semanticDiffEnabled', true);
  configStore.seed('diffSemantic', true);
  globalThis.fetch = answer('first.wasm');
  await loadSemDiffAdvert();
  const seen = await reader();
  const made = seen.at(-1);
  expect(made).not.toBeNull();
  resetSemDiffAdvertForTests();
  globalThis.fetch = answer('second.wasm');
  await act(async () => void (await loadSemDiffAdvert()));
  expect(seen.every((client) => client === made)).toBe(true);
});

test.skipIf(!hasDom)('a reader that started on a failed advert gets semantic diffs from a later one unless it already drew asking for them', async () => {
  resetSemDiffAdvertForTests(40);
  configStore.seed('semanticDiffEnabled', true);
  globalThis.fetch = (async () => {
    throw new TypeError('offline');
  }) as unknown as typeof fetch;
  expect(await loadSemDiffAdvert()).toBeNull();
  await semantic(true);
  const asking = await reader();
  await semantic(false);
  const plain = await reader();
  await new Promise((resolve) => setTimeout(resolve, 60));
  globalThis.fetch = answer('typescript.wasm');
  await act(async () => void (await loadSemDiffAdvert()));
  await semantic(true);
  expect([asking.every((client) => client === null), plain.at(-1) === null]).toEqual([true, false]);
});
