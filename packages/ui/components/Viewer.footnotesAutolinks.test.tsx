/**
 * Footnote references, `www.`/e-mail autolinks and character references in
 * the plan Viewer, and the comments people already saved on such text.
 *
 * Before these were drawn, `[^1]`, `www.example.org`, `someone@example.com`
 * and `&amp;` rendered as the literal text. A comment saved then holds
 * web-highlighter metas (`parentTagName`/`parentIndex`/`textOffset`) counted
 * in THAT page, and a quote that may hold `[^1]` or `&amp;` as written. The
 * anchors below are written by hand in that old shape; each must still paint
 * exactly its words. New selections across a link or a reference must make
 * comments that restore too.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

// Each paragraph as the OLD renderer showed it: its source, character for character.
const PARA_A = 'Here is a claim with a footnote.[^1] And another claim.[^note] Then more words.';
const PARA_B = 'Visit www.example.org and mail someone@example.com today, then https://example.com/docs for more.';
const PARA_C = 'Example &amp; Co is a name with an entity in it.';
const MARKDOWN = ['# Title', '', PARA_A, '', PARA_B, '', PARA_C, '', '[^1]: The first note.', '[^note]: A named note.'].join('\n');

interface ViewerHandle {
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

const roots: Root[] = [];

async function mount(onAdd: (a: Annotation) => void = () => {}): Promise<{ ref: React.RefObject<ViewerHandle | null>; host: HTMLElement }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ref = React.createRef<ViewerHandle>();
  await act(async () => {
    const root = createRoot(host);
    roots.push(root);
    root.render(
      <Viewer
        ref={ref as never}
        blocks={parseMarkdownToBlocks(MARKDOWN)}
        markdown={MARKDOWN}
        annotations={[]}
        onAddAnnotation={onAdd}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        inputMethod="drag"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
      />,
    );
  });
  await settle();
  return { ref, host };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const paragraphs = (host: HTMLElement) => Array.from(host.querySelector('article')!.getElementsByTagName('p'));

/** The index the old page gave the paragraph that starts with `start`: no `<p>` was added before it. */
const oldParagraphIndex = (host: HTMLElement, start: string): number => {
  const index = paragraphs(host).findIndex((p) => (p.textContent ?? '').startsWith(start));
  if (index === -1) throw new Error(`paragraph "${start}" did not render`);
  return index;
};

/** A comment saved on the old page: metas counted in `oldText`, the quote as the old page showed it. */
function oldAnchor(id: string, parentIndex: number, oldText: string, quote: string, parentTagName = 'P'): Annotation {
  const at = oldText.indexOf(quote);
  if (at === -1) throw new Error(`"${quote}" is not in the old text`);
  return {
    id,
    blockId: 'oldBlock',
    startOffset: at,
    endOffset: at + quote.length,
    type: AnnotationType.COMMENT,
    text: 'a comment',
    originalText: quote,
    createdA: 1,
    startMeta: { parentTagName, parentIndex, textOffset: at },
    endMeta: { parentTagName, parentIndex, textOffset: at + quote.length },
  };
}

const painted = (id: string): string =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-highlight-id="${id}"], [data-bind-id="${id}"]`))
    .map((el) => el.textContent ?? '')
    .join('');

describe.if(hasDom)('comments saved before footnotes and autolinks were drawn', () => {
  test('a quote after a reference (its offsets moved) restores on its words', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('afterRef', oldParagraphIndex(host, 'Here is'), PARA_A, 'Then more words');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('afterRef')).toBe('Then more words');
  });

  test('a quote that held the reference as written restores on the words and the number', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('acrossRef', oldParagraphIndex(host, 'Here is'), PARA_A, 'a footnote.[^1] And another');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('acrossRef')).toBe('a footnote.1 And another');
  });

  test('a quote across text that is now a www. link and a mail link restores as it was saved', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('acrossLinks', oldParagraphIndex(host, 'Visit'), PARA_B, 'www.example.org and mail someone@example');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('acrossLinks')).toBe('www.example.org and mail someone@example');
  });

  test('a quote inside a link that now has new links before it is found again', async () => {
    const { ref } = await mount();
    // On the old page https://example.com/docs was the document's first <a>.
    const old = oldAnchor('inLink', 0, 'https://example.com/docs', 'example.com/docs', 'A');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('inLink')).toBe('example.com/docs');
  });

  test('a quote that held &amp; as written restores on the character', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('entity', oldParagraphIndex(host, 'Example'), PARA_C, 'Example &amp; Co');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('entity')).toBe('Example & Co');
  });

  test('a comment on the old definition paragraph finds its words in the notes list', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('noteText', oldParagraphIndex(host, 'Example') + 1, '[^1]: The first note.\n[^note]: A named note.', 'The first note');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('noteText')).toBe('The first note');
    expect(document.querySelector('[data-highlight-id="noteText"], [data-bind-id="noteText"]')!.closest('[data-footnotes]')).not.toBeNull();
  });
});

async function selectBetween(host: HTMLElement, from: string, fromAt: string, to: string, toAt: string): Promise<void> {
  const find = (needle: string): Text => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(needle)) return n as Text;
    throw new Error(`no text node with "${needle}"`);
  };
  const start = find(from);
  const end = find(to);
  const range = document.createRange();
  range.setStart(start, start.textContent!.indexOf(fromAt));
  range.setEnd(end, end.textContent!.indexOf(toAt) + toAt.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    host.querySelector('article')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!textarea) throw new Error('composer did not open');
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set?.call(textarea, 'why?');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  });
  await settle();
}

describe.if(hasDom)('new comments across a reference or a link', () => {
  test('a selection across a footnote reference and one across links comment and restore after a reload', async () => {
    const added: Annotation[] = [];
    const first = await mount((a) => added.push(a));
    await selectBetween(first.host, 'with a footnote.', 'footnote.', ' And another claim.', 'And another');
    await selectBetween(first.host, 'Visit ', 'Visit', ' and mail ', 'and mail');
    expect(added.map((a) => a.originalText)).toEqual(['footnote.1 And another', 'Visit www.example.org and mail']);

    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();
    const second = await mount();
    await act(async () => second.ref.current!.applySharedAnnotations(added));
    expect(added.map((a) => painted(a.id))).toEqual(['footnote.1 And another', 'Visit www.example.org and mail']);
  });
});

describe.if(hasDom)('footnote navigation', () => {
  test('a reference moves focus to its note, the back link returns to that reference; two documents keep their own ids', async () => {
    const a = await mount();
    const b = await mount();
    const ids = Array.from(document.querySelectorAll('[data-footnotes] li')).map((li) => li.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);

    const refs = Array.from(b.host.querySelectorAll<HTMLAnchorElement>('a[data-footnote-ref]'));
    expect(refs.map((r) => r.textContent)).toEqual(['1', '2']);
    const note = b.host.querySelector<HTMLElement>(refs[1].getAttribute('href')!)!;
    expect(b.host.contains(note)).toBe(true);
    await act(async () => { refs[1].click(); });
    expect(document.activeElement).toBe(note);

    await act(async () => { note.querySelector<HTMLAnchorElement>('a[role="doc-backlink"]')!.click(); });
    expect(document.activeElement).toBe(refs[1]);
    expect(a.host.contains(document.activeElement)).toBe(false);
  });
});
