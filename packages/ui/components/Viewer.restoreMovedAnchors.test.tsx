/**
 * The restore report says where a comment's text is NOW.
 *
 * Block ids are positional (`block-N`), so after the document changed a
 * comment's stored `blockId` can name another block while its text sits
 * elsewhere; the export turns `blockId` into a line label. The highlighter's
 * restore report therefore lists, under `moved`, each comment whose stored
 * block no longer holds its text — with the block the text landed in, or ''
 * when the text is gone — and lists nothing for an unchanged document. A
 * comment that nothing could paint (no positions to try, quote not found) is
 * reported unanchored too. Rows that are not text highlights (diff-view
 * comments, checkbox toggles) are skipped outright, so their blockId is
 * never reported for rewriting.
 *
 * Block ids are built from the parsed blocks or at runtime, never written as
 * literals: Tailwind scans this package, and a literal that parses as a
 * utility leaks a rule into the guides.show viewer's CSS.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in web-highlighter, whose UMD bundle reads `window` at
// module-eval time; import lazily (same pattern as Viewer.consumer.test).
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

interface ViewerHandle {
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function restore(markdown: string, annotations: Annotation[]): Promise<AnnotationRestoreReport[]> {
  const reports: AnnotationRestoreReport[] = [];
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
  await act(async () => { ref.current!.applySharedAnnotations(annotations); });
  return reports;
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

const ORIGINAL = ['# Notes', '', 'The retry loop is slow.', '', 'Cache keys collide.'].join('\n');

const blockIdOf = (markdown: string, needle: string): string => {
  const block = parseMarkdownToBlocks(markdown).find((b) => b.content.includes(needle));
  if (!block) throw new Error(`no block holds "${needle}"`);
  return block.id;
};

/** Made on ORIGINAL: "The retry loop" in its block, the first `<p>`. */
const retry = (overrides: Partial<Annotation> = {}): Annotation => ({
  id: 'annRetry',
  blockId: blockIdOf(ORIGINAL, 'The retry loop'),
  startOffset: 0,
  endOffset: 14,
  type: AnnotationType.COMMENT,
  text: 'exponential?',
  originalText: 'The retry loop',
  createdA: 1,
  startMeta: { parentTagName: 'P', parentIndex: 0, textOffset: 0 },
  endMeta: { parentTagName: 'P', parentIndex: 0, textOffset: 14 },
  ...overrides,
});

describe.skipIf(!hasDom)('restore report: moved anchors', () => {
  test('an unchanged document reports nothing moved', async () => {
    const reports = await restore(ORIGINAL, [retry()]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.unanchored).toEqual([]);
    expect(reports[0]!.moved).toBeUndefined();
  });

  test('a heading inserted above shifts the block id; the verified positions are kept', async () => {
    // The `<p>` census is unchanged, so the stored positions still paint the
    // right text, but the stored id now names the inserted heading.
    const edited = ['# Notes', '', '## Inserted', '', 'The retry loop is slow.', '', 'Cache keys collide.'].join('\n');
    const reports = await restore(edited, [retry()]);
    expect(reports[0]!.moved).toEqual([
      { id: 'annRetry', blockId: blockIdOf(edited, 'The retry loop'), startOffset: 0, positionsStale: false },
    ]);
  });

  test('positions that missed are reported stale, with the block the text was found in', async () => {
    const edited = ['# Notes', '', 'A new first paragraph.', '', 'Now: The retry loop is slow.'].join('\n');
    const reports = await restore(edited, [retry()]);
    expect(reports[0]!.unanchored).toEqual([]);
    expect(reports[0]!.moved).toEqual([
      { id: 'annRetry', blockId: blockIdOf(edited, 'The retry loop'), startOffset: 5, positionsStale: true },
    ]);
  });

  test('a comment with no positions whose text is gone is unanchored and moved to no block', async () => {
    const edited = ['# Notes', '', 'Everything was rewritten.'].join('\n');
    const reports = await restore(edited, [retry({ startMeta: undefined, endMeta: undefined })]);
    expect(reports[0]!.unanchored).toEqual(['annRetry']);
    expect(reports[0]!.moved).toEqual([{ id: 'annRetry', blockId: '', positionsStale: true }]);
  });

  test('a quote the stored block still holds is not moved, even when it is painted elsewhere', async () => {
    // Duplicate text: the search paints the first occurrence, but the stored
    // block still says "The retry loop", so its label is still true.
    const doc = ['# Notes', '', 'The retry loop, first.', '', 'The retry loop, second.'].join('\n');
    const reports = await restore(doc, [
      retry({ blockId: blockIdOf(doc, 'second'), startMeta: undefined, endMeta: undefined }),
    ]);
    expect(reports[0]!.moved).toBeUndefined();
  });

  test('diff-view comments and checkbox toggles are skipped, never reported', async () => {
    const diffComment = retry({
      id: 'diffComment',
      blockId: ['diff', 'block', 0].join('-'),
      diffContext: 'removed',
      originalText: 'Text only in the old version',
      startMeta: undefined,
      endMeta: undefined,
    });
    const checkbox = retry({
      id: ['ann', 'checkbox', blockIdOf(ORIGINAL, 'Cache'), '1'].join('-'),
      blockId: blockIdOf(ORIGINAL, 'Cache'),
      originalText: '- [ ] raw markdown',
      startMeta: undefined,
      endMeta: undefined,
    });
    const reports = await restore(ORIGINAL, [diffComment, checkbox]);
    // Nothing a highlighter restore owns: no pass is reported at all.
    expect(reports).toEqual([]);
  });
});
