/**
 * An answer to a `:::question` block quotes the prompt but is not a text
 * selection; the question card draws it. The highlighter must leave it alone.
 *
 * What regresses if this fails: every restored answer paints a highlight over
 * its own prompt (or the first prose match of it), and a draft restore raises
 * an "Unanchored" chip on answers whose prompt was reworded.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { indexQuestionBlocks } from '@plannotator/core/question-block';
import { parseMarkdownToBlocks } from '../utils/parser';
import { BlockRenderer } from '../components/BlockRenderer';

const hasDom = typeof document !== 'undefined';
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];
type Report = import('./useAnnotationHighlighter').AnnotationRestoreReport;

const ANSWER: Annotation = {
  id: 'ann-question-q-0000000a',
  blockId: 'block-2',
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text: 'Answer: Local only',
  originalText: 'Where should conflicts live?',
  createdA: 1,
  questionAnswer: { v: 1, key: 'q-0000000a', kind: 'single', prompt: 'Where should conflicts live?', selected: ['Local only'] },
};
const TEXT: Annotation = { ...ANSWER, id: 't1', blockId: 'block-1', text: 'hm', originalText: 'the plan', questionAnswer: undefined };

function Harness({ onReport, applyRef }: { onReport: (report: Report) => void; applyRef: { current: (() => void) | null } }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const annotations = [ANSWER, TEXT];
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations,
    selectedAnnotationId: null,
    mode: 'comment',
    onAddAnnotation: () => {},
    onRestoreReport: onReport,
  });
  applyRef.current = () => hook.applyAnnotations(annotations);
  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">Read the plan first.</p>
      <fieldset data-block-id="block-2">
        <p>Where should conflicts live?</p>
      </fieldset>
    </div>
  );
}

describe('useAnnotationHighlighter: question answers', () => {
  test.skipIf(!hasDom)('an answer row is neither painted, attempted nor unanchored', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const reports: Report[] = [];
    const applyRef: { current: (() => void) | null } = { current: null };
    await act(async () => {
      root.render(<Harness onReport={(r) => reports.push(r)} applyRef={applyRef} />);
    });
    await act(async () => {
      applyRef.current?.();
      await new Promise((r) => setTimeout(r, 30));
    });
    const last = reports[reports.length - 1];
    expect(last).toBeDefined();
    expect(last!.attempted).toContain('t1');
    expect(last!.attempted).not.toContain(ANSWER.id);
    expect(last!.unanchored).not.toContain(ANSWER.id);
    expect(host.querySelector('fieldset mark')).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });

  // PR 1 review: the text-search restore walked into the typed answer. A
  // restored comment whose quote only matches what the reviewer typed into a
  // question's text box must not be painted inside that box.
  test.skipIf(!hasDom)('typed answer and note text is not matched by text-search restore', async () => {
    const md = ':::question-text\nDescribe the test.\n:::\n';
    const blocks = parseMarkdownToBlocks(md);
    const [q] = indexQuestionBlocks(blocks);
    const typed = 'Two phones, one offline';
    const answer: Annotation = {
      ...ANSWER,
      id: `ann-question-${q.question.key}`,
      blockId: q.blockId,
      originalText: q.question.prompt,
      questionAnswer: { v: 1, key: q.question.key, kind: 'text', prompt: q.question.prompt, selected: [], text: typed, note: 'Note words here' },
    };
    const quoteTyped: Annotation = { ...TEXT, id: 't-typed', blockId: q.blockId, originalText: typed, startMeta: undefined, endMeta: undefined };
    const quoteNote: Annotation = { ...TEXT, id: 't-note', blockId: q.blockId, originalText: 'Note words', startMeta: undefined, endMeta: undefined };
    const reports: Report[] = [];
    function CardHarness({ applyRef }: { applyRef: { current: (() => void) | null } }) {
      const containerRef = useRef<HTMLDivElement | null>(null);
      const annotations = [answer, quoteTyped, quoteNote];
      const hook = useAnnotationHighlighter({
        containerRef,
        annotations,
        selectedAnnotationId: null,
        mode: 'comment',
        onAddAnnotation: () => {},
        onRestoreReport: (r) => reports.push(r),
      });
      applyRef.current = () => hook.applyAnnotations([quoteTyped, quoteNote]);
      return (
        <div ref={containerRef}>
          <BlockRenderer block={blocks[0]} question={q} questionTotal={1} questionAnswer={answer.questionAnswer} onAnswerQuestion={() => {}} />
        </div>
      );
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const applyRef: { current: (() => void) | null } = { current: null };
    await act(async () => {
      root.render(<CardHarness applyRef={applyRef} />);
    });
    await act(async () => {
      applyRef.current?.();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(host.querySelector('textarea mark, textarea [data-highlight-id]')).toBeNull();
    const boxes = Array.from(host.querySelectorAll('textarea'));
    expect(boxes.map((b) => b.value)).toEqual([typed, 'Note words here']);
    await act(async () => root.unmount());
    host.remove();
  });
});
