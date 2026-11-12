import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../../types';
import { fromShareable, toShareable } from '../../utils/sharing';

const hasDom = typeof document !== 'undefined';

const hookMod = hasDom ? await import('../../hooks/useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  hookMod?.useAnnotationHighlighter as typeof import('../../hooks/useAnnotationHighlighter')['useAnnotationHighlighter'];
type HookReturn = import('../../hooks/useAnnotationHighlighter').UseAnnotationHighlighterReturn;
const alertMod = hasDom ? await import('./AlertBlock') : null;
const AlertBlock = alertMod?.AlertBlock as typeof import('./AlertBlock')['AlertBlock'];

const BODY = '**Browser quirks**\n\nSafari drops the label when ALPHA happens.';

function Harness({ resultRef, added, body, lead }: {
  resultRef: { current: HookReturn | null };
  added: Annotation[];
  body: string;
  lead?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  resultRef.current = useAnnotationHighlighter({
    containerRef,
    annotations: [],
    onAddAnnotation: (ann) => { added.push(ann); },
    selectedAnnotationId: null,
    mode: 'comment',
    verifyRestoredContent: true,
  });
  return (
    <div ref={containerRef}>
      {lead ? <p data-block-id="p-0">{lead}</p> : null}
      <AlertBlock blockId="alert-1" kind="tip" body={body} />
      <p data-block-id="p-1">Trailing paragraph BRAVO.</p>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(
  added: Annotation[],
  options: { body?: string; lead?: string } = {},
): Promise<{ current: HookReturn | null }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookReturn | null } = { current: null };
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Harness
        resultRef={resultRef}
        added={added}
        body={options.body ?? BODY}
        lead={options.lead}
      />,
    );
  });
  return resultRef;
}

const compact = (value: string): string => value.replace(/\s+/g, '');

const paintedText = (): string =>
  Array.from(document.querySelectorAll('mark.annotation-highlight'))
    .map((el) => el.textContent ?? '')
    .join('');

const textNodeWith = (selector: string, needle: string): Text => {
  const walkerRoot = Array.from(document.querySelectorAll(selector))
    .find((el) => (el.textContent ?? '').includes(needle));
  if (!walkerRoot) throw new Error(`Fixture no longer renders "${needle}" under ${selector}`);
  const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.textContent ?? '').includes(needle)) return node as Text;
  }
  throw new Error(`Fixture no longer holds "${needle}" in one text node`);
};

const hiddenTypeWord = (): Text => {
  const node = document.querySelector('.alert-title .sr-only')?.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    throw new Error('Expected the title row to render its hidden type word');
  }
  return node as Text;
};

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

function titleRowRange(): Range {
  const srOnly = document.querySelector('.alert-title .sr-only');
  const titleText = Array.from(document.querySelectorAll('.alert-title span'))
    .map((el) => el.lastChild)
    .find((node) => node?.nodeType === Node.TEXT_NODE && node.textContent?.includes('Browser quirks'));
  if (!srOnly?.firstChild || !titleText) throw new Error('Expected the title row to render its hidden type word and title');
  const range = document.createRange();
  range.setStart(srOnly.firstChild, 0);
  range.setEnd(titleText, titleText.textContent!.length);
  return range;
}

describe('alert title annotations', () => {
  test.skipIf(!hasDom)('a selection from the icon does not quote the hidden type word', async () => {
    const added: Annotation[] = [];
    const hook = await mount(added);
    await act(async () => { hook.current!.highlightRange(titleRowRange()); });
    await act(async () => { hook.current!.handleCommentSubmit('tighten this'); });

    expect(added).toHaveLength(1);
    expect(added[0]!.originalText).toBe('Browser quirks');
    expect(document.querySelector('.sr-only mark')).toBeNull();
  });

  test.skipIf(!hasDom)('an ordinary selection keeps its quote byte for byte', async () => {
    const added: Annotation[] = [];
    const hook = await mount(added);
    const body = Array.from(document.querySelectorAll('p'))
      .find((p) => (p.textContent ?? '').includes('ALPHA'));
    const text = body?.firstChild;
    if (!text) throw new Error('Alert body did not render');
    const start = text.textContent!.indexOf('Safari');
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, text.textContent!.length);
    await act(async () => { hook.current!.highlightRange(range); });
    await act(async () => { hook.current!.handleCommentSubmit('why?'); });

    expect(added[0]!.originalText).toBe('Safari drops the label when ALPHA happens.');
  });

  test.skipIf(!hasDom)('a drag from the icon through the body paints the title too', async () => {
    const added: Annotation[] = [];
    const hook = await mount(added);
    const body = textNodeWith('.alert-body p', 'Safari');
    const range = document.createRange();
    range.setStart(hiddenTypeWord(), 0);
    range.setEnd(body, body.length);
    await act(async () => { hook.current!.highlightRange(range); });
    await act(async () => { hook.current!.handleCommentSubmit('rewrite this'); });

    expect(paintedText()).toBe('Browser quirksSafari drops the label when ALPHA happens.');
    expect(added[0]!.originalText).not.toContain('Tip');
    expect(compact(added[0]!.originalText)).toBe(compact(paintedText()));
  });

  test.skipIf(!hasDom)('a title carrying inline markup is painted whole', async () => {
    const added: Annotation[] = [];
    const hook = await mount(added, { body: '**Browser `quirks` here**\n\nSafari drops the label when ALPHA happens.' });
    const lastTitleText = textNodeWith('.alert-title', ' here');
    const range = document.createRange();
    range.setStart(hiddenTypeWord(), 0);
    range.setEnd(lastTitleText, lastTitleText.length);
    await act(async () => { hook.current!.highlightRange(range); });
    await act(async () => { hook.current!.handleCommentSubmit('rename this'); });

    expect(paintedText()).toBe('Browser quirks here');
    expect(added[0]!.originalText).not.toContain('Tip');
  });

  test.skipIf(!hasDom)('body prose that repeats the type word keeps it', async () => {
    const added: Annotation[] = [];
    const hook = await mount(added, { lead: 'Tip: read the lead-in first.' });
    const lead = textNodeWith('p[data-block-id="p-0"]', 'lead-in');
    const title = textNodeWith('.alert-title', 'Browser quirks');
    const range = document.createRange();
    range.setStart(lead, 0);
    range.setEnd(title, title.length);
    await act(async () => { hook.current!.highlightRange(range); });
    await act(async () => { hook.current!.handleCommentSubmit('tie these together'); });

    expect(paintedText()).toBe('Tip: read the lead-in first.Browser quirks');
    expect(added[0]!.originalText).toContain('Tip: read the lead-in first.');
    expect(compact(added[0]!.originalText)).toBe(compact(paintedText()));
  });

  test.skipIf(!hasDom)('a share link of that annotation restores onto the title', async () => {
    const added: Annotation[] = [];
    const first = await mount(added);
    await act(async () => { first.current!.highlightRange(titleRowRange()); });
    await act(async () => { first.current!.handleCommentSubmit('tighten this'); });
    const shared = fromShareable(toShareable(added));
    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();
    document.body.innerHTML = '';

    const second = await mount([]);
    await act(async () => { second.current!.applyAnnotations(shared); });

    const mark = document.querySelector<HTMLElement>(`[data-bind-id="${shared[0]!.id}"], [data-highlight-id="${shared[0]!.id}"]`);
    expect(mark?.textContent).toBe('Browser quirks');
    expect(mark?.closest('.alert-title')).not.toBeNull();
  });
});
