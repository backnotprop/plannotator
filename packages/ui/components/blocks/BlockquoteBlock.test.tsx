/**
 * A multi-paragraph quote renders as ONE quote: one `<blockquote>`, one bar,
 * the block id on it alone, and the quote's own markdown inside (a code fence
 * as a real code block, a list as a list, a nested quote as a quote).
 *
 * What regresses if this fails:
 * - a quote with a code fence splits into one bar segment per line, the
 *   fence shows as literal backticks and `@scope/pkg` in the command links as
 *   a mention (the reported Inbox question card);
 * - an inner block gets a `data-block-id` of its own, so a selection inside
 *   the quote resolves to an id no document block has;
 * - a comment on text inside the quote no longer restores, or the quote
 *   becomes a code-block pinpoint target (a click would annotate the fence
 *   alone);
 * - a plain prose quote stops rendering as one `<p>` per paragraph.
 *
 * Block ids are read from the parsed blocks, never written as literals:
 * Tailwind scans this package.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../../types';
import { parseMarkdownToBlocks } from '../../utils/parser';
import type { AnnotationRestoreReport } from '../../hooks/useAnnotationHighlighter';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const viewerMod = hasDom ? await import('../Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('../Viewer')['Viewer'];
const contextMod = hasDom ? await import('./QuestionContext') : null;
const QuestionContext = contextMod?.QuestionContext as typeof import('./QuestionContext')['QuestionContext'];
const targeting = hasDom ? await import('../../utils/blockTargeting') : null;

const QUOTE = [
  '> Thanks for reporting this. It works:',
  '>',
  '> ```',
  '> omp plugin install @plannotator/pi-extension',
  '> ```',
  '>',
  '> Then restart OMP.',
].join('\n');

const DOC = ['# Reply', '', QUOTE, '', 'After the quote.'].join('\n');

interface ViewerHandle {
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

async function mountViewer(markdown: string, reports: AnnotationRestoreReport[] = []) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const ref = React.createRef<ViewerHandle>();
  await act(async () => {
    root = createRoot(host!);
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
        taterMode={false}
        disableCodePathValidation
        onRestoreReport={(report) => reports.push(report)}
      />,
    );
  });
  return { host: host!, ref };
}

const quoteBlockId = (markdown: string): string => {
  const block = parseMarkdownToBlocks(markdown).find((b) => b.type === 'blockquote');
  if (!block) throw new Error('no quote block');
  return block.id;
};

describe.skipIf(!hasDom)('BlockquoteBlock in the Viewer', () => {
  test('the reported quote is one quote holding a real code block', async () => {
    const { host } = await mountViewer(DOC);
    const quotes = host.querySelectorAll('blockquote');
    expect(quotes).toHaveLength(1);
    const quote = quotes[0]!;
    expect(quote.getAttribute('data-block-id')).toBe(quoteBlockId(DOC));
    // Nothing inside claims a block id of its own.
    expect(quote.querySelectorAll('[data-block-id]')).toHaveLength(0);

    const pre = quote.querySelectorAll('pre');
    expect(pre).toHaveLength(1);
    expect(pre[0]!.textContent).toContain('omp plugin install @plannotator/pi-extension');
    // Code is code: no fence markers and no mention link inside it.
    expect(quote.textContent).not.toContain('```');
    expect(pre[0]!.querySelector('a')).toBeNull();

    const paragraphs = Array.from(quote.querySelectorAll(':scope > p')).map((p) => p.textContent);
    expect(paragraphs).toEqual(['Thanks for reporting this. It works:', 'Then restart OMP.']);
  });

  test('a prose quote renders one <p> per paragraph and nothing else', async () => {
    const md = '> first line\n> wraps here\n>\n> second paragraph';
    const { host } = await mountViewer(md);
    const quote = host.querySelector('blockquote')!;
    expect(Array.from(quote.children).map((c) => c.tagName)).toEqual(['P', 'P']);
    expect(quote.children[0]!.textContent).toContain('first line');
    expect(quote.children[1]!.textContent).toBe('second paragraph');
  });

  test('a list and a nested quote stay inside the one quote', async () => {
    const md = '> Steps:\n>\n> - install\n> - restart\n>\n> > nested note';
    const { host } = await mountViewer(md);
    const outer = host.querySelectorAll('[data-block-id]');
    expect(Array.from(outer).filter((el) => el.tagName === 'BLOCKQUOTE')).toHaveLength(1);
    const quote = host.querySelector('blockquote[data-block-id]')!;
    expect(quote.querySelectorAll('blockquote')).toHaveLength(1);
    expect(quote.querySelector('blockquote')!.textContent).toBe('nested note');
    expect(quote.textContent).toContain('install');
    expect(quote.textContent).not.toContain('- install');
  });

  test('an alert still renders as an alert', async () => {
    const { host } = await mountViewer('> [!NOTE]\n> Useful.\n>\n> More.');
    expect(host.querySelector('blockquote')).toBeNull();
    const alert = host.querySelector('[data-block-type="alert"]')!;
    expect(alert.getAttribute('data-alert-kind')).toBe('note');
  });

  test('comments on text in the quote and in its code block restore on the quote block', async () => {
    const reports: AnnotationRestoreReport[] = [];
    const { host, ref } = await mountViewer(DOC, reports);
    const blockId = quoteBlockId(DOC);
    const comment = (id: string, originalText: string): Annotation => ({
      id,
      blockId,
      startOffset: 0,
      endOffset: originalText.length,
      type: AnnotationType.COMMENT,
      text: 'note',
      originalText,
      createdA: 1,
    });
    await act(async () => {
      ref.current!.applySharedAnnotations([comment('annProse', 'Then restart OMP'), comment('annCode', 'plugin install')]);
    });
    const report = reports.at(-1)!;
    expect(report.unanchored).toEqual([]);
    expect(report.moved).toBeUndefined();
    const quote = host.querySelector('blockquote')!;
    const marks = Array.from(quote.querySelectorAll<HTMLElement>('mark'));
    const text = (id: string) => marks.filter((m) => m.dataset.bindId === id).map((m) => m.textContent).join('');
    expect(text('annProse')).toBe('Then restart OMP');
    expect(text('annCode')).toBe('plugin install');
    expect(marks.find((m) => m.dataset.bindId === 'annCode')!.closest('pre')).not.toBeNull();
  });

  test('pinpoint and vim see the quote as one text block, not a code block', async () => {
    const { host } = await mountViewer(DOC);
    const graph = targeting!.buildSemanticTargetGraph(host);
    const quoteTargets = graph.targets.filter((t) => t.blockId === quoteBlockId(DOC) && graph.blockKeys.includes(t.key));
    expect(quoteTargets.map((t) => t.kind)).toEqual(['block']);
  });
});

describe.skipIf(!hasDom)('BlockquoteBlock in a question card context', () => {
  test('the context renders the quote as one quote with a code block, without block ids', async () => {
    const markdown = ['Before the quote.', '', QUOTE].join('\n');
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<QuestionContext id="ctx" markdown={markdown} />);
    });
    const context = host.querySelector('[data-question-part="context"]')!;
    const quotes = context.querySelectorAll('blockquote');
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.querySelectorAll('pre')).toHaveLength(1);
    expect(quotes[0]!.textContent).not.toContain('```');
    expect(context.querySelectorAll('[data-block-id]')).toHaveLength(0);
  });
});
