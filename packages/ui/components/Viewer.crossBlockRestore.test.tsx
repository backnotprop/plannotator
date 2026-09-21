/**
 * A restore whose stored positions resolve onto exactly the right text must
 * survive the content verification Viewer turns on.
 *
 * `originalText` is the BROWSER's selection string, and a selection spanning
 * two block elements carries a blank line between them. The painted highlight
 * is the wrapper `<mark>`s concatenated with nothing between them, because
 * sibling blocks are rendered from a `.map()` with no whitespace text node.
 * Comparing the two with whitespace merely collapsed (rather than removed)
 * therefore rejected every correct cross-block restore: the highlight was
 * removed, the text search could not bridge the boundary either, and the
 * annotation came back from a reload with no highlight at all.
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

/** What every real browser puts between two block elements in a selection
 *  string; happy-dom's `innerText` is not layout-aware, so the fixtures spell
 *  it out rather than reading it back off a synthetic selection. */
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

/** The element carrying a piece of the document's text, by substring. */
const elementWith = (tagName: string, needle: string): HTMLElement => {
  const found = Array.from(articleRoot().getElementsByTagName(tagName))
    .find((el) => (el.textContent ?? '').includes(needle));
  if (!found) throw new Error(`Fixture no longer renders a <${tagName}> containing "${needle}"`);
  return found as HTMLElement;
};

/** web-highlighter's stored meta: the element's index among all elements of
 *  its tag under the container, plus the text offset inside it. */
const metaFor = (el: HTMLElement, textOffset: number) => ({
  parentTagName: el.tagName,
  parentIndex: Array.from(articleRoot().getElementsByTagName(el.tagName)).indexOf(el),
  textOffset,
});

/**
 * The draft a reviewer wrote by dragging from `start` to the end of `end`:
 * positions that resolve onto exactly those two elements, and the quote the
 * browser handed back, block break included.
 */
function crossBlockDraft(
  id: string,
  start: HTMLElement,
  end: HTMLElement,
): Annotation {
  const startText = start.textContent ?? '';
  const endText = end.textContent ?? '';
  return {
    id,
    // Keep fixture ids camelCase: Tailwind scans this file, and a hyphenated
    // id that parses as a utility candidate leaks a rule into every build.
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

/** The same draft after an Edit Mode commit: `applyEditedDocument` strips the
 *  stored positions of every annotation whose quote is not contained in one
 *  block — which is every cross-block annotation — so the restore has nothing
 *  but the quote and the text search is the only path left. */
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
    // A list item's text lives in a <span> beside its marker, not an <li>, and
    // the selection crosses the second item's bullet on the way. The marker is
    // `select-none`, so no browser ever puts the bullet in the selection
    // string: the stored quote is the two items with a block break between
    // them and nothing else. The painted highlight has to agree, which is what
    // `annotation-exclude` on the marker buys.
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

  // An Edit Mode commit leaves a cross-block annotation with nothing but its
  // quote (see `withoutStoredPositions`). Before this, the whitespace-collapsing
  // search compared a needle carrying the browser's block break against a
  // haystack that joins block text with nothing at all, so no cross-block quote
  // could ever be found: every cross-block highlight vanished on the first edit
  // anywhere in the document.
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
    // The guard exists for drift (#1509): whitespace-only differences must
    // pass, a different word must not. With no text-search rescue possible
    // either, the annotation paints nothing rather than the wrong line.
    const ref = await mount();
    const first = elementWith('p', 'alpha');
    const second = elementWith('p', 'beta');
    const draft = crossBlockDraft('annDrift', first, second);
    draft.originalText = draft.originalText.replace('beta', 'gamma');
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    expect(paintedText(draft.id)).toBe('');
  });
});
