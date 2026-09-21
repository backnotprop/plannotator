/**
 * Compact touch keeps a dragged line range on screen instead of opening the
 * composer, so the range has to survive as a PAINTED selection until the
 * reviewer taps Pierre's gutter comment button.
 *
 * The failures guarded here:
 *   - a drag on compact touch force-opening the composer again (the incumbent
 *     desktop behaviour, which is what made mobile range selection unusable);
 *   - the preserved range never reaching Pierre, so nothing is highlighted;
 *   - a SECOND drag not repainting. A non-null `selectedLines` puts Pierre in
 *     controlled-selection mode, where `InteractionManager.updateSelection`
 *     only records a proposal and leaves painting to the host — so without
 *     `onLineSelectionChange` flowing back into app state the old highlight
 *     stays put and the finger is untracked until release;
 *   - a cleared selection being swallowed by the preserve branch and leaving an
 *     open composer behind;
 *   - any of it leaking onto desktop, which must keep handing every completed
 *     drag straight to the toolbar host.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SelectedLineRange } from '@plannotator/ui/types';

interface CapturedFileDiffProps {
  selectedLines?: SelectedLineRange;
  options: {
    onLineSelectionEnd?: (range: SelectedLineRange | null) => void;
    onLineSelectionChange?: (range: SelectedLineRange | null) => void;
    onGutterUtilityClick?: (range: SelectedLineRange) => void;
  };
}

let lastFileDiffProps: CapturedFileDiffProps | null = null;
let toolbarSelections: Array<SelectedLineRange | null> = [];

// Spread-captured before the mock replaces the module record — a bare namespace
// handle would be a live view of the record `mock.module` rewrites, so the
// afterAll restore would silently re-install this file's stub as itself. Same
// idiom (and the same reason) as AllFilesCodeView.lifecycle.test.tsx.
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

// Only FileDiff is replaced; everything else the review-editor graph imports
// from this specifier stays real.
mock.module('@pierre/diffs/react', () => ({
  ...realPierreDiffsReact,
  FileDiff: function MockFileDiff(props: CapturedFileDiffProps) {
    lastFileDiffProps = props;
    return null;
  },
}));

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost(_props, ref) {
    useImperativeHandle(ref, () => ({
      handleLineSelectionEnd: (range: SelectedLineRange | null) => {
        toolbarSelections.push(range);
      },
      openLineAnnotation: () => {},
      handleTokenClick: () => {},
      startEdit: () => {},
    }));
    return null;
  }),
}));

const { DiffViewer } = await import('./DiffViewer');

const hasDom = typeof document !== 'undefined';

const PATCH = [
  'diff --git a/calc.ts b/calc.ts',
  'index 0000000..1111111 100644',
  '--- a/calc.ts',
  '+++ b/calc.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 1;',
  '+const b = 2;',
  ' const c = 3;',
  '',
].join('\n');

const FIRST_DRAG: SelectedLineRange = { start: 2, end: 3, side: 'additions' };
const SECOND_DRAG: SelectedLineRange = { start: 1, end: 3, side: 'additions' };

/** Stands in for App: mirrors published selections back down as
 *  `pendingSelection`, which is the loop the repaint depends on. */
function Harness({ compactTouchLayout, onSelection }: {
  compactTouchLayout: boolean;
  onSelection: (range: SelectedLineRange | null) => void;
}) {
  const [pendingSelection, setPendingSelection] = useState<SelectedLineRange | null>(null);
  const handleLineSelection = useCallback((range: SelectedLineRange | null) => {
    onSelection(range);
    setPendingSelection(range);
  }, [onSelection]);
  return (
    <DiffViewer
      patch={PATCH}
      filePath="calc.ts"
      diffStyle="unified"
      annotations={[]}
      selectedAnnotationId={null}
      scrollTargetAnnotation={null}
      pendingSelection={pendingSelection}
      compactTouchLayout={compactTouchLayout}
      onLineSelection={handleLineSelection}
      onAddAnnotation={() => {}}
      onAddFileComment={() => {}}
      onEditAnnotation={() => {}}
      onSelectAnnotation={() => {}}
      onDeleteAnnotation={() => {}}
    />
  );
}

describe.if(hasDom)('DiffViewer compact-touch line selection (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  async function mount(compactTouchLayout: boolean) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ oldContent: null, newContent: null }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const selections: Array<SelectedLineRange | null> = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <Harness
          compactTouchLayout={compactTouchLayout}
          onSelection={(range) => selections.push(range)}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    return selections;
  }

  function pierre() {
    if (lastFileDiffProps == null) throw new Error('FileDiff never rendered');
    return lastFileDiffProps;
  }

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    lastFileDiffProps = null;
    toolbarSelections = [];
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
  });

  test('a drag preserves the range instead of opening the composer', async () => {
    const selections = await mount(true);

    await act(async () => {
      pierre().options.onLineSelectionEnd?.(FIRST_DRAG);
    });

    expect(toolbarSelections).toEqual([]);
    expect(selections.at(-1)).toEqual(FIRST_DRAG);
    // The range has to come back down as a painted selection, not just be
    // published: this prop is the only thing Pierre highlights from.
    expect(pierre().selectedLines).toEqual(FIRST_DRAG);
  });

  test('a second drag repaints while the first range is still preserved', async () => {
    await mount(true);

    await act(async () => {
      pierre().options.onLineSelectionEnd?.(FIRST_DRAG);
    });
    expect(pierre().selectedLines).toEqual(FIRST_DRAG);

    // Pierre is controlled now, so in-flight deltas of the next drag arrive on
    // onLineSelectionChange and repaint nothing on their own.
    const onChange = pierre().options.onLineSelectionChange;
    expect(onChange).toBeDefined();
    await act(async () => {
      onChange?.(SECOND_DRAG);
    });

    expect(pierre().selectedLines).toEqual(SECOND_DRAG);
    expect(toolbarSelections).toEqual([]);
  });

  test('the gutter comment action opens the composer for the preserved range', async () => {
    await mount(true);

    await act(async () => {
      pierre().options.onLineSelectionEnd?.(FIRST_DRAG);
      pierre().options.onGutterUtilityClick?.(FIRST_DRAG);
    });

    expect(toolbarSelections).toEqual([FIRST_DRAG]);
  });

  test('a cleared selection still reaches the toolbar host so an open composer closes', async () => {
    await mount(true);

    await act(async () => {
      pierre().options.onLineSelectionEnd?.(FIRST_DRAG);
    });
    await act(async () => {
      pierre().options.onLineSelectionEnd?.(null);
    });

    // The real host clears its toolbar state (and republishes the null
    // selection) from here; swallowing the null in the preserve branch would
    // leave the composer open over a range that no longer exists.
    expect(toolbarSelections).toEqual([null]);
  });

  test('desktop keeps handing completed drags straight to the composer', async () => {
    await mount(false);

    await act(async () => {
      pierre().options.onLineSelectionEnd?.(FIRST_DRAG);
    });

    expect(toolbarSelections).toEqual([FIRST_DRAG]);
    // Desktop never enters the preserved-range state, so it must not even carry
    // the controlled-repaint handler.
    expect('onLineSelectionChange' in pierre().options).toBe(false);
  });
});
