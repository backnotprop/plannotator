import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation, type EditorMode } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const TITLED = [
  '# Release plan',
  '',
  'Ship the same build twice.',
  '',
  'Ship the same build twice.',
  '',
  'Then tag it.',
].join('\n');

const SLOT = (
  <div data-testid="refs">
    <p><span>Pull requests</span> <a href="#pr">#12</a></p>
    <p><span>Depends on</span> <a href="#dep">Ship the same build twice.</a></p>
  </div>
);

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

interface Handle { applySharedAnnotations: (annotations: Annotation[]) => void }

async function mount(options: {
  markdown?: string;
  belowTitle?: React.ReactNode;
  passProp?: boolean;
  mode?: EditorMode;
  onAddAnnotation?: (annotation: Annotation) => void;
} = {}): Promise<{ article: HTMLElement; ref: React.RefObject<Handle | null> }> {
  const Viewer = viewerModule!.Viewer;
  const markdown = options.markdown ?? TITLED;
  const ref = React.createRef<Handle>();
  host = document.createElement('div');
  document.body.appendChild(host);
  const slotProps = options.passProp === false ? {} : { belowTitle: options.belowTitle };
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        ref={ref as never}
        blocks={parserModule!.parseMarkdownToBlocks(markdown)}
        markdown={markdown}
        annotations={[]}
        onAddAnnotation={options.onAddAnnotation ?? (() => {})}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode={options.mode ?? 'selection'}
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        {...slotProps}
      />,
    );
  });
  await settle();
  const article = host.querySelector<HTMLElement>('article[data-print-region="article"]');
  if (!article) throw new Error('Viewer did not render its annotation container');
  return { article, ref };
}

async function unmount() {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  window.getSelection()?.removeAllRanges();
}

async function select(scope: HTMLElement, phrase: string, nth = 0) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) hits.push(n as Text);
  const node = hits[nth]!;
  const at = node.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node.parentElement!.closest('article') ?? scope).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const paragraphsByText = (article: HTMLElement, text: string) =>
  [...article.querySelectorAll<HTMLElement>('p[data-block-id]')].filter((p) => p.textContent === text);

describe('Viewer belowTitle: where it renders', () => {
  test.skipIf(!hasDom)('undefined, null, false and true draw nothing: the same DOM as without the prop', async () => {
    const without = (await mount({ passProp: false })).article.outerHTML;
    await unmount();
    for (const value of [undefined, null, false, true]) {
      const { article } = await mount({ belowTitle: value });
      expect(article.outerHTML).toBe(without);
      expect(article.querySelector('[data-viewer-below-title]')).toBeNull();
      await unmount();
    }
  });

  test.skipIf(!hasDom)('with a leading # title: right after the heading, which is unchanged', async () => {
    const plainHeading = (await mount({ passProp: false })).article.querySelector('h1')!.outerHTML;
    await unmount();

    const { article } = await mount({ belowTitle: SLOT });
    const heading = article.querySelector('h1')!;
    expect(heading.outerHTML).toBe(plainHeading);
    const slot = heading.nextElementSibling as HTMLElement;
    expect(slot.hasAttribute('data-viewer-below-title')).toBe(true);
    expect(slot.dataset.placement).toBe('below-title');
    expect(slot.querySelector('[data-testid="refs"]')).not.toBeNull();
    expect(slot.classList.contains('annotation-exclude')).toBe(true);
    expect(slot.hasAttribute('data-pinpoint-ignore')).toBe(true);
    expect(slot.hasAttribute('data-print-hide')).toBe(true);
    expect(slot.hasAttribute('data-block-id')).toBe(false);
    expect(slot.querySelector('[data-block-id]')).toBeNull();
    expect((slot.nextElementSibling as HTMLElement).textContent).toBe('Ship the same build twice.');
  });

  test.skipIf(!hasDom)('with no leading # title: at the top of the body, before the first block', async () => {
    for (const markdown of [
      'Intro first.\n\n# A later title\n\nBody.',
      '## A second-level heading\n\nBody.',
    ]) {
      const { article } = await mount({ markdown, belowTitle: SLOT });
      const slot = article.querySelector<HTMLElement>('[data-viewer-below-title]')!;
      expect(slot.dataset.placement).toBe('top');
      const firstBlock = article.querySelector<HTMLElement>('[data-block-id]')!;
      expect(slot.compareDocumentPosition(firstBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(slot.nextElementSibling).toBe(firstBlock);
      await unmount();
    }
  });
});

describe('Viewer belowTitle: comment positions ignore the slot', () => {
  test.skipIf(!hasDom)('a comment made on the paragraph after the title stores the same metas with and without the slot', async () => {
    const made: Annotation[] = [];
    const plain = await mount({ passProp: false, mode: 'redline', onAddAnnotation: (a) => made.push(a) });
    await select(plain.article, 'same build', 1);
    await unmount();

    const slotted = await mount({ belowTitle: SLOT, mode: 'redline', onAddAnnotation: (a) => made.push(a) });
    await select(slotted.article, 'same build', 2);
    expect(made).toHaveLength(2);
    const [without, withSlot] = made;
    expect(withSlot!.originalText).toBe('same build');
    expect(withSlot!.startMeta).toEqual(without!.startMeta);
    expect(withSlot!.endMeta).toEqual(without!.endMeta);
    expect(without!.startMeta!.parentTagName).toBe('P');
  });

  test.skipIf(!hasDom)('a stored comment on the second of two identical paragraphs restores onto that paragraph with the slot present', async () => {
    const plain = await mount({ passProp: false });
    const paragraphs: HTMLElement[] = [...plain.article.getElementsByTagName('p')];
    const target = paragraphsByText(plain.article, 'Ship the same build twice.')[1]!;
    const index = paragraphs.indexOf(target);
    await unmount();

    const draft: Annotation = {
      id: 'annBelowTitle',
      blockId: 'any',
      startOffset: 5,
      endOffset: 15,
      type: AnnotationType.COMMENT,
      text: 'which build?',
      originalText: 'same build',
      createdA: 1,
      startMeta: { parentTagName: 'P', parentIndex: index, textOffset: 9 },
      endMeta: { parentTagName: 'P', parentIndex: index, textOffset: 19 },
    };

    for (const props of [{ passProp: false }, { belowTitle: SLOT }] as const) {
      const { article, ref } = await mount(props);
      await act(async () => { ref.current!.applySharedAnnotations([draft]); });
      const marks = [...article.querySelectorAll<HTMLElement>(`[data-highlight-id="${draft.id}"], [data-bind-id="${draft.id}"]`)];
      expect(marks.map((m) => m.textContent).join('')).toBe('same build');
      const expected = paragraphsByText(article, 'Ship the same build twice.')[1]!;
      expect(marks.every((m) => expected.contains(m))).toBe(true);
      expect(article.querySelector('[data-viewer-below-title] mark')).toBeNull();
      await unmount();
    }
  });

  test.skipIf(!hasDom)('a selection inside the slot makes no comment and opens no toolbar', async () => {
    const made: Annotation[] = [];
    const redline = await mount({ belowTitle: SLOT, mode: 'redline', onAddAnnotation: (a) => made.push(a) });
    await select(redline.article.querySelector('[data-viewer-below-title]')!, 'Pull requests');
    expect(made).toEqual([]);
    expect(redline.article.querySelector('[data-viewer-below-title] mark')).toBeNull();
    await unmount();

    const selection = await mount({ belowTitle: SLOT, mode: 'selection' });
    await select(selection.article.querySelector('[data-viewer-below-title]')!, 'Depends on');
    expect(document.querySelector('.annotation-toolbar')).toBeNull();
  });

  test.skipIf(!hasDom)('a selection from the title that ends inside the slot stores its end at the end of the title, never in the slot', async () => {
    const made: Annotation[] = [];
    const { article } = await mount({ belowTitle: SLOT, mode: 'redline', onAddAnnotation: (a) => made.push(a) });
    const title = article.querySelector('h1')!;
    const titleText = document.createTreeWalker(title, NodeFilter.SHOW_TEXT).nextNode() as Text;
    const slotText = document.createTreeWalker(article.querySelector('[data-viewer-below-title]')!, NodeFilter.SHOW_TEXT).nextNode() as Text;
    const range = document.createRange();
    range.setStart(titleText, titleText.data.indexOf('plan'));
    range.setEnd(slotText, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => { article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); });
    await settle();

    expect(made).toHaveLength(1);
    const { startMeta, endMeta, originalText } = made[0]!;
    expect(originalText).toBe('plan');
    expect(startMeta).toEqual({ parentTagName: 'H1', parentIndex: 0, textOffset: 8 });
    expect(endMeta).toEqual({ parentTagName: 'H1', parentIndex: 0, textOffset: 12 });
  });

  test.skipIf(!hasDom)('raw HTML in the document carrying the attribute is not the slot: stored metas are the same as without it', async () => {
    const markdown = [
      '# Release plan',
      '',
      '<div data-viewer-below-title=""><p>Author <span>text</span></p></div>',
      '',
      'Ship the same build twice.',
    ].join('\n');
    const made: Annotation[] = [];
    const { article } = await mount({ markdown, passProp: false, mode: 'redline', onAddAnnotation: (a) => made.push(a) });
    const htmlBlock = article.querySelectorAll<HTMLElement>('[data-block-id]')[1]!;
    if (!htmlBlock.querySelector('[data-viewer-below-title]')) {
      const authored = document.createElement('div');
      authored.setAttribute('data-viewer-below-title', '');
      authored.innerHTML = '<p>Author <span>text</span></p>';
      htmlBlock.appendChild(authored);
    }
    expect(article.querySelector('[data-viewer-below-title]')).not.toBeNull();
    await select(article, 'same build');
    expect(made).toHaveLength(1);
    const paragraphs: HTMLElement[] = [...article.getElementsByTagName('p')];
    const live = paragraphs.indexOf(paragraphsByText(article, 'Ship the same build twice.')[0]!);
    expect(made[0]!.startMeta).toEqual({ parentTagName: 'P', parentIndex: live, textOffset: 9 });
    expect(live).toBeGreaterThan(0);
  });
});
