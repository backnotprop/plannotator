import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeGuideData } from '@plannotator/shared/guide';
import type { DiffFile } from '../../types';
import { ReviewStateProvider, type ReviewState } from '../../dock/ReviewStateContext';

let latestCodeViewProps: Record<string, unknown>[] = [];
mock.module('../AllFilesCodeView', () => ({
  AllFilesCodeView: (props: Record<string, unknown>) => {
    latestCodeViewProps.push(props);
    const files = props.files as DiffFile[];
    return <div data-testid="file-code-view" data-file={files[0]?.path} />;
  },
}));
const { GuideView, resolveGuideSectionFiles } = await import('./GuideView');

const hasDom = typeof document !== 'undefined';

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

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    files: [],
    guideRevealFile: null,
    ...overrides,
  } as unknown as ReviewState;
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
    state?: ReviewState;
    onFocusFile?: (path: string) => void;
  } = {},
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <ReviewStateProvider value={options.state ?? makeState()}>
        <GuideView
          guide={guide}
          reviewed={guide.reviewed}
          onToggleReviewed={() => {}}
          focusedFile={null}
          onFocusFile={options.onFocusFile ?? (() => {})}
          onRegenerate={options.onRegenerate}
        />
      </ReviewStateProvider>,
    );
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
  test.skipIf(!hasDom)('renders no Saved chip and no outdated hint by default', async () => {
    await renderView(makeGuide());
    expect(host!.textContent).not.toContain('Saved');
    expect(host!.textContent).not.toContain('Generated on a different version');
  });

  test.skipIf(!hasDom)('renders the Saved chip when the guide is persisted', async () => {
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
        <ReviewStateProvider value={makeState({ files, guideRevealFile: { path: 'a.ts', token: 1 } })}>
          <GuideView
            guide={guide}
            reviewed={guide.reviewed}
            onToggleReviewed={() => {}}
            focusedFile={null}
            onFocusFile={() => {}}
          />
        </ReviewStateProvider>,
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
