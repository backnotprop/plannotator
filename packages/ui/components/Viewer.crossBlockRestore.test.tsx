import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in web-highlighter, whose UMD bundle reads `window` at
// module-eval time; import lazily (same pattern as Viewer.driftedRestore).
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

const MARKDOWN = [
  'First paragraph alpha ends here.',
  '',
  'Second paragraph beta starts here.',
  '',
  '## Heading charlie stands alone',
  '',
  'Paragraph delta sits under the heading.',
  '',
  '- List item echo comes first',
  '- List item foxtrot comes second',
  '',
  'Paragraph golf introduces the snippet.',
  '',
  '```ts',
  'const hotel = 1;',
  '```',
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

const elementWith = (tagName: string, needle: string): HTMLElement => {
  const found = Array.from(articleRoot().getElementsByTagName(tagName))
    .find((el) => (el.textContent ?? '').includes(needle));
  if (!found) throw new Error(`Fixture no longer renders a <${tagName}> containing "${needle}"`);
  return found as HTMLElement;
};

/**
 * web-highlighter's stored meta: the element's index among all elements of its tag under the
 * container, plus the text offset inside it.
 */
const metaFor = (el: HTMLElement, textOffset: number) => ({
  parentTagName: el.tagName,
  parentIndex: Array.from(articleRoot().getElementsByTagName(el.tagName)).indexOf(el),
  textOffset,
});

function crossBlockDraft(
  id: string,
  start: HTMLElement,
  end: HTMLElement,
): Annotation {
  const startText = start.textContent ?? '';
  const endText = end.textContent ?? '';
  return {
    id,
    // Keep fixture ids camelCase: Tailwind scans this file, and a hyphenated id that parses as a utility leaks a rule into every build.
    blockId: 'crossBlock',
    startOffset: 0,
    endOffset: startText.length + endText.length,
    type: AnnotationType.COMMENT,
    text: 'this pair reads oddly',
    originalText: `${startText}${BLOCK_BREAK}${endText}`,
    createdA: 1,
    startMeta: metaFor(start, 0),
    endMeta: metaFor(end, endText.length),
  };
}

const withoutStoredPositions = (draft: Annotation): Annotation =>
  ({ ...draft, blockId: '', startMeta: undefined, endMeta: undefined });

const paintedText = (id: string): string =>
  Array.from(document.querySelectorAll<HTMLElement>(
    `[data-bind-id="${id}"], [data-highlight-id="${id}"]`,
  )).map((el) => el.textContent ?? '').join('');

describe('Viewer restore of a selection spanning two blocks', () => {
  test.skipIf(!hasDom)('two paragraphs', async () => {
    const ref = await mount();
    const first = elementWith('p', 'alpha');
    const second = elementWith('p', 'beta');
    const draft = crossBlockDraft('annPara', first, second);
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe(`${first.textContent}${second.textContent}`);
    expect(first.querySelector('mark')).not.toBeNull();
    expect(second.querySelector('mark')).not.toBeNull();
  });

  test.skipIf(!hasDom)('a heading and the paragraph under it', async () => {
    const ref = await mount();
    const heading = elementWith('h2', 'charlie');
    const paragraph = elementWith('p', 'delta');
    const draft = crossBlockDraft('annHeading', heading, paragraph);
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe(`${heading.textContent}${paragraph.textContent}`);
    expect(heading.querySelector('mark')).not.toBeNull();
  });

  test.skipIf(!hasDom)('two list items', async () => {
    const ref = await mount();
    const first = elementWith('span', 'echo');
    const second = elementWith('span', 'foxtrot');
    const marker = second.previousElementSibling?.textContent ?? '';
    expect(marker).not.toBe('');
    const draft = crossBlockDraft('annList', first, second);
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe(`${first.textContent}${second.textContent}`);
    expect(paintedText(draft.id)).not.toContain(marker);
    expect(first.querySelector('mark')).not.toBeNull();
    expect(second.querySelector('mark')).not.toBeNull();
  });

  test.skipIf(!hasDom)('a paragraph and the fenced block under it', async () => {
    const ref = await mount();
    const paragraph = elementWith('p', 'golf');
    const code = elementWith('code', 'hotel');
    const draft = crossBlockDraft('annCode', paragraph, code);
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe(`${paragraph.textContent}${code.textContent}`);
    expect(code.querySelector('mark')).not.toBeNull();
  });

  test.skipIf(!hasDom)('re-anchors by text alone across a block boundary', async () => {
    const ref = await mount();
    const first = elementWith('p', 'alpha');
    const second = elementWith('p', 'beta');
    const draft = withoutStoredPositions(crossBlockDraft('annSearchPara', first, second));
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe(`${first.textContent}${second.textContent}`);
  });

  test.skipIf(!hasDom)('re-anchors by text alone across two list items', async () => {
    const ref = await mount();
    const first = elementWith('span', 'echo');
    const second = elementWith('span', 'foxtrot');
    const draft = withoutStoredPositions(crossBlockDraft('annSearchList', first, second));
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe(`${first.textContent}${second.textContent}`);
  });

  test.skipIf(!hasDom)('re-anchors by text alone from a paragraph into a fence', async () => {
    const ref = await mount();
    const paragraph = elementWith('p', 'golf');
    const code = elementWith('code', 'hotel');
    const draft = withoutStoredPositions(crossBlockDraft('annSearchCode', paragraph, code));
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe(`${paragraph.textContent}${code.textContent}`);
  });

  test.skipIf(!hasDom)('a text-only restore of drifted content still paints nothing', async () => {
    // The boundary-aware search must not become a fuzzy one: a quote whose
    // words changed has no match, positions or not.
    const ref = await mount();
    const first = elementWith('p', 'alpha');
    const second = elementWith('p', 'beta');
    const draft = withoutStoredPositions(crossBlockDraft('annSearchDrift', first, second));
    draft.originalText = draft.originalText.replace('beta', 'gamma');
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe('');
  });

  test.skipIf(!hasDom)('a quote whose content really did change is still rejected', async () => {
    // The guard exists for drift: whitespace-only differences must pass, a different word must
    // not.
    const ref = await mount();
    const first = elementWith('p', 'alpha');
    const second = elementWith('p', 'beta');
    const draft = crossBlockDraft('annDrift', first, second);
    draft.originalText = draft.originalText.replace('beta', 'gamma');
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe('');
  });
});
