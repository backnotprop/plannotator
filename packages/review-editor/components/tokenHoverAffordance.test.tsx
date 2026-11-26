/**
 * The hover underline and hand cursor (`pn-token-hover`) promise "a card opens
 * here". Both diff views painted them on every token Pierre reports, so a
 * whole comment line or a `;` looked clickable and never opened anything. A
 * view now paints them only when the host's hover handler accepts the token.
 *
 * The host here answers with the same rule the review app uses
 * (buildTokenHoverRequest, which declines anything that is not a symbol), and
 * the token spans are built the way Pierre's token transformer stamps them
 * (`data-char`, one span per token).
 *
 * DOM-gated (DOM_TESTS=1), listed in tests/dom-test-list.txt.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffTokenEventBaseProps } from '@pierre/diffs';
import type { DiffFile } from '../types';
import { buildTokenHoverRequest } from '../utils/buildCodeNavRequest';

type TokenEnter = (props: DiffTokenEventBaseProps, event: PointerEvent, context?: unknown) => void;
interface CapturedOptions {
  onTokenEnter?: TokenEnter;
  onTokenLeave?: (props: DiffTokenEventBaseProps, event: PointerEvent, context?: unknown) => void;
}

let fileDiffOptions: CapturedOptions | null = null;
let codeViewOptions: CapturedOptions | null = null;
let codeViewItems: Array<{ id: string }> = [];

// Spread-captured before the mock replaces the module record (see
// DiffViewer.compactTouchSelection.test.tsx for why).
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
  FileDiff: function StandInFileDiff(props: { options: CapturedOptions }) {
    fileDiffOptions = props.options;
    return null;
  },
  CodeView: React.forwardRef(function StandInCodeView(
    props: { initialItems?: Array<{ id: string }>; options: CapturedOptions; className?: string },
    ref: React.ForwardedRef<unknown>,
  ) {
    codeViewOptions = props.options;
    codeViewItems = props.initialItems ?? [];
    const container = useRef<HTMLDivElement | null>(null);
    useImperativeHandle(ref, () => ({
      getItem: () => undefined,
      updateItem: () => true,
      scrollTo: () => {},
      setSelectedLines: () => {},
      getSelectedLines: () => null,
      clearSelectedLines: () => {},
      getInstance: () => ({
        getContainerElement: () => container.current,
        getRenderedItems: () => [],
        getScrollTop: () => 0,
        getTopForItem: () => 0,
        getScrollHeight: () => 0,
        getHeight: () => 0,
        scrollTo: () => {},
      }),
    }));
    return <div ref={container} className={props.className} />;
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

const { DiffViewer } = await import('./DiffViewer');
const { AllFilesCodeView } = await import('./AllFilesCodeView');

const hasDom = typeof document !== 'undefined';

const PATCH = [
  'diff --git a/run.ts b/run.ts',
  'index 0000000..1111111 100644',
  '--- a/run.ts',
  '+++ b/run.ts',
  '@@ -1,1 +1,3 @@',
  ' export interface Step {',
  '+  /** Traces each step. */',
  '+  tracing?: StepTracing;',
  '',
].join('\n');

const FILES: DiffFile[] = [{ path: 'run.ts', patch: PATCH, additions: 2, deletions: 0, status: 'modified' }];

/** The review app's rule: a card can open only for a symbol. */
const host = (props: DiffTokenEventBaseProps, filePath: string): boolean =>
  buildTokenHoverRequest(props, filePath) != null;

/** One rendered line, one span per token, stamped the way Pierre stamps them. */
function line(tokens: string[]): HTMLElement[] {
  const row = document.createElement('div');
  document.body.appendChild(row);
  let column = 0;
  return tokens.map((text) => {
    const span = document.createElement('span');
    span.setAttribute('data-char', String(column));
    span.textContent = text;
    row.appendChild(span);
    column += text.length;
    return span;
  });
}

function tokenProps(tokenElement: HTMLElement): DiffTokenEventBaseProps {
  return {
    tokenElement,
    tokenText: tokenElement.textContent ?? '',
    lineNumber: 3,
    lineCharStart: Number(tokenElement.getAttribute('data-char')),
    lineCharEnd: Number(tokenElement.getAttribute('data-char')) + (tokenElement.textContent ?? '').length,
    side: 'additions',
  } as DiffTokenEventBaseProps;
}

const pointer = () => new PointerEvent('pointermove');

describe.if(hasDom)('the hover affordance marks only tokens a card can open for', () => {
  let root: Root | null = null;
  let mountPoint: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  async function render(node: React.ReactElement) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ oldContent: null, newContent: null }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    mountPoint = document.createElement('div');
    document.body.appendChild(mountPoint);
    root = createRoot(mountPoint);
    await act(async () => {
      root!.render(node);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    mountPoint?.remove();
    mountPoint = null;
    fileDiffOptions = null;
    codeViewOptions = null;
    codeViewItems = [];
    globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  afterAll(() => {
    mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
  });

  function expectOnlySymbolsMarked(enter: (element: HTMLElement) => void) {
    const [comment] = line(['  /** Traces each step. */']);
    const [, field, , symbol, semicolon] = line(['  ', 'tracing', '?: ', 'StepTracing', ';']);

    for (const element of [comment, field, symbol, semicolon]) enter(element);

    expect(comment.classList.contains('pn-token-hover')).toBe(false);
    expect(semicolon.classList.contains('pn-token-hover')).toBe(false);
    expect(symbol.classList.contains('pn-token-hover')).toBe(true);
    expect(field.classList.contains('pn-token-hover')).toBe(true);
  }

  test('single-file diff', async () => {
    await render(
      <DiffViewer
        patch={PATCH}
        filePath="run.ts"
        diffStyle="unified"
        annotations={[]}
        selectedAnnotationId={null}
        scrollTargetAnnotation={null}
        pendingSelection={null}
        onLineSelection={() => {}}
        onAddAnnotation={() => {}}
        onAddFileComment={() => {}}
        onEditAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        onTokenHoverEnter={host}
        onTokenHoverLeave={() => {}}
      />,
    );
    const enter = fileDiffOptions?.onTokenEnter;
    if (!enter) throw new Error('DiffViewer wired no token enter');
    expectOnlySymbolsMarked((element) => enter(tokenProps(element), pointer()));
  });

  test('all files', async () => {
    await render(
      <AllFilesCodeView
        files={FILES}
        diffStyle="unified"
        annotations={[]}
        selectedAnnotationId={null}
        scrollTargetAnnotation={null}
        pendingSelection={null}
        isActive
        onLineSelection={() => {}}
        onAddAnnotationForFile={() => {}}
        onEditAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        onTokenHoverEnter={host}
        onTokenHoverLeave={() => {}}
      />,
    );
    const enter = codeViewOptions?.onTokenEnter;
    const item = codeViewItems.find((candidate) => (candidate as { type?: string }).type === 'diff');
    if (!enter || !item) throw new Error('AllFilesCodeView wired no token enter or diff item');
    expectOnlySymbolsMarked((element) => enter(tokenProps(element), pointer(), { item }));
  });
});
