/**
 * Guards: a settings read heard through `event: prefs` putting an older text size or tab icon back over a pick made
 * on this page. Two quick picks: the first save's event reads settings before the second save lands, and the window
 * flickered back to the first pick until the second save's event.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chooseTextSize, resetInboxTextSizeForTests, takeSavedTextSize, textSizeReadMark, useInboxTextSize } from './textSize';
import { chooseFavicon, faviconReadMark, resetInboxFaviconForTests, takeSavedFavicon, useInboxFavicon } from './faviconChoice';

const hasDom = typeof document !== 'undefined';
const realFetch = globalThis.fetch;
let held: Array<() => void> = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
const shown = { size: 0, icon: null as string | null };

function Probe() {
  shown.size = useInboxTextSize();
  shown.icon = useInboxFavicon();
  return null;
}

/** Every save waits until `answerSaves`: the second pick is still in flight when the first save's read answers. */
beforeEach(async () => {
  if (!hasDom) return;
  held = [];
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      held.push(() => resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    })) as unknown as typeof fetch;
  resetInboxTextSizeForTests();
  resetInboxFaviconForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe />));
});

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => root?.unmount());
  host?.remove();
  globalThis.fetch = realFetch;
});

const answerSaves = async (saves: Promise<void>[]) => {
  await act(async () => {
    for (const done of held.splice(0)) done();
    await Promise.all(saves);
  });
};

test.skipIf(!hasDom)('two quick text size picks: the first save\'s read does not put the first pick back', async () => {
  const saves: Promise<void>[] = [];
  await act(async () => void saves.push(chooseTextSize(13)));
  const firstRead = textSizeReadMark();
  await act(async () => void saves.push(chooseTextSize(15)));
  await act(async () => takeSavedTextSize(13, firstRead));
  expect(shown.size).toBe(15);
  await answerSaves(saves);
  await act(async () => takeSavedTextSize(13, firstRead));
  expect(shown.size).toBe(15);

  // A read started before a pick here and answered after its save: still older than the pick.
  const before = textSizeReadMark();
  const pick = [chooseTextSize(12)];
  await answerSaves(pick);
  await act(async () => takeSavedTextSize(15, before));
  expect(shown.size).toBe(12);

  // Another window's size, read with no pick here around it, is shown at once.
  await act(async () => takeSavedTextSize(14, textSizeReadMark()));
  expect(shown.size).toBe(14);
});

test.skipIf(!hasDom)('two quick tab icon picks: the first save\'s read does not put the first pick back', async () => {
  const saves: Promise<void>[] = [];
  await act(async () => void saves.push(chooseFavicon('yellow')));
  const firstRead = faviconReadMark();
  await act(async () => void saves.push(chooseFavicon('totman')));
  await answerSaves(saves);
  await act(async () => takeSavedFavicon('yellow', firstRead));
  expect(shown.icon).toBe('totman');

  await act(async () => takeSavedFavicon('glass', faviconReadMark()));
  expect(shown.icon).toBe('glass');
});
