/**
 * An Inbox diff loads the picked code font (Settings → Reviews → Code Font), not only names it: GuideReader's
 * `GuideDiff`, the one place the Inbox applies the font to a diff, adds the font's web stylesheet once, however many
 * diffs are drawn, and none for Theme Default or a font that is not one of the menu's web fonts. What regresses if
 * this fails: after a reload a review's diffs fall back to another font until Settings is opened.
 *
 * The diff itself (AllFilesCodeView) is a stand-in that shows the font it was given; appendChild on <head> is
 * intercepted, so no stylesheet is inserted and nothing is fetched.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';

// Only under happy-dom: the unit lanes run many files in one process, where a module mock would replace the real
// AllFilesCodeView for every other file.
if (hasDom) {
  mock.module('@plannotator/review-editor/components/AllFilesCodeView', () => ({
    AllFilesCodeView: ({ fontFamily }: { fontFamily?: string }) => <div data-diff-stand-in={fontFamily ?? ''} />,
  }));
  mock.module('@plannotator/review-editor/worker-pool', () => ({
    ReviewWorkerPoolProvider: ({ children }: { children: unknown }) => children,
    useIsWorkerPoolReadyOrDisabled: () => true,
    useWorkerPoolThemeSync: () => {},
  }));
}
const { GuideDiff } = (hasDom ? await import('./GuideReader') : {}) as typeof import('./GuideReader');
const { GuideHostProvider } = (hasDom ? await import('@plannotator/guide-viewer') : {}) as typeof import('@plannotator/guide-viewer');
const { configStore } = (hasDom ? await import('@plannotator/ui/config') : {}) as typeof import('@plannotator/ui/config');

let links: HTMLLinkElement[] = [];
let realAppend: typeof document.head.appendChild | null = null;
const roots: Root[] = [];

beforeEach(() => {
  if (!hasDom) return;
  links = [];
  realAppend = document.head.appendChild;
  document.head.appendChild = (<T extends Node>(node: T): T => {
    if (node instanceof HTMLLinkElement) {
      links.push(node);
      return node;
    }
    return realAppend!.call(document.head, node) as T;
  }) as typeof document.head.appendChild;
});

afterEach(async () => {
  if (!hasDom) return;
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.head.appendChild = realAppend!;
});

async function drawDiffs(count: number): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const value = { files: [], DiffRenderer: (() => null) as never, getDiffRendererProps: () => ({}) };
  const props = {
    files: [],
    fileScrollTarget: null,
    fileOrder: 'list' as const,
    mountCollapsed: false,
    initialScrollPosition: 0,
    onScrollPositionChange: () => {},
    onFileCollapsedChange: () => {},
    isActive: false,
    allowScrollChaining: true as const,
  };
  await act(async () =>
    root.render(
      <GuideHostProvider value={value}>
        {Array.from({ length: count }, (_, i) => (
          <GuideDiff key={i} {...props} />
        ))}
      </GuideHostProvider>,
    ),
  );
  return host;
}

test.skipIf(!hasDom)('a picked web font: its stylesheet is added once, however many diffs are drawn', async () => {
  await act(async () => configStore.seed('diffFontFamily', 'Fira Code'));
  const host = await drawDiffs(3);
  expect([...host.querySelectorAll('[data-diff-stand-in]')].map((el) => el.getAttribute('data-diff-stand-in'))).toEqual(['Fira Code', 'Fira Code', 'Fira Code']);
  expect(links.map((link) => [link.rel, link.dataset.diffFont, link.href])).toEqual([
    ['stylesheet', 'Fira Code', 'https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap'],
  ]);
  await drawDiffs(2);
  expect(links).toHaveLength(1);
});

test.skipIf(!hasDom)('Theme Default or a font that is not one of the web fonts: no stylesheet', async () => {
  for (const font of ['', 'Menlo', 'constructor']) {
    await act(async () => configStore.seed('diffFontFamily', font));
    await drawDiffs(2);
  }
  expect(links).toHaveLength(0);
});
