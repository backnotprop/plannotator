/**
 * Raw HTML in a document, and paragraphs of images, in the plan Viewer and in
 * RenderedMarkdown (the Inbox's message bodies, written by agents), with the
 * real sanitizer (`tests/helpers/chat-sanitizer-dom.ts` lets DOMPurify run in
 * happy-dom; happy-dom is told not to load frames or scripts, so nothing here
 * touches the network even if a tag got through).
 *
 * What regresses if these fail:
 * - a tag the sanitizer drops (`<iframe>`, `<script>`, `<style>`, `<form>`,
 *   `<object>`, `<embed>`, `<svg>`) prints its own source as text again, on
 *   its own line or mid-sentence, or reaches the page as a live element;
 * - an `<iframe>` that is never closed hides the rest of the message;
 * - an emptied `<div><iframe></iframe></div>` leaves an empty gap;
 * - `<sub>`, `<kbd>`, `<mark>` print as text, or `<details>` stops working;
 * - a prose mention (`<scriptless>`, "the <iframe> tag"), a code span or a
 *   fence loses the words as written;
 * - a linked image stops being an image inside a link;
 * - images alone in a paragraph or a list item stop drawing as one row (or a
 *   single image loses its height cap), or an image in a sentence, a table
 *   cell or an `<img width>` starts drawing as one;
 * - a comment saved when raw HTML printed as text (positions measured on
 *   origin/main: `tests/test-fixtures/raw-html-old-anchors.json`) no longer
 *   comes back on exactly its words, in its own block, a repeated sentence
 *   included.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeSanitizerDom } from '../../../tests/helpers/chat-sanitizer-dom';
import type { Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';

const hasDom = typeof document !== 'undefined';
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];
const renderedMod = hasDom ? await import('./RenderedMarkdown') : null;
const RenderedMarkdown = renderedMod?.RenderedMarkdown as typeof import('./RenderedMarkdown')['RenderedMarkdown'];
const blockRendererMod = hasDom ? await import('./BlockRenderer') : null;
const BlockRenderer = blockRendererMod?.BlockRenderer as typeof import('./BlockRenderer')['BlockRenderer'];
const planDiffMod = hasDom ? await import('./plan-diff/PlanCleanDiffView') : null;
const PlanCleanDiffView = planDiffMod?.PlanCleanDiffView as typeof import('./plan-diff/PlanCleanDiffView')['PlanCleanDiffView'];
const planDiffEngine = hasDom ? await import('../utils/planDiffEngine') : null;

type HappySettings = Record<string, unknown>;
const settings = hasDom ? (window as unknown as { happyDOM: { settings: HappySettings } }).happyDOM.settings : ({} as HappySettings);
const savedSettings = { iframe: settings.disableIframePageLoading, js: settings.disableJavaScriptFileLoading, css: settings.disableCSSFileLoading };
let unbridge: (() => void) | undefined;

beforeAll(() => {
  if (!hasDom) return;
  settings.disableIframePageLoading = true;
  settings.disableJavaScriptFileLoading = true;
  settings.disableCSSFileLoading = true;
  unbridge = bridgeSanitizerDom();
});

afterAll(() => {
  if (!hasDom) return;
  settings.disableIframePageLoading = savedSettings.iframe;
  settings.disableJavaScriptFileLoading = savedSettings.js;
  settings.disableCSSFileLoading = savedSettings.css;
  unbridge?.();
});

interface ViewerHandle {
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

const roots: Root[] = [];

async function mountViewer(markdown: string, onRestoreReport?: (report: AnnotationRestoreReport) => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ref = React.createRef<ViewerHandle>();
  await act(async () => {
    const root = createRoot(host);
    roots.push(root);
    root.render(
      <Viewer
        ref={ref as never}
        blocks={parseMarkdownToBlocks(markdown)}
        markdown={markdown}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        inputMethod="drag"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        onRestoreReport={onRestoreReport}
      />,
    );
  });
  await settle();
  return { ref, host, article: host.querySelector('article')! };
}

async function mountBody(markdown: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    const root = createRoot(host);
    roots.push(root);
    root.render(<RenderedMarkdown markdown={markdown} />);
  });
  await settle();
  return host;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const DROPPED_SELECTOR = 'iframe, script, style, form, input, button, object, embed, svg, textarea';
/** The document's own blocks (not the Viewer's buttons around them). */
const blocksOf = (root: Element): Element[] =>
  Array.from(root.querySelectorAll('[data-block-id]')).filter((el) => !el.parentElement?.closest('[data-block-id]'));
/** Elements the sanitizer drops, anywhere in the document's blocks. */
const droppedIn = (root: Element): string[] => blocksOf(root).flatMap((block) => Array.from(block.querySelectorAll(DROPPED_SELECTOR), (el) => el.tagName));
/** Text a reader sees, block by block: hidden blocks left out. */
const visibleText = (root: Element): string =>
  blocksOf(root)
    .filter((block) => !(block as HTMLElement).hidden)
    .map((block) => (block.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');

const URL_BASE = 'https://example.invalid';
/** The sibling app's failing cases, one document. */
const STRIPPED = [
  'Before the embeds.',
  '',
  `<iframe src="${URL_BASE}/embed" width="100%" height="320"></iframe>`,
  '',
  '<script>document.title = "ran"</script>',
  '',
  '<style>',
  '.x { color: red; }',
  '</style>',
  '',
  '<iframe',
  `  src="${URL_BASE}/multi"`,
  '  width="100%"',
  '  height="320"></iframe>',
  '',
  `<div><iframe src="${URL_BASE}/inner"></iframe></div>`,
  '',
  `<form action="${URL_BASE}"><input name="q"><button>Go</button></form>`,
  '',
  `<object data="${URL_BASE}/x.pdf"></object>`,
  '',
  `<embed src="${URL_BASE}/x.swf">`,
  '',
  `<IFRAME src="${URL_BASE}/upper"></IFRAME>`,
  '',
  '<iframe/>',
  '',
  '<svg width="10" height="10"><circle r="4"/></svg>',
  '',
  'After the embeds.',
].join('\n');

describe.if(hasDom)('raw HTML the sanitizer drops draws nothing, never its source', () => {
  for (const [surface, mount] of [
    ['the plan Viewer', async (md: string) => (await mountViewer(md)).article],
    ['a message body (RenderedMarkdown)', mountBody],
  ] as const) {
    test(`${surface}: every case on its own line draws nothing and leaves no gap`, async () => {
      const root = await mount(STRIPPED);
      expect(droppedIn(root)).toEqual([]);
      expect(visibleText(root)).toBe('Before the embeds. Go After the embeds.');
      // Every emptied block is hidden (no empty box with margins); the form keeps its button's word.
      const htmlBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-block-type="html"]'));
      const visible = htmlBlocks.filter((el) => !el.hidden);
      expect(visible.map((el) => (el.textContent ?? '').trim())).toEqual(['Go']);
      expect(htmlBlocks.filter((el) => el.hidden).length).toBe(htmlBlocks.length - 1);
      // Nothing with a URL in it was drawn as a link from inside a tag.
      expect(blocksOf(root).flatMap((block) => Array.from(block.querySelectorAll('a'), (a) => a.getAttribute('href')))).toEqual([]);
    });

    test(`${surface}: an iframe never closed hides nothing after it`, async () => {
      const root = await mount([`<iframe src="${URL_BASE}/open">`, '', 'A normal paragraph that must stay.', '', '## And a heading', '', 'More words.'].join('\n'));
      expect(droppedIn(root)).toEqual([]);
      expect(visibleText(root)).toBe('A normal paragraph that must stay. And a heading More words.');
      const tight = await mount([`<iframe src="${URL_BASE}/open">`, 'The next line, with no blank line before it.'].join('\n'));
      expect(visibleText(tight)).toContain('The next line, with no blank line before it.');
    });
  }

  test('an iframe line inside a paragraph is dropped there: the paragraph stays one block, as it always was', async () => {
    const markdown = `Intro.\n<iframe src="${URL_BASE}/e" width="100%" height="320"></iframe>\nCaption.\n\nNext.`;
    // One paragraph, then another: the same blocks (and ids) as when the line printed as text.
    expect(parseMarkdownToBlocks(markdown).map((b) => `${b.id}:${b.type}`)).toEqual(['block-0:paragraph', 'block-1:paragraph']);
    const { article } = await mountViewer(markdown);
    expect(droppedIn(article)).toEqual([]);
    expect(visibleText(article)).toBe('Intro. Caption. Next.');
    expect(article.querySelectorAll('p[data-block-id]')).toHaveLength(2);
  });

  test('a paragraph of nothing but dropped HTML (a script right under a heading) is a hidden paragraph: no gap, the same count of paragraphs', async () => {
    const { article } = await mountViewer('## Setup\n<script>track()</script>\n\nRun it.');
    const paragraphs = Array.from(article.querySelectorAll<HTMLElement>('p[data-block-id]'));
    expect(paragraphs.map((p) => p.hidden)).toEqual([true, false]);
    expect(visibleText(article)).toBe('Setup Run it.');
    // An HTML comment draws nothing too (InlineMarkdown skips it): with one before the script, still no gap.
    const commented = (await mountViewer('## Setup\n<!-- analytics --><script>track()</script>\n\nRun it.')).article;
    expect(Array.from(commented.querySelectorAll<HTMLElement>('p[data-block-id]'), (p) => p.hidden)).toEqual([true, false]);
    expect(visibleText(commented)).toBe('Setup Run it.');
  });

  test('code review\'s rendered Markdown diff (a view of the source) prints added dropped HTML as text, as it did before; the Viewer still hides it', async () => {
    const added = [
      '## Setup',
      `<script src="${URL_BASE}/a.js"></script>`,
      '',
      `<script src="${URL_BASE}/b.js"></script>`,
      '',
      `<div><iframe src="${URL_BASE}/c"></iframe></div>`,
      '',
      'Run it.',
    ].join('\n');
    const { blocks } = planDiffEngine!.computePlanDiff('Intro.\n', `Intro.\n\n${added}\n`);
    const host = document.createElement('div');
    document.body.appendChild(host);
    // As MarkdownFilePreview draws it: the diff view, each block through the shared BlockRenderer.
    await act(async () => {
      const root = createRoot(host);
      roots.push(root);
      root.render(
        <PlanCleanDiffView
          blocks={blocks}
          wordLevel={false}
          renderBlock={(block, orderedIndex) => <BlockRenderer block={block} orderedIndex={orderedIndex} />}
        />,
      );
    });
    await settle();
    expect(droppedIn(host)).toEqual([]);
    // Both script lines print their source as a paragraph, as on origin/main (where neither was an HTML block):
    // the same <p> and classes, the source as inert text, nothing hidden.
    const scripts = Array.from(host.querySelectorAll<HTMLElement>('p[data-block-id]')).filter((p) => p.textContent!.includes('<script'));
    // (Its quotes curl, as all text's do: typography, as on origin/main.)
    expect(scripts.map((p) => [p.textContent!.replace(/[“”]/g, '"'), p.hidden, p.className])).toEqual(
      ['a.js', 'b.js'].map((file) => [
        `<script src="${URL_BASE}/${file}"></script>`,
        false,
        'relative mb-4 leading-relaxed text-foreground/90 text-[15px] [overflow-wrap:anywhere]',
      ]),
    );
    // The emptied <div> was an HTML block on origin/main too, drawn (empty), not hidden.
    expect(Array.from(host.querySelectorAll<HTMLElement>('[data-block-type="html"]'), (el) => el.hidden)).toEqual([false]);
    expect(visibleText(host)).toContain('Run it.');

    // Outside that view, the same document still hides them.
    const { article } = await mountViewer(added);
    expect(droppedIn(article)).toEqual([]);
    expect(visibleText(article)).toBe('Setup Run it.');
  });

  test('spacers and empty blocks with no dropped tag draw as they always did; only blocks that printed text before are marked', async () => {
    const { article } = await mountViewer(['<p>&nbsp;</p>', '', '<p><br></p>', '', '<div><br/></div>', '', '<div></div>', '', `<div><iframe src="${URL_BASE}/x"></iframe></div>`, '', `<iframe src="${URL_BASE}/y"></iframe>`].join('\n'));
    const html = Array.from(article.querySelectorAll<HTMLElement>('[data-block-type="html"]'));
    expect(html.map((el) => [el.hidden, el.hasAttribute('data-html-dropped')])).toEqual([
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      // Emptied by dropping its iframe: hidden, but it was an HTML block before too (no paragraph moved).
      [true, false],
      // A line that used to print as a paragraph of text.
      [true, true],
    ]);
  });

  test('mid-sentence: the tag goes, the sentence stays; a prose mention stays as written', async () => {
    const { article } = await mountViewer(
      [
        `Notes: see <iframe src="${URL_BASE}/mid"></iframe> here.`,
        '',
        'Replace the <iframe> with a <video> element; <scriptless> is not a tag.',
        '',
        '- an item with <script>alert(1)</script>words after',
      ].join('\n'),
    );
    expect(droppedIn(article)).toEqual([]);
    const text = visibleText(article);
    expect(text).toContain('Notes: see here.');
    expect(text).toContain('Replace the <iframe> with a <video> element; <scriptless> is not a tag.');
    expect(text).toContain('an item with words after');
    expect(text).not.toContain('alert');
  });

  test('prose that starts with a tag name is drawn whole, as written', async () => {
    const lines = [
      '<iframe> embeds are not supported in pages.',
      '<form> lets you collect input.',
      '<style> blocks are ignored here.',
      '<svg> beats <canvas> for icons',
      '<script> tags never run here.',
    ];
    const { article } = await mountViewer(lines.join('\n\n'));
    expect(visibleText(article)).toBe(lines.join(' '));
  });

  test('a capitalised MDX or JSX component is drawn as before, as its source', async () => {
    const lines = ['<Button>Go</Button>', '<Input placeholder="x" />', '<Link href="/a">Docs</Link>'];
    const { article } = await mountViewer(lines.join('\n\n'));
    // (The Viewer curls straight quotes in prose, as it always has.)
    expect(visibleText(article).replace(/[“”]/g, '"')).toBe(lines.join(' '));
    expect(article.querySelectorAll('[data-html-dropped]')).toHaveLength(0);
  });

  test('words the sanitizer keeps stay: a button\'s label, an object\'s fallback link, a canvas\'s text', async () => {
    const { article } = await mountViewer(
      [
        '<div><button>Download</button></div>',
        '',
        `<object data="${URL_BASE}/x.pdf"><a href="${URL_BASE}/x.pdf">Download the PDF</a></object>`,
        '',
        '<canvas>Your browser cannot draw this.</canvas>',
        '',
        'Inline: <button type="button">Save</button> then go on.',
      ].join('\n'),
    );
    expect(droppedIn(article)).toEqual([]);
    expect(visibleText(article)).toBe('Download Download the PDF Your browser cannot draw this. Inline: Save then go on.');
    expect(article.querySelector('a')?.getAttribute('href')).toBe(`${URL_BASE}/x.pdf`);
  });

  test('<sub>, <sup>, <kbd> and <mark> draw as elements, their content as markdown', async () => {
    const { article } = await mountViewer('H<sub>2</sub>O, x<sup>2</sup>, <kbd>Ctrl</kbd>, <mark>**marked**</mark>');
    expect(article.querySelector('sub')?.textContent).toBe('2');
    expect(article.querySelector('sup')?.textContent).toBe('2');
    expect(article.querySelector('kbd')?.textContent).toBe('Ctrl');
    // Not a <mark>: the highlighter paints comments with <mark>.
    expect(article.querySelector('mark')).toBeNull();
    expect(article.querySelector('[data-html-mark] strong')?.textContent).toBe('marked');
    expect(visibleText(article)).toBe('H2O, x2, Ctrl, marked');
  });

  test('a close tag in a code span closes nothing, nested tags nest, a close past a code span is not looked for', async () => {
    const { article } = await mountViewer(
      [
        'Never put user data in a <script> block: a `</script>` in it ends the script.',
        '',
        'Use <kbd> for keys, e.g. `<kbd>Ctrl</kbd>`',
        '',
        'Copy with <kbd><kbd>Ctrl</kbd>+<kbd>C</kbd></kbd> now.',
        '',
        'Water is H<sub>2 see the note. Run `make` first, then the rest.</sub> after.',
      ].join('\n'),
    );
    const text = visibleText(article);
    expect(text).toContain('Never put user data in a <script> block: a </script> in it ends the script.');
    expect(text).toContain('Use <kbd> for keys, e.g. <kbd>Ctrl</kbd>');
    expect(Array.from(article.querySelectorAll('p code'), (code) => code.textContent)).toEqual(['</script>', '<kbd>Ctrl</kbd>', 'make']);
    // Only the nested shortcut is drawn as keys: an outer box around two inner ones.
    const outer = Array.from(article.querySelectorAll('kbd')).filter((kbd) => !kbd.parentElement?.closest('kbd'));
    expect(outer.map((kbd) => [kbd.textContent, kbd.querySelectorAll('kbd').length])).toEqual([['Ctrl+C', 2]]);
    expect(article.querySelector('sub')).toBeNull();
    expect(text).toContain('Water is H<sub>2 see the note. Run make first, then the rest.</sub> after.');
  });

  test('<details> keeps working, a tag in a code span or a fence stays as written', async () => {
    const { article } = await mountViewer(
      ['<details><summary>More</summary>', '', '**text** inside', '', '</details>', '', 'A `<iframe src="x">` code span.', '', '```html', '<iframe src="x"></iframe>', '```'].join('\n'),
    );
    expect(article.querySelector('details summary')?.textContent).toBe('More');
    expect(article.querySelector('details strong')?.textContent).toBe('text');
    expect(article.querySelector('p code')?.textContent).toBe('<iframe src="x">');
    expect(article.querySelector('pre code')?.textContent).toContain('<iframe src="x"></iframe>');
    expect(article.querySelectorAll('iframe')).toHaveLength(0);
  });
});

describe.if(hasDom)('images', () => {
  test('a linked image is an image inside its link', async () => {
    const { article } = await mountViewer(`[![x](a.jpg)](${URL_BASE}/page)`);
    const link = article.querySelector('a');
    expect(link?.getAttribute('href')).toBe(`${URL_BASE}/page`);
    expect(link?.querySelector('img')?.getAttribute('alt')).toBe('x');
    expect(visibleText(article)).toBe('');
  });

  test('images alone in a paragraph or a list item draw as one row; one alone is height-capped', async () => {
    const { article } = await mountViewer(
      [
        '![a](a.jpg) ![b](b.jpg) ![c](c.jpg)',
        '',
        '![1](1.jpg) ![2](2.jpg)',
        '![3](3.jpg) ![4](4.jpg)',
        '![5](5.jpg) ![6](6.jpg) ![7](7.jpg)',
        '',
        '- ![l1](l1.jpg) ![l2](l2.jpg)',
        '',
        '![tall](tall.jpg)',
        '',
        `[![x](x.jpg)](${URL_BASE}/x) ![y](y.jpg)`,
      ].join('\n'),
    );
    const rows = Array.from(article.querySelectorAll<HTMLElement>('[data-image-row]'));
    expect(rows.map((el) => [el.tagName, el.dataset.imageRow, el.querySelectorAll('img').length])).toEqual([
      ['P', '3', 3],
      ['P', '7', 7],
      ['SPAN', '2', 2],
      ['P', '1', 1],
      ['P', '2', 2],
    ]);
    // A row wraps and gives every image one height; one alone keeps its width under a height cap.
    for (const row of rows.filter((el) => el.dataset.imageRow !== '1')) {
      expect(row.classList.contains('flex')).toBe(true);
      expect(row.classList.contains('flex-wrap')).toBe(true);
    }
    expect(rows[3]!.classList.contains('flex')).toBe(false);
    expect([...rows[3]!.classList].some((cls) => cls.includes('max-h-'))).toBe(true);
  });

  test('a row never enlarges an image: its height is only capped, so badges and icons keep their size', async () => {
    const { article } = await mountViewer('![build](badge.svg) ![tests](badge2.svg)\n\n![icon](i16.png)');
    const rows = Array.from(article.querySelectorAll<HTMLElement>('[data-image-row]'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const classes = [...row.classList];
      // No rule that sets an image's height (or a box) other than auto; only a max-height cap.
      expect(classes.filter((cls) => /^\[&_img\]:(h|min-h|size|aspect)-/.test(cls) && cls !== '[&_img]:h-auto')).toEqual([]);
      expect(classes.some((cls) => cls.startsWith('[&_img]:max-h-'))).toBe(true);
    }
  });

  test('a linked image in a row is one item of the row, its link around its image', async () => {
    const { article } = await mountViewer(`[![x](x.jpg)](${URL_BASE}/x) ![y](y.jpg) [![z](z.jpg)](${URL_BASE}/z)`);
    const row = article.querySelector<HTMLElement>('[data-image-row]')!;
    expect(row.dataset.imageRow).toBe('3');
    const items = Array.from(row.querySelectorAll('img'), (img) => {
      const item = img.parentElement === row ? img : img.closest('a');
      return [item?.parentElement === row, item?.tagName, item?.getAttribute('href') ?? null];
    });
    expect(items).toEqual([
      [true, 'A', `${URL_BASE}/x`],
      [true, 'IMG', null],
      [true, 'A', `${URL_BASE}/z`],
    ]);
  });

  test('an image in a sentence, in a table cell, or written as <img width> is left alone', async () => {
    const { article } = await mountViewer(
      ['An image ![m](m.jpg) mid-sentence.', '', '| a | b |', '|---|---|', '| ![t](t.jpg) | x |', '', '<img src="w.jpg" width="200">'].join('\n'),
    );
    expect(article.querySelectorAll('[data-image-row]')).toHaveLength(0);
    expect(article.querySelector('img[src$="w.jpg"]')?.getAttribute('width')).toBe('200');
  });
});

const OLD = JSON.parse(readFileSync(join(import.meta.dir, '../../../tests/test-fixtures/raw-html-old-anchors.json'), 'utf8')) as {
  docs: { name: string; markdown: string; annotation: Annotation }[];
};

const marks = (id: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-highlight-id="${id}"], [data-bind-id="${id}"]`));
const painted = (id: string): string => marks(id).map((el) => el.textContent ?? '').join('');
const paintedBlock = (id: string): string | undefined => marks(id)[0]?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;

describe.if(hasDom)('comments saved when raw HTML printed as text (measured on origin/main)', () => {
  for (const doc of OLD.docs) {
    test(doc.name, async () => {
      const reports: AnnotationRestoreReport[] = [];
      const { ref } = await mountViewer(doc.markdown, (r) => reports.push(r));
      const ann = doc.annotation;
      await act(async () => ref.current!.applySharedAnnotations([ann]));
      await settle();
      expect(painted(ann.id)).toBe(ann.originalText);
      // In the block it was made in (block ids are kept), not another copy of its words.
      expect(paintedBlock(ann.id)).toBe(ann.blockId);
      const last = reports.filter((r) => r.attempted.includes(ann.id)).at(-1)!;
      expect(last.unanchored).toEqual([]);
      expect(last.moved ?? []).toEqual([]);
    });
  }
});
