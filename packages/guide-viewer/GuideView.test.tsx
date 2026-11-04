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
    bare?: boolean;
    fitFileHeights?: boolean;
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
          bare={options.bare}
          fitFileHeights={options.fitFileHeights}
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

describe('GuideView section count', () => {
  test.skipIf(!hasDom)('numbers the cards against the sections the header counts; "Everything else" is unnumbered', async () => {
    const guide = makeGuide({
      sections: [
        { title: 'First', overview: '', diffs: [{ file: 'a.ts' }] },
        { title: 'Second', overview: '', diffs: [{ file: 'b.ts' }] },
      ],
      unplacedFiles: ['c.ts'],
      reviewed: [false, false],
    });
    await renderView(guide, { state: makeState({ files: [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')] }) });
    const text = host!.textContent ?? '';
    expect(text).toContain('2 sections');
    expect(text).toContain('01 / 02');
    expect(text).toContain('02 / 02');
    expect(text).not.toContain('/ 03');
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

describe('GuideView global comments', () => {
  // Guards the button leaking into hosts that take no comments (guides.show, the VS Code reader), a read-only
  // review still offering it, and the composer opening anywhere but on the button.
  test.skipIf(!hasDom)('draws the Global comment button and the list only for a host that passes them', async () => {
    await renderView(makeGuide());
    expect(host!.querySelector('[data-guide-global-comment-add]')).toBeNull();
    expect(host!.querySelector('[data-guide-global-comments]')).toBeNull();

    const anchors: HTMLElement[] = [];
    const chosen: string[] = [];
    await renderView(makeGuide(), {
      state: {
        ...makeState(),
        globalComments: { comments: [{ id: 'g1', text: 'Split it in two.' }], onAdd: (anchor) => anchors.push(anchor), onSelect: (id) => chosen.push(id) },
      },
    });
    const add = host!.querySelector<HTMLButtonElement>('[data-guide-global-comment-add]')!;
    expect(add.textContent).toBe('Global comment');
    await act(async () => add.click());
    expect(anchors).toEqual([add]);
    const list = host!.querySelector('[data-guide-global-comments]')!;
    // Under the header, before the first section.
    expect(list.compareDocumentPosition(host!.querySelector('[data-guide-section]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => list.querySelector<HTMLButtonElement>('[data-guide-global-comment="g1"] button')!.click());
    expect(chosen).toEqual(['g1']);

    // Read-only: the comments stay, the button goes.
    await renderView(makeGuide(), { state: { ...makeState(), globalComments: { comments: [{ id: 'g1', text: 'Split it in two.' }] } } });
    expect(host!.querySelector('[data-guide-global-comment-add]')).toBeNull();
    expect(host!.querySelector('[data-guide-global-comments]')!.textContent).toContain('Split it in two.');
  });
});

/** A new file of `rows` lines, as git writes it: five header lines before the hunk. */
function addedFile(path: string, rows: number): DiffFile {
  const body = Array.from({ length: rows }, (_, i) => `+line ${i + 1}`).join('\n');
  return {
    path,
    patch: `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${rows} @@\n${body}\n`,
    additions: rows,
    deletions: 0,
    status: 'added',
  };
}

const boxHeight = (path: string) =>
  host!.querySelector<HTMLElement>(`[data-guide-file-shell="${path}"] [data-guide-code-view-mounted]`)!.style.height;

describe('GuideView bare (the Inbox PR page)', () => {
  // Guards the empty band under a short file on the PR page (#2615): the box was sized by an estimate that counted
  // git's header lines and a 150px floor, so a 5-line file stood in a 304px box.
  test.skipIf(!hasDom)('a file box is as tall as its diff: the hunk rows first, then the height the renderer reports', async () => {
    const guide = makeGuide({ sections: [{ title: 'Every changed file', overview: '', diffs: [{ file: 'm.sql' }, { file: 's.ts' }] }] });
    const files = [addedFile('m.sql', 5), addedFile('s.ts', 10)];
    await renderView(guide, { bare: true, state: makeState({ files }) });
    // Before a measure: 5 and 10 rows of 20px, the 33px header, the list's padding and the border, as the browser lays it out.
    expect(boxHeight('m.sql')).toBe('159px');
    expect(boxHeight('s.ts')).toBe('259px');

    const report = (path: string) => latestCodeViewProps.filter((p) => (p.files as DiffFile[])[0]?.path === path).at(-1)!.onContentHeightChange as (h: number) => void;
    // Inline comments or wrapped lines grow the content: the box follows, up to the usual 620px, past which it scrolls.
    await act(async () => report('m.sql')(300));
    expect(boxHeight('m.sql')).toBe('302px');
    await act(async () => report('m.sql')(4000));
    expect(boxHeight('m.sql')).toBe('620px');
  });

  // Guards the Inbox's guided review in a thread (not bare) getting the fit through the opt-in.
  test.skipIf(!hasDom)('a host opts in without bare: the box fits, the heading stays', async () => {
    const guide = makeGuide({ sections: [{ title: 'One', overview: '', diffs: [{ file: 'm.sql' }] }] });
    await renderView(guide, { fitFileHeights: true, state: makeState({ files: [addedFile('m.sql', 5)] }) });
    expect(boxHeight('m.sql')).toBe('159px');
    expect(host!.querySelector('h1')).not.toBeNull();
    expect(latestCodeViewProps.at(-1)!.onContentHeightChange).toBeFunction();
  });

  // Guards the Split over-count: a replaced line is one row in Split, two in Unified; before a measure the box follows the host's layout.
  test.skipIf(!hasDom)('the first estimate follows the layout the host draws: Split pairs removed and added lines', async () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,4 +1,5 @@\n ctx\n-a\n-b\n+A\n+B\n+C\n ctx2\n-d\n';
    const file: DiffFile = { path: 'a.ts', patch, additions: 3, deletions: 3, status: 'modified' };
    const guide = makeGuide({ sections: [{ title: 'One', overview: '', diffs: [{ file: 'a.ts' }] }] });
    // Rows: ctx, ctx2, then 3 (max of 2 removed, 3 added) and 1 → 6 in Split; ctx, ctx2, 5 and 1 → 8 in Unified.
    await renderView(guide, { fitFileHeights: true, state: { ...makeState({ files: [file] }), diffStyle: 'split' } });
    expect(boxHeight('a.ts')).toBe(`${59 + 6 * 20}px`);
    await renderView(guide, { fitFileHeights: true, state: { ...makeState({ files: [file] }), diffStyle: 'unified' } });
    expect(boxHeight('a.ts')).toBe(`${59 + 8 * 20}px`);
  });

  // Guards a commented file's box dipping for a frame: a remounted CodeView first reports its layout before its
  // inline comments are drawn. A real shrink still lands once the viewer has drawn.
  test.skipIf(!hasDom)('after a remount a shrinking report waits until the viewer has drawn', async () => {
    const originalObserver = globalThis.IntersectionObserver;
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: FakeIntersectionObserver });
    const realFrame = globalThis.requestAnimationFrame;
    const realCancel = globalThis.cancelAnimationFrame;
    try {
      const files = Array.from({ length: 20 }, (_, index) => addedFile(`src/file-${index}.ts`, 5));
      const guide = makeGuide({ sections: [{ title: 'Large', overview: '', diffs: files.map((file) => ({ file: file.path })) }] });
      await renderView(guide, { fitFileHeights: true, state: makeState({ files }) });
      const observer = FakeIntersectionObserver.latest!;
      const shells = [...host!.querySelectorAll<HTMLElement>('[data-guide-file-shell]')];
      const near = (matches: (index: number) => boolean) => act(async () => {
        observer.trigger(shells.map((target, index) => ({ target, isIntersecting: matches(index) })));
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      const path = files[1]!.path;
      const report = () => [...latestCodeViewProps].reverse().find((p) => (p.files as DiffFile[])[0]?.path === path)!.onContentHeightChange as (h: number) => void;
      await near((index) => index < 8);
      // The file with its comments drawn.
      await act(async () => report()(400));
      expect(boxHeight(path)).toBe('402px');

      // Past the mount lease, the window moves away and the CodeView unmounts; the box keeps its height.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
      await near((index) => index >= 8 && index < 16);
      expect(host!.querySelector(`[data-testid="file-code-view"][data-file="${path}"]`)).toBeNull();
      expect(boxHeight(path)).toBe('402px');

      // Frames by hand while a wait runs: happy-dom's run at once, and the wait is counted in frames. (The viewport
      // manager needs real ones to move the window, so `back` brings the file in first.)
      const queued = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      const back = async () => {
        globalThis.requestAnimationFrame = realFrame;
        globalThis.cancelAnimationFrame = realCancel;
        await act(async () => {
          shells[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 25));
        });
        globalThis.requestAnimationFrame = (callback) => {
          frameId += 1;
          queued.set(frameId, callback);
          return frameId;
        };
        globalThis.cancelAnimationFrame = (id) => void queued.delete(id);
      };
      const frame = () => act(async () => {
        const due = [...queued.values()];
        queued.clear();
        for (const callback of due) callback(0);
      });

      // Back: the first report, before the comments are drawn, does not shrink the box; a growth lands at once.
      await back();
      expect(host!.querySelector(`[data-testid="file-code-view"][data-file="${path}"]`)).not.toBeNull();
      await act(async () => report()(157));
      expect(boxHeight(path)).toBe('402px');
      await act(async () => report()(410));
      expect(boxHeight(path)).toBe('412px');
      // The wait is over: a report that really is smaller lands at once.
      await act(async () => report()(300));
      expect(boxHeight(path)).toBe('302px');

      // A shrink alone, the viewer drawn with no later report: it lands after two frames.
      globalThis.requestAnimationFrame = realFrame;
      globalThis.cancelAnimationFrame = realCancel;
      await act(async () => {
        shells[8]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 1_550));
      });
      await near((index) => index >= 8 && index < 16);
      expect(host!.querySelector(`[data-testid="file-code-view"][data-file="${path}"]`)).toBeNull();
      await back();
      await act(async () => report()(157));
      await frame();
      expect(boxHeight(path)).toBe('302px');
      await frame();
      expect(boxHeight(path)).toBe('159px');
    } finally {
      globalThis.requestAnimationFrame = realFrame;
      globalThis.cancelAnimationFrame = realCancel;
      FakeIntersectionObserver.latest = null;
      Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: originalObserver });
    }
  });

  // Guards the shared chain's default (the review app, guides.show, VS Code): unchanged.
  test.skipIf(!hasDom)('with neither bare nor the opt-in the box keeps its estimate and the renderer is asked for no height', async () => {
    const guide = makeGuide({ sections: [{ title: 'Every changed file', overview: '', diffs: [{ file: 'm.sql' }] }] });
    await renderView(guide, { state: makeState({ files: [addedFile('m.sql', 5)] }) });
    expect(boxHeight('m.sql')).toBe('304px');
    expect(latestCodeViewProps.every((p) => !('onContentHeightChange' in p))).toBe(true);
  });

  // Guards the owner's choice (q-bfcf3a4a B): on the PR page the Global comment button sits on the Split | Unified
  // tab's row, not on a row of its own above it; with no tab (a phone) it keeps its own row.
  test.skipIf(!hasDom)('the Global comment button shares the first card\'s tab row; with no tab it keeps its own row', async () => {
    const guide = makeGuide({ sections: [{ title: 'Every changed file', overview: '', diffs: [{ file: 'a.ts' }] }] });
    const globalComments = { comments: [], onAdd: () => {} };
    const withTab = { ...makeState({ files: [makeFile('a.ts')] }), globalComments, renderSectionTab: (i: number) => (i === 0 ? <div data-testid="switch">Split | Unified</div> : null) };

    await renderView(guide, { bare: true, state: withTab });
    const buttons = host!.querySelectorAll('[data-guide-global-comment-add]');
    expect(buttons).toHaveLength(1);
    const row = buttons[0]!.closest('[data-guide-section-tab]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('[data-testid="switch"]')).not.toBeNull();
    expect(buttons[0]!.closest('[data-guide-section-tab-lead]')).not.toBeNull();

    // A phone: no tab, so the button stays above the content on a row of its own.
    await renderView(guide, { bare: true, state: { ...makeState({ files: [makeFile('a.ts')] }), globalComments } });
    expect(host!.querySelectorAll('[data-guide-global-comment-add]')).toHaveLength(1);
    expect(host!.querySelector('[data-guide-global-comment-add]')!.closest('[data-guide-section-tab]')).toBeNull();

    // Not bare (the review app, the Inbox's guided review): the header keeps the button, the tab keeps its row.
    await renderView(guide, { state: withTab });
    expect(host!.querySelector('[data-guide-global-comment-add]')!.closest('[data-guide-section-tab]')).toBeNull();
    expect(host!.querySelector('[data-guide-section-tab-lead]')).toBeNull();
  });
});
