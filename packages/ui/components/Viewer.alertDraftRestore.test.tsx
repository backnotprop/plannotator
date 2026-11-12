import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

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

const alerts = (): HTMLElement[] => {
  const found = Array.from(articleRoot().querySelectorAll<HTMLElement>('[data-block-type="alert"]'));
  if (found.length !== 2) throw new Error(`Fixture no longer renders two alerts (got ${found.length})`);
  return found;
};

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
    const titleText = title.textContent ?? '';
    const bodyText = body.textContent ?? '';
    expect(second.querySelector('.alert-title .sr-only')?.textContent).toBeTruthy();

    const draft: Annotation = {
      id: 'annAlertDraft',
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
    expect(first.querySelector('mark')).toBeNull();
    expect(document.querySelector('.sr-only mark')).toBeNull();
  });

  test.skipIf(!hasDom)('still rejects positions that resolve onto drifted content', async () => {
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
