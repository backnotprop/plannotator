import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GuideSection } from '@plannotator/shared/guide';
import type { DiffFile } from '../../types';
import { ReviewStateProvider, type ReviewState } from '../../dock/ReviewStateContext';
import { GUIDE_MAX_MOUNTED_CODE_VIEWS, GuideViewportProvider } from './GuideViewportManager';

let codeViewProps: Record<string, unknown>[] = [];
mock.module('../AllFilesCodeView', () => ({
  AllFilesCodeView: (props: Record<string, unknown>) => {
    codeViewProps.push(props);
    const files = props.files as DiffFile[];
    return <div data-testid="file-code-view" data-file={files[0]?.path} />;
  },
}));
const { GuideSectionCard } = await import('./GuideSectionCard');

const hasDom = typeof document !== 'undefined';

const section: GuideSection = {
  title: 'Payment localization module',
  overview: 'Chapter overview.',
  diffs: [{ file: 'src/payments/localize.ts', summary: 'Localizes payments.' }],
};

function makeFile(path = 'src/payments/localize.ts'): DiffFile {
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
    aiMessages: [],
    onClickAIMarker: () => {},
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
  codeViewProps = [];
  if (hasDom) document.body.innerHTML = '';
});

function renderCard(
  state: ReviewState,
  props: Partial<React.ComponentProps<typeof GuideSectionCard>> = {},
) {
  const file = makeFile();
  return (
    <ReviewStateProvider value={state}>
      <GuideViewportProvider>
        <GuideSectionCard
          section={section}
          files={[file]}
          index={0}
          total={1}
          reviewed={false}
          onToggleReviewed={() => {}}
          focusedFile={file.path}
          revealTarget={null}
          onActivate={() => {}}
          onRequestReveal={() => {}}
          {...props}
        />
      </GuideViewportProvider>
    </ReviewStateProvider>
  );
}

describe('GuideSectionCard', () => {
  test.skipIf(!hasDom)('keeps every file shell but mounts only a bounded window of one-file CodeViews', async () => {
    const files = Array.from({ length: 74 }, (_, index) => makeFile(`src/file-${index}.ts`));
    const largeSection: GuideSection = {
      title: 'Large chapter',
      overview: '',
      diffs: files.map((file) => ({ file: file.path, summary: `Summary for ${file.path}` })),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(makeState({ files }), {
        section: largeSection,
        files,
        focusedFile: files[0].path,
      }));
    });

    expect(host.querySelectorAll('[data-guide-file-shell]')).toHaveLength(74);
    const mounted = host.querySelectorAll('[data-testid="file-code-view"]');
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(GUIDE_MAX_MOUNTED_CODE_VIEWS);
    expect(codeViewProps.every((props) => (props.files as DiffFile[]).length === 1)).toBe(true);
    expect(codeViewProps.every((props) => props.fileSummaries === undefined)).toBe(true);
    expect(host.textContent).toContain('Summary for src/file-0.ts');
  });

  test.skipIf(!hasDom)('file chip click routes through the reveal callback', async () => {
    const revealed: string[] = [];
    const file = makeFile();
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(makeState({ files: [file] }), { onRequestReveal: (path) => revealed.push(path) }));
    });

    const chip = host.querySelector<HTMLButtonElement>('button[title^="src/payments/localize.ts"]');
    expect(chip).not.toBeNull();
    await act(async () => chip!.click());
    expect(revealed).toEqual(['src/payments/localize.ts']);
  });

  test.skipIf(!hasDom)('a reveal expands a reviewed chapter and force-targets its file CodeView', async () => {
    const file = makeFile();
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(makeState({ files: [file] }), { reviewed: true }));
    });
    expect(host.querySelector('[data-guide-file-shell]')).toBeNull();

    const revealTarget = { filePath: file.path, token: 1 };
    await act(async () => {
      root!.render(renderCard(makeState({ files: [file] }), { reviewed: true, revealTarget }));
    });

    expect(host.querySelector('[data-guide-file-shell]')).not.toBeNull();
    const targeted = codeViewProps.find((props) => props.fileScrollTarget != null);
    expect(targeted?.fileScrollTarget).toEqual(revealTarget);
  });

  test.skipIf(!hasDom)('keeps collapse state in the lightweight shell across CodeView renders', async () => {
    const file = makeFile();
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(makeState({ files: [file] })));
    });

    const latest = codeViewProps[codeViewProps.length - 1];
    await act(async () => {
      (latest.onFileCollapsedChange as (path: string, collapsed: boolean) => void)(file.path, true);
    });
    const shell = host.querySelector<HTMLElement>('[data-guide-code-view-mounted]');
    expect(shell?.style.height).toBe('49px');

    const rerendered = codeViewProps[codeViewProps.length - 1];
    expect(rerendered.mountCollapsed).toBe(true);
    expect(rerendered.defaultCollapsed).toBeUndefined();
  });

  test.skipIf(!hasDom)('keeps the one-file array stable across guide rerenders', async () => {
    const files = [makeFile()];
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(makeState({ files }), { files }));
    });
    const firstFileList = codeViewProps[codeViewProps.length - 1].files;

    await act(async () => {
      root!.render(renderCard(makeState({ files, viewedFiles: new Set() }), { files }));
    });

    expect(codeViewProps[codeViewProps.length - 1].files).toBe(firstFileList);
  });

  test.skipIf(!hasDom)('passes AI marker state and enables outer scroll chaining', async () => {
    const file = makeFile();
    const aiMessage = {
      question: {
        id: 'question-1',
        prompt: 'Why did this change?',
        filePath: file.path,
        lineStart: 1,
        lineEnd: 1,
        side: 'new' as const,
        createdAt: 1,
      },
      response: {
        questionId: 'question-1',
        text: 'Because localization moved here.',
        isStreaming: false,
        createdAt: 2,
      },
    };
    const clicked: string[] = [];
    const onClickAIMarker = (questionId: string) => clicked.push(questionId);
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(makeState({ files: [file], aiMessages: [aiMessage], onClickAIMarker })));
    });

    const latest = codeViewProps[codeViewProps.length - 1];
    expect(latest.aiMessages).toEqual([aiMessage]);
    expect(latest.allowScrollChaining).toBe(true);
    (latest.onClickAIMarker as (questionId: string) => void)('question-1');
    expect(clicked).toEqual(['question-1']);
  });

  test.skipIf(!hasDom)('passes keyboard ownership only to the focused file CodeView', async () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')];
    const twoFileSection: GuideSection = {
      title: 'Two files',
      overview: '',
      diffs: files.map((file) => ({ file: file.path })),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(makeState({ files }), {
        section: twoFileSection,
        files,
        focusedFile: 'b.ts',
      }));
    });

    const latestByFile = new Map<string, Record<string, unknown>>();
    for (const props of codeViewProps) {
      const path = (props.files as DiffFile[])[0]?.path;
      if (path) latestByFile.set(path, props);
    }
    expect(latestByFile.get('a.ts')?.isActive).toBe(false);
    expect(latestByFile.get('b.ts')?.isActive).toBe(true);
  });
});
