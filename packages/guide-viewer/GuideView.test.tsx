import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeGuideData } from '@plannotator/core/guide';
import type { DiffFile } from './types';
import { GuideHostProvider, type GuideHostValue } from './host';

let latestCodeViewProps: Record<string, unknown>[] = [];
/** Stand-in diff renderer: records the props the guide chain hands it. */
function FakeDiffRenderer(props: Record<string, unknown>) {
  latestCodeViewProps.push(props);
  const files = props.files as DiffFile[];
  return <div data-testid="file-code-view" data-file={files[0]?.path} />;
}
import { GuideView, resolveGuideSectionFiles } from './GuideView';

const hasDom = typeof document !== 'undefined';

class FakeIntersectionObserver {
  static latest: FakeIntersectionObserver | null = null;

  private readonly callback: IntersectionObserverCallback;
  private readonly observed = new Set<Element>();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.latest = this;
  }

  observe = (target: Element) => {
    this.observed.add(target);
  };

  unobserve = (target: Element) => {
    this.observed.delete(target);
  };

  disconnect = () => {
    this.observed.clear();
  };

  trigger(entries: Array<{ target: Element; isIntersecting: boolean }>) {
    const observedEntries = entries
      .filter(({ target }) => this.observed.has(target))
      .map(({ target, isIntersecting }) => ({ target, isIntersecting }) as IntersectionObserverEntry);
    this.callback(observedEntries, this as unknown as IntersectionObserver);
  }
}

function makeGuide(overrides: Partial<CodeGuideData> = {}): CodeGuideData {
  return {
    title: 'Persisted guide',
    intent: 'Test intent.',
    sections: [{ title: 'Core', overview: 'The heart.', diffs: [{ file: 'a.ts', summary: 'Changes A.' }] }],
    reviewed: [false],
    ...overrides,
  };
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

type HostOverrides = {
  files?: DiffFile[];
  guideRevealFile?: { path: string; token: number } | null;
  onGuideRevealFile?: (path: string) => void;
  allFilesActiveSearchMatch?: { id: string; filePath: string } | null;
  [passthrough: string]: unknown;
};

/** Build a GuideHost value: known host fields map onto the contract, anything else is forwarded to the renderer. */
function makeState(overrides: HostOverrides = {}): GuideHostValue<Record<string, unknown>> {
  const { files = [], guideRevealFile = null, onGuideRevealFile, allFilesActiveSearchMatch = null, ...passthrough } = overrides;
  return {
    files,
    DiffRenderer: FakeDiffRenderer as unknown as GuideHostValue<Record<string, unknown>>['DiffRenderer'],
    // Mirrors the in-app host, which also forwards the active match to the renderer.
    getDiffRendererProps: () => ({ ...passthrough, activeSearchMatch: allFilesActiveSearchMatch }),
    revealFile: guideRevealFile,
    onRevealFile: onGuideRevealFile,
    activeSearchMatch: allFilesActiveSearchMatch,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  latestCodeViewProps = [];
  if (hasDom) document.body.innerHTML = '';
});

async function renderView(
  guide: CodeGuideData,
  options: {
    onRegenerate?: () => void;
    state?: GuideHostValue<Record<string, unknown>>;
    onFocusFile?: (path: string) => void;
  } = {},
) {
  const Harness = () => {
    const [focusedFile, setFocusedFile] = React.useState<string | null>(null);
    const handleFocusFile = React.useCallback((path: string) => {
      setFocusedFile(path);
      options.onFocusFile?.(path);
    }, [options.onFocusFile]);
    return (
      <GuideHostProvider value={options.state ?? makeState()}>
        <GuideView
          guide={guide}
          reviewed={guide.reviewed}
          onToggleReviewed={() => {}}
          focusedFile={focusedFile}
          onFocusFile={handleFocusFile}
          onRegenerate={options.onRegenerate}
        />
      </GuideHostProvider>
    );
  };

  // A second render inside one test replaces the previous tree instead of leaking it into document.body.
  if (root !== null) await act(async () => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness />);
  });
}

describe('resolveGuideSectionFiles', () => {
  test('preserves chapter order, separates unplaced files, and ignores stale or duplicate refs', () => {
    const guide = makeGuide({
      sections: [
        { title: 'First', overview: '', diffs: [{ file: 'b.ts' }, { file: 'missing.ts' }] },
        { title: 'Second', overview: '', diffs: [{ file: 'a.ts' }, { file: 'b.ts' }] },
      ],
      unplacedFiles: ['c.ts', 'a.ts'],
      reviewed: [false, false],
    });

    const resolved = resolveGuideSectionFiles(guide, [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')]);

    expect(resolved.sectionFiles.map((files) => files.map((file) => file.path))).toEqual([['b.ts'], ['a.ts']]);
    expect(resolved.unplacedFiles.map((file) => file.path)).toEqual(['c.ts']);
  });
});

describe('GuideView persistence affordances (#1112)', () => {
  test.skipIf(!hasDom)('renders the Saved chip only when persisted, and no outdated hint either way', async () => {
    await renderView(makeGuide());
    expect(host!.textContent).not.toContain('Saved');
    expect(host!.textContent).not.toContain('Generated on a different version');

    await renderView(makeGuide({ saved: true }));
    expect(host!.textContent).toContain('Saved');
    expect(host!.textContent).not.toContain('Generated on a different version');
  });

  test.skipIf(!hasDom)('renders the outdated hint with a wired Regenerate action when moved', async () => {
    let regenerated = 0;
    await renderView(makeGuide({ saved: true, moved: true }), { onRegenerate: () => { regenerated += 1; } });
    const regenerate = [...host!.querySelectorAll('button')].find((button) => button.textContent === 'Regenerate');
    expect(regenerate).not.toBeNull();
    await act(async () => regenerate!.click());
    expect(regenerated).toBe(1);
  });

  test.skipIf(!hasDom)('moved without a regenerate handler renders no action', async () => {
    await renderView(makeGuide({ saved: true, moved: true }));
    expect([...host!.querySelectorAll('button')].find((button) => button.textContent === 'Regenerate')).toBeUndefined();
  });
});

describe('GuideView per-file windowing', () => {
  test.skipIf(!hasDom)('keeps 250 file shells while mounting only a bounded one-file CodeView window', async () => {
    const files = Array.from({ length: 250 }, (_, index) => makeFile(`src/file-${index}.ts`));
    const groups = [74, 38, 19, 30, 42, 47];
    let offset = 0;
    const sections = groups.map((count, sectionIndex) => {
      const sectionFiles = files.slice(offset, offset + count);
      offset += count;
      return {
        title: `Chapter ${sectionIndex + 1}`,
        overview: 'Virtualized chapter.',
        diffs: sectionFiles.map((file) => ({ file: file.path, summary: `Summary for ${file.path}` })),
      };
    });
    const guide = makeGuide({ sections, reviewed: groups.map(() => false) });

    await renderView(guide, { state: makeState({ files }) });

    expect(host!.querySelectorAll('[data-guide-file-shell]')).toHaveLength(250);
    const mounted = host!.querySelectorAll('[data-testid="file-code-view"]');
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(8);
    expect(latestCodeViewProps.every((props) => (props.files as DiffFile[]).length === 1)).toBe(true);
    expect(host!.querySelectorAll('diffs-container')).toHaveLength(0);
  });

  test.skipIf(!hasDom)('force-mounts an offscreen file before passing its tokenized reveal target', async () => {
    const files = Array.from({ length: 20 }, (_, index) => makeFile(`src/file-${index}.ts`));
    const target = files[19];
    const guide = makeGuide({
      sections: [{
        title: 'Large chapter',
        overview: '',
        diffs: files.map((file) => ({ file: file.path })),
      }],
      reviewed: [false],
    });

    await renderView(guide, {
      state: makeState({ files, guideRevealFile: { path: target.path, token: 7 } }),
    });

    const targeted = latestCodeViewProps.find(
      (props) => (props.files as DiffFile[])[0]?.path === target.path && props.fileScrollTarget != null,
    );
    expect(targeted?.fileScrollTarget).toEqual({ filePath: target.path, token: 7 });
    expect(host!.querySelectorAll('[data-testid="file-code-view"]').length).toBeLessThanOrEqual(8);
  });

  test.skipIf(!hasDom)('a reviewed chapter stays collapsed until navigation reveals it', async () => {
    const files = [makeFile('a.ts')];
    const guide = makeGuide({ reviewed: [true] });
    const baseState = makeState({ files });
    await renderView(guide, { state: baseState });
    expect(host!.querySelectorAll('[data-testid="file-code-view"]')).toHaveLength(0);

    await act(async () => {
      root!.render(
        <GuideHostProvider value={makeState({ files, guideRevealFile: { path: 'a.ts', token: 1 } })}>
          <GuideView
            guide={guide}
            reviewed={guide.reviewed}
            onToggleReviewed={() => {}}
            focusedFile={null}
            onFocusFile={() => {}}
          />
        </GuideHostProvider>,
      );
    });
    expect(host!.querySelectorAll('[data-testid="file-code-view"]')).toHaveLength(1);
  });

  test.skipIf(!hasDom)('routes a file chip through the shared reveal channel', async () => {
    const reveals: string[] = [];
    const files = [makeFile('a.ts')];
    await renderView(makeGuide(), {
      state: makeState({ files, onGuideRevealFile: (path) => reveals.push(path) }),
    });

    const chip = host!.querySelector<HTMLButtonElement>('button[title^="a.ts"]');
    expect(chip).not.toBeNull();
    await act(async () => chip!.click());
    expect(reveals).toEqual(['a.ts']);
  });

  test.skipIf(!hasDom)('reveals, mounts, and activates an offscreen search result', async () => {
    const files = Array.from({ length: 20 }, (_, index) => makeFile(`src/file-${index}.ts`));
    const target = files[19];
    const match = {
      id: `${target.path}:addition:1:0:0`,
      filePath: target.path,
      side: 'addition' as const,
      lineNumber: 1,
      text: 'new',
      matchStart: 0,
      matchEnd: 3,
      snippet: 'new',
    };
    const guide = makeGuide({
      sections: [{
        title: 'Large chapter',
        overview: '',
        diffs: files.map((file) => ({ file: file.path })),
      }],
      reviewed: [false],
    });

    await renderView(guide, {
      state: makeState({
        files,
        activeSearchMatchId: match.id,
        allFilesActiveSearchMatch: match,
        searchMatches: [match],
      }),
    });

    const targetProps = [...latestCodeViewProps].reverse().find(
      (props) => (props.files as DiffFile[])[0]?.path === target.path,
    );
    expect(targetProps?.fileScrollTarget).toEqual({ filePath: target.path, token: 1 });
    expect(targetProps?.activeSearchMatch).toEqual(match);
    expect(targetProps?.isActive).toBe(true);
  });

  test.skipIf(!hasDom)('updates the bounded fallback window while scrolling without IntersectionObserver', async () => {
    const originalObserver = globalThis.IntersectionObserver;
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: undefined });

    try {
      const files = Array.from({ length: 20 }, (_, index) => makeFile(`src/file-${index}.ts`));
      const guide = makeGuide({
        sections: [{
          title: 'Large chapter',
          overview: '',
          diffs: files.map((file) => ({ file: file.path })),
        }],
        reviewed: [false],
      });
      await renderView(guide, { state: makeState({ files }) });

      const shells = [...host!.querySelectorAll<HTMLElement>('[data-guide-file-shell]')];
      shells.forEach((shell, index) => {
        const top = index === 19 ? 100 : 5_000 + index * 100;
        shell.getBoundingClientRect = () => ({
          x: 0,
          y: top,
          top,
          right: 800,
          bottom: top + 80,
          left: 0,
          width: 800,
          height: 80,
          toJSON: () => ({}),
        });
      });

      await act(async () => {
        window.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      expect(host!.querySelector(`[data-testid="file-code-view"][data-file="${files[19].path}"]`)).not.toBeNull();
      expect(host!.querySelectorAll('[data-testid="file-code-view"]').length).toBeLessThanOrEqual(8);
    } finally {
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        value: originalObserver,
      });
    }
  });

  test.skipIf(!hasDom)('pins the focused card and restores collapsed state after a real eviction', async () => {
    const originalObserver = globalThis.IntersectionObserver;
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: FakeIntersectionObserver,
    });

    try {
      const files = Array.from({ length: 20 }, (_, index) => makeFile(`src/file-${index}.ts`));
      const guide = makeGuide({
        sections: [{
          title: 'Large chapter',
          overview: '',
          diffs: files.map((file) => ({ file: file.path })),
        }],
        reviewed: [false],
      });
      await renderView(guide, { state: makeState({ files }) });

      const observer = FakeIntersectionObserver.latest;
      expect(observer).not.toBeNull();
      const shells = [...host!.querySelectorAll<HTMLElement>('[data-guide-file-shell]')];
      await act(async () => {
        observer!.trigger(shells.map((target, index) => ({ target, isIntersecting: index < 8 })));
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      const focusedBefore = host!.querySelector<HTMLElement>(
        `[data-testid="file-code-view"][data-file="${files[0].path}"]`,
      );
      expect(focusedBefore).not.toBeNull();

      const fileOneProps = [...latestCodeViewProps].reverse().find(
        (props) => (props.files as DiffFile[])[0]?.path === files[1].path,
      );
      await act(async () => {
        (fileOneProps!.onFileCollapsedChange as (path: string, collapsed: boolean) => void)(files[1].path, true);
      });

      // Let the old 1.5s force-mount lease expire; only the focus pin may keep
      // file 0 alive when the observer moves the near window away.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_550));
      });
      await act(async () => {
        observer!.trigger(shells.map((target, index) => ({
          target,
          isIntersecting: index >= 8 && index < 16,
        })));
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      expect(host!.querySelector(`[data-testid="file-code-view"][data-file="${files[0].path}"]`)).toBe(focusedBefore);
      expect(host!.querySelector(`[data-testid="file-code-view"][data-file="${files[1].path}"]`)).toBeNull();
      expect(host!.querySelectorAll('[data-testid="file-code-view"]').length).toBeLessThanOrEqual(8);

      await act(async () => {
        observer!.trigger(shells.map((target, index) => ({
          target,
          isIntersecting: index === 1 || (index >= 8 && index < 15),
        })));
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      const remountedFileOneProps = [...latestCodeViewProps].reverse().find(
        (props) => (props.files as DiffFile[])[0]?.path === files[1].path,
      );
      expect(remountedFileOneProps?.mountCollapsed).toBe(true);
    } finally {
      FakeIntersectionObserver.latest = null;
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        value: originalObserver,
      });
    }
  });

  test.skipIf(!hasDom)('only the focused file enables CodeView keyboard handling', async () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')];
    const guide = makeGuide({
      sections: [
        { title: 'A', overview: '', diffs: [{ file: 'a.ts' }] },
        { title: 'B', overview: '', diffs: [{ file: 'b.ts' }] },
      ],
      reviewed: [false, false],
    });
    await renderView(guide, { state: makeState({ files }) });

    const codeViews = [...host!.querySelectorAll<HTMLElement>('[data-testid="file-code-view"]')];
    expect(codeViews).toHaveLength(2);
    const latestByFile = new Map<string, Record<string, unknown>>();
    for (const props of latestCodeViewProps) {
      const path = (props.files as DiffFile[])[0]?.path;
      if (path) latestByFile.set(path, props);
    }
    expect(latestByFile.get('a.ts')?.isActive).toBe(true);
    expect(latestByFile.get('b.ts')?.isActive).toBe(false);
  });
});
