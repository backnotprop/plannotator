/**
 * A draft restore of a selection that ran from a GitHub alert's icon through
 * its title into its body.
 *
 * The title row carries a visually hidden "<Type>: " span (`annotation-exclude`,
 * #1511). Creation already snaps a live range off it, but the DRAFT path is
 * different: web-highlighter's stored `textOffset` counts every text node under
 * the recorded parent — the hidden word included — and its resolver puts a
 * boundary that lands exactly at one text node's end back onto THAT node. The
 * restore therefore resumed inside the hidden span, where painting never
 * enters, so only the trailing run was painted, the content verification
 * rejected it, and the text search could not bridge title into body either:
 * the reviewer reloaded and their comment had no highlight at all.
 *
 * Fixtures are the real browser shapes: the quote is what `Selection.toString()`
 * returns (no "Tip: ", a blank line between the two blocks) and the metas are
 * computed the way `getDomMeta` computes them, off the rendered DOM.
 *
 * The document deliberately repeats the alert verbatim, and the draft points at
 * the SECOND one. The text-search rescue can only ever find the first, so a
 * restore that still falls back to it lands the reviewer's comment on the wrong
 * alert — which is what makes this a test of the stored-position path rather
 * than of the rescue behind it.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in web-highlighter, whose UMD bundle reads `window` at
// module-eval time; import lazily (same pattern as Viewer.crossBlockRestore).
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

const ALERT = [
  '> [!TIP]',
  '> **Browser quirks**',
  '>',
  '> Safari clamps the selection.',
];

const MARKDOWN = [
  'Lead paragraph before the alert.',
  '',
  ...ALERT,
  '',
  'Middle paragraph between the two alerts.',
  '',
  ...ALERT,
  '',
  'Trailing paragraph after the alert.',
].join('\n');

/** What every real browser puts between two block elements in a selection
 *  string; happy-dom's `innerText` is not layout-aware. */
const BLOCK_BREAK = '\n\n';

let root: Root | null = null;
let host: HTMLElement | null = null;

interface ViewerHandle {
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

async function mount(): Promise<React.RefObject<ViewerHandle | null>> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const ref = React.createRef<ViewerHandle>();
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        ref={ref as never}
        blocks={parseMarkdownToBlocks(MARKDOWN)}
        markdown={MARKDOWN}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        taterMode={false}
        disableCodePathValidation
      />,
    );
  });
  return ref;
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

const articleRoot = (): HTMLElement => {
  const article = document.querySelector<HTMLElement>('article[data-print-region="article"]');
  if (!article) throw new Error('Viewer did not render its annotation container');
  return article;
};

/** The two rendered alerts, in document order. */
const alerts = (): HTMLElement[] => {
  const found = Array.from(articleRoot().querySelectorAll<HTMLElement>('[data-block-type="alert"]'));
  if (found.length !== 2) throw new Error(`Fixture no longer renders two alerts (got ${found.length})`);
  return found;
};

/** The text node under `scope` matching `selector` that holds `needle`. */
const textNodeWith = (scope: HTMLElement, selector: string, needle: string): Text => {
  const holder = Array.from(scope.querySelectorAll(selector))
    .find((el) => (el.textContent ?? '').includes(needle));
  if (!holder) throw new Error(`Fixture no longer renders "${needle}" under ${selector}`);
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.textContent ?? '').includes(needle)) return node as Text;
  }
  throw new Error(`Fixture no longer holds "${needle}" in one text node`);
};

/**
 * web-highlighter's own `getDomMeta`: the text node's parent element, that
 * element's index among all elements of its tag under the container, and the
 * text length preceding the node INSIDE that parent — excluded chrome counted,
 * which is the whole point of this file.
 */
function metaFor(node: Text, offset: number) {
  const parent = node.parentElement;
  if (!parent) throw new Error('Fixture text node has no parent element');
  let preceding = 0;
  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current === node) break;
    preceding += (current.textContent ?? '').length;
  }
  return {
    parentTagName: parent.tagName,
    parentIndex: Array.from(articleRoot().getElementsByTagName(parent.tagName)).indexOf(parent),
    textOffset: preceding + offset,
  };
}

const paintedText = (id: string): string =>
  Array.from(document.querySelectorAll<HTMLElement>(
    `[data-bind-id="${id}"], [data-highlight-id="${id}"]`,
  )).map((el) => el.textContent ?? '').join('');

describe('Viewer restore of an alert-title draft', () => {
  test.skipIf(!hasDom)('paints title and body of the alert the positions name', async () => {
    const ref = await mount();
    const [first, second] = alerts() as [HTMLElement, HTMLElement];
    const title = textNodeWith(second, '.alert-title', 'Browser quirks');
    const body = textNodeWith(second, '.alert-body', 'Safari clamps');
    // Painting splits these nodes, so read their text before it runs.
    const titleText = title.textContent ?? '';
    const bodyText = body.textContent ?? '';
    // The hidden word is real and precedes the title in its own parent's text,
    // which is exactly what pushes the stored start onto it.
    expect(second.querySelector('.alert-title .sr-only')?.textContent).toBeTruthy();

    const draft: Annotation = {
      id: 'annAlertDraft',
      // Keep fixture ids camelCase: Tailwind scans this file.
      blockId: 'alertBlock',
      startOffset: 0,
      endOffset: titleText.length + bodyText.length,
      type: AnnotationType.COMMENT,
      text: 'the title and the sentence disagree',
      originalText: `${titleText}${BLOCK_BREAK}${bodyText}`,
      createdA: 1,
      startMeta: metaFor(title, 0),
      endMeta: metaFor(body, bodyText.length),
    };
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe(`${titleText}${bodyText}`);
    expect(paintedText(draft.id)).not.toContain('Tip:');
    expect(second.querySelector('.alert-title mark')).not.toBeNull();
    expect(second.querySelector('.alert-body mark')).not.toBeNull();
    // Falling back to the text search would have landed on the first alert.
    expect(first.querySelector('mark')).toBeNull();
    // The hidden word is never wrapped.
    expect(document.querySelector('.sr-only mark')).toBeNull();
  });

  test.skipIf(!hasDom)('still rejects positions that resolve onto drifted content', async () => {
    // The snap must not turn the verification into a fuzzy match: a quote whose
    // words changed paints nothing rather than the wrong line.
    const ref = await mount();
    const [, second] = alerts() as [HTMLElement, HTMLElement];
    const title = textNodeWith(second, '.alert-title', 'Browser quirks');
    const body = textNodeWith(second, '.alert-body', 'Safari clamps');
    const bodyText = body.textContent ?? '';
    const draft: Annotation = {
      id: 'annAlertDrift',
      blockId: 'alertBlock',
      startOffset: 0,
      endOffset: 10,
      type: AnnotationType.COMMENT,
      text: 'stale',
      originalText: `Firefox quirks${BLOCK_BREAK}${bodyText}`,
      createdA: 1,
      startMeta: metaFor(title, 0),
      endMeta: metaFor(body, bodyText.length),
    };
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe('');
  });
});
