/**
 * The real CodeView in a file box of the Inbox: what scrollWithPage's own test cannot see, since it answers plain divs.
 * What regresses: the viewer windowing from its own root rather than the page (a Pierre upgrade asking its root
 * something else, or GuideFileCard no longer asking for it), which leaves deep rows blank in a box with no limit.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Its own file: Pierre keeps module state
 * that a viewer mounted earlier in the same run changes.
 */
import { plugin } from 'bun';
import { expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { resolve } from 'node:path';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';

plugin({
  name: 'inbox-guide-reader',
  setup(build) {
    build.onLoad({ filter: /guide\/reader-module\.d\.ts$/ }, () => ({
      contents: `export { default } from ${JSON.stringify(resolve(import.meta.dir, 'guide/GuideReader.tsx'))};`,
      loader: 'ts',
    }));
  },
});
// The review app's worker pool imports Vite's `?worker&inline`, which Bun cannot load.
mock.module(resolve(import.meta.dir, '../review-editor/workerPool.tsx'), () => ({
  ReviewWorkerPoolProvider: ({ children }: { children: unknown }) => children,
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== 'undefined';
const GuideReader = (hasDom ? (await import('#guide-reader')).default : null)!;

const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
const PATCH = `diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2000 +1,2000 @@\n${lines.map((line) => `-${line}\n+${line} changed`).join('\n')}\n`;
const snapshot = buildGuideSnapshot({
  guide: { title: 'T', intent: 'I', sections: [{ title: 'S', overview: 'O', diffs: [{ file: 'a.ts', summary: 's' }] }] },
  review: { rawPatch: PATCH, gitRef: 'main...head', source: { kind: 'local' } },
  reviewed: [false],
} as unknown as Parameters<typeof buildGuideSnapshot>[0]);

async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 15));
    });
  }
}

test.skipIf(!hasDom)("the viewer draws the rows at the page's position, not its own root's", async () => {
  const page = document.createElement('div');
  page.style.overflowY = 'auto';
  document.body.appendChild(page);
  let scrolled = 0;
  Object.defineProperty(page, 'scrollTop', { configurable: true, get: () => scrolled, set: (top: number) => void (scrolled = top) });
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const inPage = page.contains(this) && this !== page;
    const top = inPage ? -scrolled : 0;
    const height = inPage ? 80_000 : 900;
    return { x: 0, y: top, left: 0, right: 800, width: 800, top, bottom: top + height, height, toJSON: () => ({}) } as DOMRect;
  };
  const host = document.createElement('div');
  page.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <div className="pn-inbox">
          <GuideReader snapshot={snapshot} reviewed={[false]} onReviewedChange={() => {}} />
        </div>,
      );
    });
    await settle();
    const drawn = () =>
      [...host.querySelectorAll('diffs-container')].flatMap((view) => [...view.shadowRoot!.querySelectorAll<HTMLElement>('[data-code] [data-line]')]).map((row) => Number(row.dataset.line));
    expect(drawn().length).toBeGreaterThan(0);
    expect(Math.max(...drawn())).toBeLessThan(200);
    // A deep scroll of the page, heard as the browser tells it: the rows come from around there.
    scrolled = 30_000;
    await act(async () => page.dispatchEvent(new Event('scroll')));
    await settle();
    expect(Math.min(...drawn())).toBeGreaterThan(200);
    expect(Math.max(...drawn())).toBeLessThan(2000);
  } finally {
    Element.prototype.getBoundingClientRect = realRect;
    await act(async () => root.unmount());
    page.remove();
  }
});
