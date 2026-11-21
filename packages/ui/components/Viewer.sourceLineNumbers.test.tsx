/**
 * Optional source-line gutter on the REAL Viewer (DOM-gated, DOM_TESTS=1).
 *
 * Failures to catch: a label adding an element or text to a block; a multi-line
 * paragraph is not `start–end`; a one-line block is not `start`; a code fence
 * or table grows a number per visual line; the label joins copied HTML or a
 * new annotation's quote.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { configStore } from '../config';
import { formatBlockSourceLineLabel, parseMarkdownToBlocks } from '../utils/parser';
import { selectionRangeToHtml } from '../utils/richClipboard';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;

const DOC = [
  '# Title',
  '',
  'This paragraph spans',
  'two source lines.',
  '',
  'One line.',
  '',
  '- Alpha item',
  '- Bravo item',
  '',
  '```ts',
  'const n = 1;',
  'const y = 2;',
  '```',
  '',
  '| Col | Val |',
  '| --- | --- |',
  '| a | 1 |',
].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  configStore.set('documentSourceLineNumbers', false);
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function mount(onAddAnnotation: (annotation: Annotation) => void = () => {}): Promise<HTMLElement> {
  const Viewer = viewerModule!.Viewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parseMarkdownToBlocks(DOC)}
        markdown={DOC}
        annotations={[]}
        onAddAnnotation={onAddAnnotation}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="redline"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
      />,
    );
  });
  await settle();
  const article = host.querySelector<HTMLElement>('article[data-print-region="article"]');
  if (!article) throw new Error('Viewer did not render its annotation container');
  return article;
}

/** The label a block carries (drawn by theme.css as the block's ::before). */
function labelOf(scope: ParentNode, blockId: string): string | null {
  return scope.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)?.getAttribute('data-doc-source-line') ?? null;
}

async function selectPhrase(scope: HTMLElement, phrase: string): Promise<string> {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent?.includes(phrase)) {
      node = n as Text;
      break;
    }
  }
  if (!node) throw new Error(`phrase "${phrase}" not found`);
  const at = node.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const selected = window.getSelection()!.toString();
  await act(async () => {
    (node.parentElement!.closest('article') ?? scope).dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, cancelable: true }),
    );
  });
  await settle();
  return selected;
}

describe.if(hasDom)('Viewer source line numbers', () => {
  test('a label adds no element and no text: each block reads exactly as before', async () => {
    configStore.set('documentSourceLineNumbers', true);
    const article = await mount();
    const labelled = [...article.querySelectorAll<HTMLElement>('[data-doc-source-line]')];
    expect(labelled.length).toBeGreaterThan(0);
    for (const el of labelled) expect(el.hasAttribute('data-block-id')).toBe(true);
    const single = parseMarkdownToBlocks(DOC).find((b) => b.content === 'One line.')!;
    const para = article.querySelector<HTMLElement>(`[data-block-id="${single.id}"]`)!;
    expect(para.textContent).toBe('One line.');
    expect(para.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });

  test('on: a span is start–end, a single line is start, code and tables get one label', async () => {
    configStore.set('documentSourceLineNumbers', true);
    const article = await mount();
    const blocks = parseMarkdownToBlocks(DOC);
    const heading = blocks.find((b) => b.type === 'heading')!;
    const multi = blocks.find((b) => b.content.startsWith('This paragraph'))!;
    const single = blocks.find((b) => b.content === 'One line.')!;
    const code = blocks.find((b) => b.type === 'code')!;
    const table = blocks.find((b) => b.type === 'table')!;
    const items = blocks.filter((b) => b.type === 'list-item');

    expect(labelOf(article, heading.id)).toBe(
      formatBlockSourceLineLabel(heading),
    );
    expect(formatBlockSourceLineLabel(multi)).toMatch(/^\d+–\d+$/);
    expect(labelOf(article, multi.id)).toBe(
      formatBlockSourceLineLabel(multi),
    );
    expect(formatBlockSourceLineLabel(single)).toMatch(/^\d+$/);
    expect(labelOf(article, single.id)).toBe(
      formatBlockSourceLineLabel(single),
    );

    expect(items.length).toBe(2);
    for (const block of [code, table, ...items]) {
      expect(labelOf(article, block.id)).toBe(formatBlockSourceLineLabel(block));
      expect(article.querySelectorAll(`[data-block-id="${block.id}"] [data-doc-source-line]`)).toHaveLength(0);
    }
  });

  test('labels stay out of copied HTML and a new annotation still quotes the selected text', async () => {
    configStore.set('documentSourceLineNumbers', true);
    const made: Annotation[] = [];
    const article = await mount((a) => made.push(a));
    const blocks = parseMarkdownToBlocks(DOC);
    const multi = blocks.find((b) => b.content.startsWith('This paragraph'))!;
    const para = article.querySelector<HTMLElement>(`[data-block-id="${multi.id}"]`)!;
    const label = labelOf(article, multi.id)!;

    const range = document.createRange();
    range.selectNodeContents(para);
    const html = selectionRangeToHtml(range);
    expect(html).not.toBeNull();
    expect(html).not.toContain(label);
    expect(html).not.toContain('data-doc-source-line');

    const selected = await selectPhrase(para, 'two source lines');
    expect(selected).toBe('two source lines');
    expect(made).toHaveLength(1);
    expect(made[0]!.originalText).toBe('two source lines');
    expect(made[0]!.blockId).toBe(multi.id);
    expect(made[0]!.type).toBe(AnnotationType.DELETION);
  });
});
