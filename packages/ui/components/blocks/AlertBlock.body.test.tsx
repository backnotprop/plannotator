import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../../types';

const hasDom = typeof document !== 'undefined';

const hookMod = hasDom ? await import('../../hooks/useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  hookMod?.useAnnotationHighlighter as typeof import('../../hooks/useAnnotationHighlighter')['useAnnotationHighlighter'];
type HookReturn = import('../../hooks/useAnnotationHighlighter').UseAnnotationHighlighterReturn;
const alertMod = hasDom ? await import('./AlertBlock') : null;
const AlertBlock = alertMod?.AlertBlock as typeof import('./AlertBlock')['AlertBlock'];
const blockquoteMod = hasDom ? await import('./BlockquoteBlock') : null;
const MAX_QUOTE_DEPTH = blockquoteMod?.MAX_QUOTE_DEPTH ?? 0;

const FENCED = 'Run this first:\n\n```bash\nplannotator update --check\n```';

function Harness({ resultRef, added, body }: { resultRef: { current: HookReturn | null }; added: Annotation[]; body: string }) {
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
      <AlertBlock blockId="alert-1" kind="note" body={body} />
    </div>
  );
}

let root: Root | null = null;

async function mount(body: string, added: Annotation[] = []): Promise<{ current: HookReturn | null }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookReturn | null } = { current: null };
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness resultRef={resultRef} added={added} body={body} />);
  });
  return resultRef;
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  if (hasDom) document.body.innerHTML = '';
});

const alert = () => document.querySelector<HTMLElement>('[data-block-type="alert"]')!;

describe('a callout body with block structure', () => {
  test.skipIf(!hasDom)('a fence renders as a code block, not as fence characters, and the callout stays one block', async () => {
    await mount(FENCED);
    expect(alert().querySelector('pre')?.textContent).toContain('plannotator update --check');
    expect(alert().textContent).not.toContain('```');
    expect(alert().textContent).toContain('Run this first:');
    expect(Array.from(document.querySelectorAll('[data-block-id]')).map((el) => el.getAttribute('data-block-id'))).toEqual(['alert-1']);
  });

  test.skipIf(!hasDom)('after a title line, the fence renders in the body', async () => {
    await mount('**Heads up**\n\n```ts\nconst a = 1;\n```');
    expect(alert().querySelector('.alert-title')?.textContent).toContain('Heads up');
    expect(alert().querySelector('.alert-body pre')?.textContent).toContain('const a = 1;');
  });

  test.skipIf(!hasDom)('a callout of paragraphs and a list keeps its prose rendering', async () => {
    await mount('One line.\n\n- a\n- b');
    expect(alert().querySelector('.pn-quote-body')).toBeNull();
    expect(Array.from(alert().querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a', 'b']);
  });

  test.skipIf(!hasDom)('a comment on the words of a callout that holds a fence anchors to the callout', async () => {
    const added: Annotation[] = [];
    const hook = await mount(FENCED, added);
    const text = Array.from(alert().querySelectorAll('p'))
      .map((p) => p.firstChild)
      .find((node) => node?.textContent?.includes('Run this first'));
    if (!text) throw new Error('Callout body did not render its paragraph');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'Run this first'.length);
    await act(async () => { hook.current!.highlightRange(range); });
    await act(async () => { hook.current!.handleCommentSubmit('why first?'); });

    expect(added).toHaveLength(1);
    expect(added[0]!.blockId).toBe('alert-1');
    expect(added[0]!.originalText).toBe('Run this first');
  });

  test.skipIf(!hasDom)('callouts nested hundreds deep stop at MAX_QUOTE_DEPTH, as quotes do', async () => {
    const levels = 300;
    const body = Array.from({ length: levels }, (_, i) => `${'> '.repeat(i + 1)}[!NOTE]`)
      .concat(`${'> '.repeat(levels + 1)}deepest`)
      .join('\n');
    await mount(body);
    const alerts = document.querySelectorAll('[data-block-type="alert"]');
    expect(alerts.length).toBe(MAX_QUOTE_DEPTH);
    expect(alerts[alerts.length - 1]!.textContent).toContain('[!NOTE]');
    expect(alerts[alerts.length - 1]!.textContent).toContain('deepest');
  });
});
