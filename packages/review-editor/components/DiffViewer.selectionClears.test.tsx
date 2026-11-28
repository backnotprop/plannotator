/**
 * After a line comment is added or cancelled, Pierre must drop the range it was
 * showing. Pierre's React FileDiff applies `selectedLines` only when it is
 * defined, and keeps its last range otherwise; while it holds a range, its
 * gutter "+" stays on that range's last line whatever line the pointer is on,
 * and the next press on the "+" starts from that range (a drag from line 19
 * gave "Lines 13-21").
 *
 * The stand-in FileDiff below keeps a range by that same rule, so each test
 * reads what Pierre would still be holding.
 *
 * DOM-gated (DOM_TESTS=1), listed in tests/dom-test-list.txt.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation, SelectedLineRange } from '@plannotator/ui/types';

interface CapturedFileDiffProps {
  selectedLines?: SelectedLineRange | null;
}

/** The range Pierre holds: set from `selectedLines` only when it is defined. */
let pierreRange: SelectedLineRange | null = null;
/** The `selectedLines` of the last render (`undefined`: Pierre's own selection). */
let lastSelectedLines: SelectedLineRange | null | undefined;

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

mock.module('@pierre/diffs/react', () => ({
  ...realPierreDiffsReact,
  FileDiff: function MockFileDiff({ selectedLines }: CapturedFileDiffProps) {
    lastSelectedLines = selectedLines;
    useLayoutEffect(() => {
      if (selectedLines !== undefined) pierreRange = selectedLines;
    });
    return null;
  },
}));

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost() {
    return null;
  }),
}));

const { DiffViewer } = await import('./DiffViewer');

const hasDom = typeof document !== 'undefined';

const PATCH = [
  'diff --git a/schedule.ts b/schedule.ts',
  'index 0000000..1111111 100644',
  '--- a/schedule.ts',
  '+++ b/schedule.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 1;',
  '+const b = 2;',
  ' const c = 3;',
  '',
].join('\n');

const NEW_LINE: SelectedLineRange = { start: 2, end: 2, side: 'additions' };
const OLD_LINE: SelectedLineRange = { start: 2, end: 2, side: 'deletions' };

const COMMENT: CodeAnnotation = {
  id: 'c1',
  type: 'comment',
  scope: 'line',
  filePath: 'schedule.ts',
  lineStart: 2,
  lineEnd: 3,
  side: 'new',
  text: 'Charlie Dunn: check this',
  createdAt: 1,
};

let setPending: (range: SelectedLineRange | null) => void = () => {};
let setSelectedComment: (id: string | null) => void = () => {};

/** Stands in for App: owns the composer's range and the selected comment. */
function Harness() {
  const [pendingSelection, setPendingSelection] = useState<SelectedLineRange | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  setPending = setPendingSelection;
  setSelectedComment = setSelectedAnnotationId;
  return (
    <DiffViewer
      patch={PATCH}
      filePath="schedule.ts"
      diffStyle="split"
      annotations={[COMMENT]}
      selectedAnnotationId={selectedAnnotationId}
      scrollTargetAnnotation={null}
      pendingSelection={pendingSelection}
      onLineSelection={setPendingSelection}
      onAddAnnotation={() => {}}
      onAddFileComment={() => {}}
      onEditAnnotation={() => {}}
      onSelectAnnotation={() => {}}
      onDeleteAnnotation={() => {}}
    />
  );
}

describe.if(hasDom)('DiffViewer hands Pierre a cleared range (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  async function mount() {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ oldContent: null, newContent: null }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness />);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    pierreRange = null;
    lastSelectedLines = undefined;
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
  });

  for (const [side, range] of [['new', NEW_LINE], ['old', OLD_LINE]] as const) {
    test(`closing the composer on the ${side} side clears Pierre's range`, async () => {
      await mount();
      await act(async () => setPending(range));
      expect(pierreRange).toEqual(range);

      // Add, Cancel and Escape all end here: App drops the composer's range.
      await act(async () => setPending(null));

      expect(pierreRange).toBeNull();
      // And Pierre owns the selection again, so a fresh drag paints as it goes.
      expect(lastSelectedLines).toBeUndefined();
    });
  }

  test('the next comment after a cancelled one reaches Pierre as its own range', async () => {
    await mount();
    await act(async () => setPending(NEW_LINE));
    await act(async () => setPending(null));
    await act(async () => setPending(OLD_LINE));

    expect(pierreRange).toEqual(OLD_LINE);
  });

  test('deselecting a comment clears the lines it highlighted', async () => {
    await mount();
    await act(async () => setSelectedComment('c1'));
    expect(pierreRange).toEqual({ start: 2, end: 3, side: 'additions' });

    await act(async () => setSelectedComment(null));

    expect(pierreRange).toBeNull();
    expect(lastSelectedLines).toBeUndefined();
  });
});
