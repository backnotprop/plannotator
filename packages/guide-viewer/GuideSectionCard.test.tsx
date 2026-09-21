import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GuideSection } from '@plannotator/core/guide';
import type { DiffFile } from './types';
import { GuideHostProvider, type GuideHostValue } from './host';
import { GuideViewportProvider } from './GuideViewportManager';

let codeViewProps: Record<string, unknown>[] = [];
/** Stand-in diff renderer: records the props the guide chain hands it. */
function FakeDiffRenderer(props: Record<string, unknown>) {
  codeViewProps.push(props);
  const files = props.files as DiffFile[];
  return <div data-testid="file-code-view" data-file={files[0]?.path} />;
}
import { GuideSectionCard } from './GuideSectionCard';

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
  codeViewProps = [];
  if (hasDom) document.body.innerHTML = '';
});

function renderCard(
  state: GuideHostValue<Record<string, unknown>>,
  props: Partial<React.ComponentProps<typeof GuideSectionCard>> = {},
) {
  const file = makeFile();
  return (
    <GuideHostProvider value={state}>
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
    </GuideHostProvider>
  );
}

describe('GuideSectionCard', () => {
  test.skipIf(!hasDom)('renders per-file summaries in the card and never delegates them to the renderer', async () => {
    // Windowing at scale is covered by GuideView.test.tsx; this guards only what the card owns.
    const files = Array.from({ length: 3 }, (_, index) => makeFile(`src/file-${index}.ts`));
    const summarized: GuideSection = {
      title: 'Summarized chapter',
      overview: '',
      diffs: files.map((file) => ({ file: file.path, summary: `Summary for ${file.path}` })),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(makeState({ files }), { section: summarized, files, focusedFile: files[0].path }));
    });

    expect(host.querySelectorAll('[data-guide-file-shell]')).toHaveLength(3);
    expect(codeViewProps.length).toBeGreaterThan(0);
    expect(codeViewProps.every((props) => props.fileSummaries === undefined)).toBe(true);
    expect(host.textContent).toContain('Summary for src/file-0.ts');
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

  test.skipIf(!hasDom)('forwards host renderer props and enables outer scroll chaining', async () => {
    const file = makeFile();
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      // Sentinel: the chain must hand getDiffRendererProps() output to the renderer untouched.
      root.render(renderCard(makeState({ files: [file], hostSentinel: 'sentinel-42' })));
    });

    const latest = codeViewProps[codeViewProps.length - 1];
    expect(latest.hostSentinel).toBe('sentinel-42');
    expect(latest.allowScrollChaining).toBe(true);
  });
});
