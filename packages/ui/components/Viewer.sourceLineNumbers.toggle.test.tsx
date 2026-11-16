/**
 * Turning Source line numbers on or off over a painted document (DOM-gated,
 * DOM_TESTS=1).
 *
 * Failures to catch: flipping the switch while a comment's highlight covers a
 * block's first character inserts a node in front of the text the highlighter
 * already moved into its <mark> (the last block of a comment across blocks:
 * web-highlighter wraps that block's own first text node), React's
 * insertBefore throws and the whole document unmounts. A host that never opts
 * in (the Inbox, code review: the setting's cookie is shared across ports)
 * showing labels; labels showing outside the Viewer's article (the plan diff,
 * code review's preview), where their numbers count from the wrong line.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { type Annotation } from '../types';
import { configStore } from '../config';
import { parseMarkdownToBlocks } from '../utils/parser';
import { useDocumentSourceLineNumbers } from '../hooks/useDocumentSourceLineNumbers';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const blockRendererModule = hasDom ? await import('./BlockRenderer') : null;
const THEME_CSS = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');

const DOC = ['# Title', '', 'First paragraph here.', '', 'Second paragraph here.'].join('\n');
const BLOCKS = parseMarkdownToBlocks(DOC);
const FIRST = BLOCKS.find((b) => b.content.startsWith('First'))!;
const SECOND = BLOCKS.find((b) => b.content.startsWith('Second'))!;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  configStore.set('documentSourceLineNumbers', false);
  if (hasDom) {
    document.head.querySelector('style[data-test-theme]')?.remove();
    document.documentElement.removeAttribute('data-doc-source-lines');
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

/** A host that opts in, as plan review and annotate do. */
function OptedIn({ children }: { children: React.ReactNode }) {
  useDocumentSourceLineNumbers();
  return <>{children}</>;
}

function Harness() {
  const Viewer = viewerModule!.Viewer;
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  return (
    <Viewer
      blocks={BLOCKS}
      markdown={DOC}
      annotations={annotations}
      onAddAnnotation={(a) => setAnnotations((prev) => [...prev, a])}
      onSelectAnnotation={() => {}}
      selectedAnnotationId={null}
      mode="redline"
      taterMode={false}
      stickyActions={false}
      disableCodePathValidation
    />
  );
}

async function mount(node: React.ReactNode = <Harness />): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await settle();
  const article = host.querySelector<HTMLElement>('article[data-print-region="article"]');
  if (!article) throw new Error('Viewer did not render its annotation container');
  return article;
}

function firstText(article: HTMLElement, blockId: string): Text {
  const block = article.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)!;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.textContent ?? '').length > 0) return n as Text;
  }
  throw new Error(`block ${blockId} has no text`);
}

/** Select from one block's text to another's and let the Viewer make a comment from it. */
async function comment(article: HTMLElement, from: { blockId: string; at: number }, to: { blockId: string; at: number }) {
  const range = document.createRange();
  range.setStart(firstText(article, from.blockId), from.at);
  range.setEnd(firstText(article, to.blockId), to.at);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const markIn = (article: HTMLElement, blockId: string) =>
  article.querySelector(`[data-block-id="${blockId}"] mark`)?.textContent ?? null;

function injectTheme(): void {
  const style = document.createElement('style');
  style.setAttribute('data-test-theme', '');
  style.textContent = THEME_CSS;
  document.head.appendChild(style);
}

/** The label's display under the real theme.css. happy-dom keeps an
 *  element's computed style across an ancestor's attribute change, so this
 *  reads a fresh twin in the same place (same parent, same attributes). */
function displayOf(el: HTMLElement): string {
  const twin = el.cloneNode(false) as HTMLElement;
  el.after(twin);
  const display = getComputedStyle(twin).display;
  twin.remove();
  return display;
}

async function flip(value: boolean) {
  await act(async () => { configStore.set('documentSourceLineNumbers', value); });
  await settle();
}

describe.if(hasDom)('Source line numbers toggled over painted comments', () => {
  test('a comment across two paragraphs survives turning the switch on and off', async () => {
    configStore.set('documentSourceLineNumbers', false);
    const article = await mount();

    await comment(article, { blockId: FIRST.id, at: 6 }, { blockId: SECOND.id, at: 'Second'.length });
    expect(markIn(article, FIRST.id)).toBe('paragraph here.');
    expect(markIn(article, SECOND.id)).toBe('Second');

    await flip(true);
    expect(article.isConnected).toBe(true);
    expect(host!.querySelector('article[data-print-region="article"]')).toBe(article);
    expect(markIn(article, SECOND.id)).toBe('Second');
    expect(article.querySelector(`[data-block-id="${SECOND.id}"]`)?.textContent).toBe('Second paragraph here.');

    await flip(false);
    expect(article.isConnected).toBe(true);
    expect(markIn(article, FIRST.id)).toBe('paragraph here.');
    expect(markIn(article, SECOND.id)).toBe('Second');
  });

  test('a comment starting at a paragraph\'s first character survives the switch', async () => {
    configStore.set('documentSourceLineNumbers', false);
    const article = await mount();

    await comment(article, { blockId: SECOND.id, at: 0 }, { blockId: SECOND.id, at: 'Second'.length });
    expect(markIn(article, SECOND.id)).toBe('Second');

    await flip(true);
    expect(article.isConnected).toBe(true);
    expect(markIn(article, SECOND.id)).toBe('Second');
    await flip(false);
    expect(article.isConnected).toBe(true);
    expect(markIn(article, SECOND.id)).toBe('Second');
  });

  test('a host that does not opt in shows no labels even with the setting on', async () => {
    injectTheme();
    configStore.set('documentSourceLineNumbers', true);
    const article = await mount();

    const label = article.querySelector<HTMLElement>(`[data-block-id="${SECOND.id}"] [data-doc-source-line]`)!;
    expect(label).not.toBeNull();
    expect(document.documentElement.hasAttribute('data-doc-source-lines')).toBe(false);
    expect(displayOf(label)).toBe('none');
  });

  test('plan review and annotate opt in: labels show in the Viewer only while the setting is on', async () => {
    injectTheme();
    const BlockRenderer = blockRendererModule!.BlockRenderer;
    configStore.set('documentSourceLineNumbers', true);
    const article = await mount(
      <OptedIn>
        <Harness />
        <div data-outside-viewer=""><BlockRenderer block={SECOND} /></div>
      </OptedIn>,
    );
    const label = article.querySelector<HTMLElement>(`[data-block-id="${SECOND.id}"] [data-doc-source-line]`)!;
    const outside = host!.querySelector<HTMLElement>('[data-outside-viewer] [data-doc-source-line]')!;

    expect(document.documentElement.hasAttribute('data-doc-source-lines')).toBe(true);
    expect(displayOf(label)).toBe('block');
    expect(displayOf(outside)).toBe('none');
    expect(article.querySelector(`[data-block-id="${SECOND.id}"]`)?.textContent).toBe('Second paragraph here.');

    await flip(false);
    expect(document.documentElement.hasAttribute('data-doc-source-lines')).toBe(false);
    expect(displayOf(label)).toBe('none');

    await flip(true);
    expect(displayOf(label)).toBe('block');
    await act(async () => root?.unmount());
    root = null;
    expect(document.documentElement.hasAttribute('data-doc-source-lines')).toBe(false);
  });
});
