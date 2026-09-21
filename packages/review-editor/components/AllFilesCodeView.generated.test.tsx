/**
 * DOM-gated tests (DOM_TESTS=1) for generated-file default collapse (#1317).
 * Registered in .github/workflows/test.yml's "Run UI seam-contract + DOM
 * tests" step.
 *
 * The behaviors under guard:
 *  - files in `generatedFiles` SEED their CodeView item collapsed (Pierre
 *    renders a collapsed item as its header bar only), other files don't;
 *  - collapse is a VIEW state, never a data filter: a collapsed generated
 *    item still carries its full fileDiff and seeded line annotations;
 *  - the header chevron expands in place (no CodeView remount) and reports
 *    the expansion to the owner so it can outlive remounts;
 *  - a file listed in `expandedGeneratedFiles` seeds expanded — the
 *    remount-survival half of the session contract;
 *  - a collapsed generated card shows the explicit placeholder strip, whose
 *    click expands through the SAME collapse-report funnel as the chevron;
 *  - search-match navigation expands through the funnel too, so a
 *    search-driven expansion survives a diff-switch re-seed.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffFile } from '../types';

let codeViewMounts = 0;
let lastCodeViewProps: Record<string, unknown> | null = null;

// Same capture/restore idiom as AllFilesCodeView.lifecycle.test.tsx — the
// SPREAD is load-bearing (mock.module rewrites the live module record).
const realPierreDiffs = { ...(await import('@pierre/diffs')) };
const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  buildLineBgOverrides: () => '',
  resolveSyntaxTheme: realResolveSyntaxTheme,
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

mock.module('@pierre/diffs', () => ({
  getSingularPatch: (patch: string) => ({
    name: /diff --git a\/(\S+)/.exec(patch)?.[1] ?? 'file.ts',
    type: 'change',
    hunks: [],
    splitLineCount: 1,
    unifiedLineCount: 1,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  }),
  processFile: () => null,
}));

mock.module('@pierre/diffs/react', () => ({
  CodeView: React.forwardRef(function MockCodeView(
    props: {
      initialItems?: Array<{ id: string }>;
      className?: string;
      containerRef?: React.Ref<HTMLDivElement>;
    },
    ref: React.ForwardedRef<unknown>,
  ) {
    const itemsRef = useRef(new Map((props.initialItems ?? []).map((item) => [item.id, item])));
    lastCodeViewProps = props as unknown as Record<string, unknown>;
    useEffect(() => {
      codeViewMounts += 1;
    }, []);
    useImperativeHandle(ref, () => ({
      addItems: () => {},
      getItem: (id: string) => itemsRef.current.get(id),
      updateItem: (item: { id: string }) => {
        itemsRef.current.set(item.id, item);
        return true;
      },
      updateItemId: () => true,
      scrollTo: () => {},
      setSelectedLines: () => {},
      getSelectedLines: () => null,
      clearSelectedLines: () => {},
      getInstance: () => ({
        getRenderedItems: () => [],
        getScrollTop: () => 0,
        getScrollHeight: () => 0,
        getHeight: () => 0,
        getTopForItem: () => 0,
        scrollTo: () => {},
      }),
    }));
    return <div ref={props.containerRef} className={props.className} />;
  }),
  EditProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useStableCallback: <T extends (...args: never[]) => unknown>(callback: T): T => {
    const callbackRef = useRef(callback);
    callbackRef.current = callback;
    return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
  },
}));

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost(_props, ref) {
    useImperativeHandle(ref, () => ({
      handleLineSelectionEnd: () => {},
      openLineAnnotation: () => {},
      handleTokenClick: () => {},
      startEdit: () => {},
    }));
    return null;
  }),
}));

const { AllFilesCodeView } = await import('./AllFilesCodeView');

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let headerRoot: Root | null = null;
let headerHost: HTMLElement | null = null;

function makeFile(path: string): DiffFile {
  return {
    path,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    additions: 1,
    deletions: 1,
    status: 'modified',
  };
}

const generatedFile = makeFile('gen/schema.sql');
const normalFile = makeFile('src/app.ts');

type Props = Partial<React.ComponentProps<typeof AllFilesCodeView>>;

async function render(overrides: Props = {}) {
  if (!host) {
    host = document.createElement('div');
    host.style.height = '400px';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <AllFilesCodeView
        files={[generatedFile, normalFile]}
        diffStyle="unified"
        annotations={[]}
        selectedAnnotationId={null}
        scrollTargetAnnotation={null}
        pendingSelection={null}
        onLineSelection={() => {}}
        onAddAnnotationForFile={() => {}}
        onEditAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        generatedFiles={new Set(['gen/schema.sql'])}
        {...overrides}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

function seededItems(): Array<{ id: string; collapsed?: boolean; fileDiff?: unknown; annotations?: unknown[] }> {
  return (lastCodeViewProps?.initialItems ?? []) as Array<{
    id: string;
    collapsed?: boolean;
    fileDiff?: unknown;
    annotations?: unknown[];
  }>;
}

async function renderHeaderFor(itemId: string): Promise<HTMLElement> {
  const renderCustomHeader = lastCodeViewProps?.renderCustomHeader as
    | ((item: { id: string }) => React.ReactNode)
    | undefined;
  expect(renderCustomHeader).toBeDefined();
  const item = seededItems().find((i) => i.id === itemId);
  expect(item).toBeDefined();
  if (!headerHost) {
    headerHost = document.createElement('div');
    document.body.appendChild(headerHost);
    headerRoot = createRoot(headerHost);
  }
  await act(async () => {
    headerRoot!.render(<>{renderCustomHeader!(item as { id: string })}</>);
  });
  return headerHost;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  if (headerRoot) await act(async () => headerRoot?.unmount());
  root = null;
  headerRoot = null;
  host?.remove();
  headerHost?.remove();
  host = null;
  headerHost = null;
  codeViewMounts = 0;
  lastCodeViewProps = null;
});

afterAll(() => {
  mock.module('@pierre/diffs', () => realPierreDiffs);
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe.if(hasDom)('generated-file default collapse (#1317)', () => {
  test('generated files seed collapsed with their diff data and annotations intact; others seed expanded', async () => {
    const annotation = {
      id: 'a1',
      type: 'comment',
      filePath: 'gen/schema.sql',
      lineStart: 1,
      lineEnd: 1,
      side: 'new',
      text: 'why is this regenerated?',
      createdAt: 1,
    } as CodeAnnotation;
    await render({ annotations: [annotation] });

    const gen = seededItems().find((i) => i.id === 'gen/schema.sql');
    const normal = seededItems().find((i) => i.id === 'src/app.ts');
    expect(gen?.collapsed).toBe(true);
    expect(normal?.collapsed).toBeUndefined();
    // Collapse is a view seed, never a data filter: the collapsed item still
    // carries the parsed diff and the projected line annotation.
    expect(gen?.fileDiff).toBeDefined();
    expect(gen?.annotations).toHaveLength(1);
  });

  test('the header chevron expands in place, reports to the owner, and shows the generated tag', async () => {
    const reports: Array<[string, boolean]> = [];
    await render({
      onGeneratedFileCollapsedChange: (path, collapsed) => reports.push([path, collapsed]),
    });
    expect(codeViewMounts).toBe(1);

    const collapsedHeader = await renderHeaderFor('gen/schema.sql');
    expect(collapsedHeader.querySelector('[data-pn-generated-badge]')).not.toBeNull();
    const chevron = collapsedHeader.querySelector<HTMLButtonElement>('button[title="Expand diff"]');
    expect(chevron).not.toBeNull();

    await act(async () => chevron!.click());
    expect(reports).toEqual([['gen/schema.sql', false]]);
    // Expansion is live item state — no CodeView remount (which would lose
    // scroll/selection state).
    expect(codeViewMounts).toBe(1);

    // The header re-render reflects the expanded item.
    const expandedHeader = await renderHeaderFor('gen/schema.sql');
    expect(expandedHeader.querySelector('button[title="Collapse diff"]')).not.toBeNull();

    // A normal file's header carries no generated tag.
    const normalHeader = await renderHeaderFor('src/app.ts');
    expect(normalHeader.querySelector('[data-pn-generated-badge]')).toBeNull();
  });

  test('a file the user already expanded seeds expanded (remount survival)', async () => {
    await render({ expandedGeneratedFiles: new Set(['gen/schema.sql']) });
    const gen = seededItems().find((i) => i.id === 'gen/schema.sql');
    expect(gen?.collapsed).toBeUndefined();
  });

  test('the collapsed card shows the placeholder strip, which expands through the funnel', async () => {
    const reports: Array<[string, boolean]> = [];
    await render({
      onGeneratedFileCollapsedChange: (path, collapsed) => reports.push([path, collapsed]),
    });

    const collapsedHeader = await renderHeaderFor('gen/schema.sql');
    const strip = collapsedHeader.querySelector<HTMLButtonElement>('[data-pn-generated-collapsed-notice]');
    expect(strip).not.toBeNull();
    // The fold is explicit, not a failed render: the strip carries the file's
    // +/- counts (server-derived data, so assert the data, not the prose).
    expect(strip!.textContent).toContain('+1');
    expect(strip!.textContent).toContain('-1');

    await act(async () => strip!.click());
    // Same funnel as the chevron: the expansion reports to the owner and the
    // live item expands in place (no CodeView remount).
    expect(reports).toEqual([['gen/schema.sql', false]]);
    expect(seededItems().find((i) => i.id === 'gen/schema.sql')?.collapsed).toBe(false);
    expect(codeViewMounts).toBe(1);

    // The re-rendered expanded card drops the strip.
    const expandedHeader = await renderHeaderFor('gen/schema.sql');
    expect(expandedHeader.querySelector('[data-pn-generated-collapsed-notice]')).toBeNull();
  });

  test('search-match navigation expands through the funnel, surviving a re-seed round-trip', async () => {
    const reports: Array<[string, boolean]> = [];
    const onChange = (path: string, collapsed: boolean) => reports.push([path, collapsed]);
    await render({ onGeneratedFileCollapsedChange: onChange });
    expect(seededItems().find((i) => i.id === 'gen/schema.sql')?.collapsed).toBe(true);

    // Search navigation lands in the collapsed generated file.
    await render({
      onGeneratedFileCollapsedChange: onChange,
      activeSearchMatch: {
        id: 'm1',
        filePath: 'gen/schema.sql',
        side: 'addition',
        lineNumber: 1,
        text: 'new',
        matchStart: 0,
        matchEnd: 3,
        snippet: 'new',
      },
    });
    // The expansion reached the owner — before the F1 fix this site mutated
    // item.collapsed directly and the report was silently dropped, so the
    // expansion died on the next diff switch.
    expect(reports).toEqual([['gen/schema.sql', false]]);

    // Round trip: the owner feeds the reported expansion back while a diff
    // switch re-seeds items (new files identity + snapshot id) — the file the
    // search opened stays open.
    const expanded = new Set(reports.filter(([, collapsed]) => !collapsed).map(([path]) => path));
    await render({
      files: [makeFile('gen/schema.sql'), makeFile('src/app.ts')],
      reviewSnapshotId: 'post-switch',
      generatedFiles: new Set(['gen/schema.sql']),
      expandedGeneratedFiles: expanded,
    });
    expect(seededItems().find((i) => i.id === 'gen/schema.sql')?.collapsed).toBeUndefined();
  });
});
