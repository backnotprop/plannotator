import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeGuideData } from '@plannotator/core/guide';
import type { DiffFile } from './types';
import { GuideHostProvider, type GuideHostValue } from './host';
import {
  GUIDE_EAGER_MOUNT_MAX_FILES,
  GUIDE_MAX_MOUNTED_CODE_VIEWS,
  GuideViewportProvider,
  useGuideFileWindow,
} from './GuideViewportManager';
import { GuideView } from './GuideView';

const hasDom = typeof document !== 'undefined';

/**
 * An IntersectionObserver that never delivers. Mount state observed under it is
 * exactly what the manager decides on its own (seed vs eager), which is what
 * these tests pin.
 */
class SilentIntersectionObserver {
  static instances = 0;
  constructor(_callback: IntersectionObserverCallback) {
    SilentIntersectionObserver.instances += 1;
  }
  observe = () => {};
  unobserve = () => {};
  disconnect = () => {};
}

/** One registered shell; renders a marker only while the manager admits it. */
function Shell({ id }: { id: string }) {
  const { mounted, register } = useGuideFileWindow(id);
  return (
    <div ref={register} data-shell={id}>
      {mounted && <span data-testid="mounted" data-shell-mounted={id} />}
    </div>
  );
}

function FakeDiffRenderer(props: Record<string, unknown>) {
  const files = props.files as DiffFile[];
  return <div data-testid="file-code-view" data-file={files[0]?.path} />;
}

function makeFile(path: string): DiffFile {
  return {
    path,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    additions: 1,
    deletions: 1,
    status: 'modified',
  };
}

function makeHost(files: DiffFile[]): GuideHostValue<Record<string, unknown>> {
  return {
    files,
    DiffRenderer: FakeDiffRenderer as unknown as GuideHostValue<Record<string, unknown>>['DiffRenderer'],
    getDiffRendererProps: () => ({}),
    revealFile: null,
    activeSearchMatch: null,
  };
}

function makeGuide(files: DiffFile[]): CodeGuideData {
  return {
    title: 'Guide',
    intent: '',
    sections: [{ title: 'All', overview: '', diffs: files.map((file) => ({ file: file.path })) }],
    reviewed: [false],
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const originalObserver = globalThis.IntersectionObserver;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  SilentIntersectionObserver.instances = 0;
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: originalObserver });
  if (hasDom) document.body.innerHTML = '';
});

async function render(node: React.ReactNode) {
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: SilentIntersectionObserver,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

function mountedIds(): string[] {
  return [...host!.querySelectorAll<HTMLElement>('[data-shell-mounted]')].map((el) => el.dataset.shellMounted!);
}

describe('GuideViewportProvider eager mode', () => {
  const ids = Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`);

  test.skipIf(!hasDom)('mounts every registered shell without any observer delivery', async () => {
    await render(
      <GuideViewportProvider eager>
        {ids.map((id) => <Shell key={id} id={id} />)}
      </GuideViewportProvider>,
    );

    expect(mountedIds()).toEqual(ids);
    // No window means no observer: nothing is constructed to evict from.
    expect(SilentIntersectionObserver.instances).toBe(0);
  });

  test.skipIf(!hasDom)('keeps every shell mounted when one is added or the focus pin moves', async () => {
    const Harness = ({ count, focused }: { count: number; focused: string }) => (
      <GuideViewportProvider eager>
        {ids.slice(0, count).map((id) => <PinnableShell key={id} id={id} pinned={id === focused} />)}
      </GuideViewportProvider>
    );
    function PinnableShell({ id, pinned }: { id: string; pinned: boolean }) {
      const { mounted, register, requestMount } = useGuideFileWindow(id, pinned);
      React.useEffect(() => {
        if (pinned) requestMount();
      }, [pinned, requestMount]);
      return (
        <div ref={register} data-shell={id}>
          {mounted && <span data-shell-mounted={id} />}
        </div>
      );
    }

    await render(<Harness count={11} focused={ids[0]} />);
    expect(mountedIds()).toEqual(ids.slice(0, 11));

    await act(async () => {
      root!.render(<Harness count={12} focused={ids[11]} />);
    });
    expect(mountedIds()).toEqual(ids);
  });

  test.skipIf(!hasDom)('without eager only the seed mounts before the observer delivers', async () => {
    await render(
      <GuideViewportProvider>
        {ids.map((id) => <Shell key={id} id={id} />)}
      </GuideViewportProvider>,
    );

    const mounted = mountedIds();
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(ids.length);
    expect(mounted.length).toBeLessThanOrEqual(GUIDE_MAX_MOUNTED_CODE_VIEWS);
    expect(SilentIntersectionObserver.instances).toBe(1);
  });
});

describe('GuideView eager threshold', () => {
  function renderGuide(files: DiffFile[], hostFiles: DiffFile[] = files) {
    return render(
      <GuideHostProvider value={makeHost(hostFiles)}>
        <GuideView
          guide={makeGuide(files)}
          reviewed={[false]}
          onToggleReviewed={() => {}}
          focusedFile={null}
          onFocusFile={() => {}}
        />
      </GuideHostProvider>,
    );
  }

  test.skipIf(!hasDom)('a guide at the file limit mounts every CodeView up front, however large the review', async () => {
    // The threshold counts the guide's own files, not the whole review behind the host.
    const review = Array.from({ length: GUIDE_EAGER_MOUNT_MAX_FILES + 10 }, (_, index) => makeFile(`src/file-${index}.ts`));
    const files = review.slice(0, GUIDE_EAGER_MOUNT_MAX_FILES);
    await renderGuide(files, review);

    expect(host!.querySelectorAll('[data-guide-file-shell]')).toHaveLength(files.length);
    expect(host!.querySelectorAll('[data-testid="file-code-view"]')).toHaveLength(files.length);
  });

  test.skipIf(!hasDom)('one file over the limit keeps the bounded window', async () => {
    const files = Array.from({ length: GUIDE_EAGER_MOUNT_MAX_FILES + 1 }, (_, index) => makeFile(`src/file-${index}.ts`));
    await renderGuide(files);

    expect(host!.querySelectorAll('[data-guide-file-shell]')).toHaveLength(files.length);
    const mounted = host!.querySelectorAll('[data-testid="file-code-view"]').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThanOrEqual(GUIDE_MAX_MOUNTED_CODE_VIEWS);
    expect(mounted).toBeLessThan(files.length);
  });
});
