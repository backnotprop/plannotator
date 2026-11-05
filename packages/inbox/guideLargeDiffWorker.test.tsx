/**
 * A very large diff in the Inbox's guide reader highlights in the shared worker pool (GuideDiff). When the worker
 * cannot start, what regresses:
 *
 *  - the diff staying blank while the pool's readiness wait runs out (5 s), on every mount: the reader must draw it
 *    on the main thread instead, at once;
 *  - a later mount (the file scrolled away and back) waiting again.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { plugin } from 'bun';
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GuideDiffRendererProps } from '@plannotator/guide-viewer';

// The review app's worker is Vite's `?worker&inline`, which Bun cannot load: here it is a Worker whose constructor
// throws, as when the page may not start workers.
plugin({
  name: 'blocked-highlight-worker',
  setup(build) {
    build.onResolve({ filter: /\?worker&inline$/ }, (args) => ({ path: args.path, namespace: 'blocked-worker' }));
    build.onLoad({ filter: /.*/, namespace: 'blocked-worker' }, () => ({
      contents: `export default class BlockedWorker { constructor() { throw new Error('Worker blocked'); } }`,
      loader: 'js',
    }));
  },
});

const hasDom = typeof document !== 'undefined';
const { GuideDiff } = (hasDom ? await import('./guide/GuideReader') : {}) as typeof import('./guide/GuideReader');

// Past the reader's 50,000-character line for worker highlighting.
const lines = Array.from({ length: 3000 }, (_, i) => `+export const value${i} = ${i};`);
const bigFile: GuideDiffRendererProps['files'][number] = {
  path: 'src/big.ts',
  patch: `diff --git a/src/big.ts b/src/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/big.ts\n@@ -0,0 +1,${lines.length} @@\n${lines.join('\n')}\n`,
  additions: lines.length,
  deletions: 0,
  status: 'added',
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <div style={{ height: 800 }}>
        <GuideDiff
          files={[bigFile]}
          fileScrollTarget={null}
          fileOrder="list"
          mountCollapsed={false}
          initialScrollPosition={0}
          onScrollPositionChange={() => {}}
          onFileCollapsedChange={() => {}}
          isActive
          allowScrollChaining
          largeDiffsInWorker
        />
      </div>,
    );
  });
}

/** Milliseconds until the file's first line is drawn (Pierre draws in shadow roots), or null past the limit. */
async function msToFirstLine(limitMs: number): Promise<number | null> {
  const start = performance.now();
  while (performance.now() - start < limitMs) {
    const drawn = [...host!.querySelectorAll('*')].some((el) => el.shadowRoot?.textContent?.includes('value0 = 0'));
    if (drawn) return performance.now() - start;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  return null;
}

test.skipIf(!hasDom)('a very large diff whose worker cannot start draws at once, and again when mounted later', async () => {
  mount();
  // Well under the pool's 5 s readiness wait.
  expect(await msToFirstLine(2_500)).not.toBeNull();

  act(() => root!.unmount());
  host!.remove();
  mount();
  expect(await msToFirstLine(2_500)).not.toBeNull();
}, 20_000);
