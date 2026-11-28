/**
 * An author's text colour in Markdown (#3345), as the document Viewer draws
 * it: a table cell or a sentence keeps `<span style="color: …">` and
 * `<font color>` as a coloured span around the same words, a refused style
 * keeps the words uncoloured, and anything else stays text as before. A
 * colour too dark for the card behind it is lightened; a readable one is left
 * as written. Highlights across a coloured span land on the same words and
 * come back from saved positions and from the quote alone, and a table
 * copies as its words.
 *
 * The block sanitizer's half (raw HTML blocks) runs DOMPurify, which
 * happy-dom cannot host: tests/e2e/markdown-author-color.spec.ts proves it.
 *
 * DOM-gated (DOM_TESTS=1, tests/dom-test-list.txt).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';
import { buildCsv, buildMarkdownTable, parseTableContent } from './blocks/TableBlock';
import { InlineMarkdown } from './InlineMarkdown';

const hasDom = typeof document !== 'undefined';
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

const TABLE = [
  '| Model | Pass rate |',
  '| --- | --- |',
  '| alpha | <span style="color: #d00000">73.0%</span> |',
  '| beta | <font color="#b26a00">93.5%</font> |',
  '| gamma | <span style="color:green">**98.2%**</span> |',
  '| delta | <span style="color: red; background: url(//evil.test)">88.0%</span> |',
].join('\n');

const MARKDOWN = ['Coverage dropped to <span style="color: #d00000">73.0% this week</span> after the merge.', '', TABLE].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mountInline(text: string, background?: string): Promise<HTMLElement> {
  host = document.createElement('div');
  if (background) host.style.backgroundColor = background;
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<InlineMarkdown text={text} />));
  return host;
}

describe.if(hasDom)('inline markdown keeps an author\'s text colour', () => {
  test('span and font colour the same words; nested markdown still renders', async () => {
    const page = await mountInline('a <span style="color: #D00000">73.0%</span> b <font color=green>**ok**</font> c');
    const spans = Array.from(page.querySelectorAll<HTMLElement>('span[style]'));
    expect(spans.map((s) => [s.textContent, s.style.color])).toEqual([
      ['73.0%', '#d00000'],
      ['ok', 'green'],
    ]);
    expect(spans[1].querySelector('strong')?.textContent).toBe('ok');
    expect(page.textContent).toBe('a 73.0% b ok c');
    expect(page.querySelector('font')).toBeNull();
  });

  test('a refused style keeps the words and paints no style at all', async () => {
    for (const hostile of ['color: red; background: url(//evil.test)', 'color:red;position:fixed', 'color: var(--x)', 'color: expression(alert(1))', 'c\\6f lor: red', `color: ${'a'.repeat(10_240)}`]) {
      const page = await mountInline(`<span style="${hostile}">words</span>`);
      expect([hostile.slice(0, 30), page.querySelectorAll('[style]').length, page.textContent]).toEqual([hostile.slice(0, 30), 0, 'words']);
      await act(async () => root!.unmount());
      root = null;
      host!.remove();
    }
  });

  test('any other tag shape stays text, as before', async () => {
    const page = await mountInline('<span class="x">a</span> <div style="color: red">b</div> <span style="color: red">open');
    expect(page.querySelectorAll('[style]').length).toBe(0);
    // Smart punctuation curls the quotes, as it does for any text.
    expect(page.textContent!.replace(/[”“]/g, '"')).toBe('<span class="x">a</span> <div style="color: red">b</div> <span style="color: red">open');
  });

  test('a dark red on a dark card is lightened to 3:1 with its hue kept; a readable colour is left as written', async () => {
    const dark = await mountInline('<span style="color: #5a0000">low</span>', 'rgb(30, 30, 36)');
    const shifted = dark.querySelector<HTMLElement>('span[style]')!.style.color;
    const [r, g, b] = shifted.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(g);
    expect(g).toBe(b);
    const { contrastRatio } = await import('../utils/authorColor');
    expect(contrastRatio([r, g, b], [30, 30, 36])).toBeGreaterThanOrEqual(3);
    await act(async () => root!.unmount());
    root = null;

    const kept = await mountInline('<span style="color: #ff6b6b">fine</span>', 'rgb(30, 30, 36)');
    expect(kept.querySelector<HTMLElement>('span[style]')!.style.color).toBe('#ff6b6b');
  });
});

describe.if(hasDom)('a table copies a coloured cell as its words', () => {
  test('CSV and Markdown copies carry no colour tags', () => {
    expect(buildCsv(TABLE)).toBe('Model,Pass rate\nalpha,73.0%\nbeta,93.5%\ngamma,**98.2%**\ndelta,88.0%');
    const { headers, rows } = parseTableContent(TABLE);
    expect(buildMarkdownTable(headers, rows)).not.toMatch(/<\/?(span|font)/);
    expect(rows[0][1]).toBe('<span style="color: #d00000">73.0%</span>');
  });

  test('a code span that documents the syntax copies as written', () => {
    const docs = ['| Write | Shows |', '| --- | --- |', '| `<span style="color: red">x</span>` | <span style="color: red">x</span> |'].join('\n');
    expect(buildCsv(docs)).toBe('Write,Shows\n"`<span style=""color: red"">x</span>`",x');
    const { headers, rows } = parseTableContent(docs);
    expect(buildMarkdownTable(headers, rows)).toContain('| `<span style="color: red">x</span>` | x |');
  });
});

describe.if(hasDom)('a coloured span is checked again on a theme switch, not on every write to <html>', () => {
  const frames = () => act(async () => new Promise((r) => setTimeout(r, 300)));

  test('a panel width written to <html> leaves it; a theme class repaints it', async () => {
    const html = document.documentElement;
    const page = await mountInline('<span style="color: #5a0000">low</span>', 'rgb(255, 255, 255)');
    const span = page.querySelector<HTMLElement>('span[style]')!;
    expect(span.style.color).toBe('#5a0000');
    try {
      // The card turns dark without a theme switch: a drag frame is not one.
      host!.style.backgroundColor = 'rgb(30, 30, 36)';
      html.style.setProperty('--rpanel-w', '320px');
      await frames();
      html.style.setProperty('--rpanel-w', '340px');
      await frames();
      expect(span.style.color).toBe('#5a0000');

      html.classList.add('author-color-test-theme');
      await frames();
      expect(span.style.color).not.toBe('#5a0000');
      expect(span.style.color).toMatch(/^rgb\(/);
    } finally {
      html.style.removeProperty('--rpanel-w');
      html.classList.remove('author-color-test-theme');
    }
  });
});

interface ViewerHandle {
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

async function mountViewer(): Promise<React.RefObject<ViewerHandle | null>> {
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

const article = (): HTMLElement => document.querySelector<HTMLElement>('article[data-print-region="article"]')!;

const paintedText = (id: string): string =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-bind-id="${id}"], [data-highlight-id="${id}"]`)).map((el) => el.textContent ?? '').join('');

/** A drag from `start` to `end` inside one element's text, as web-highlighter stores it. */
function draft(id: string, el: HTMLElement, start: number, end: number, withPositions: boolean): Annotation {
  const text = el.textContent ?? '';
  const meta = (offset: number) => ({
    parentTagName: el.tagName,
    parentIndex: Array.from(article().getElementsByTagName(el.tagName)).indexOf(el),
    textOffset: offset,
  });
  return {
    id,
    blockId: withPositions ? 'colorBlock' : '',
    startOffset: start,
    endOffset: end,
    type: AnnotationType.COMMENT,
    text: 'check this',
    originalText: text.slice(start, end),
    createdA: 1,
    ...(withPositions ? { startMeta: meta(start), endMeta: meta(end) } : {}),
  };
}

describe.if(hasDom)('highlights across a coloured span', () => {
  const sentence = () => Array.from(article().getElementsByTagName('p')).find((p) => p.textContent?.includes('Coverage'))!;

  test('the sentence reads as its words, the colour inside it', async () => {
    await mountViewer();
    expect(sentence().textContent).toBe('Coverage dropped to 73.0% this week after the merge.');
    expect(sentence().querySelector<HTMLElement>('span[style]')!.textContent).toBe('73.0% this week');
  });

  test('restored from saved positions, starting before the span and ending inside it', async () => {
    const ref = await mountViewer();
    const p = sentence();
    const text = p.textContent!;
    const ann = draft('annColorPos', p, text.indexOf('dropped'), text.indexOf(' this week'), true);
    await act(async () => ref.current!.applySharedAnnotations([ann]));
    expect(paintedText(ann.id)).toBe('dropped to 73.0%');
    const colored = p.querySelector<HTMLElement>('span[style]')!;
    expect(colored.style.color).toBe('#d00000');
    expect(colored.querySelector('mark')?.textContent).toBe('73.0%');
  });

  test('restored from the quote alone, across the span\'s end', async () => {
    const ref = await mountViewer();
    const p = sentence();
    const text = p.textContent!;
    const ann = draft('annColorQuote', p, text.indexOf('this week'), text.indexOf(' the merge'), false);
    await act(async () => ref.current!.applySharedAnnotations([ann]));
    expect(paintedText(ann.id)).toBe('this week after');
  });

  test('a coloured table cell highlights as its words', async () => {
    const ref = await mountViewer();
    const cell = Array.from(article().getElementsByTagName('td')).find((td) => td.textContent === '93.5%')!;
    expect(cell.querySelector<HTMLElement>('span[style]')!.style.color).toBe('#b26a00');
    const ann = draft('annColorCell', cell, 0, 4, false);
    await act(async () => ref.current!.applySharedAnnotations([ann]));
    expect(paintedText(ann.id)).toBe('93.5');
  });
});
