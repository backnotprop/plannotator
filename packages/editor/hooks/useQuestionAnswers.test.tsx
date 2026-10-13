/**
 * Answers to `:::question` blocks in the annotation undo history, driven
 * through the real card (BlockRenderer → QuestionBlock) and the real
 * `useUndoHistory`.
 *
 * What regresses if this fails: Mod+Z skips answers (or undoes a whole
 * sentence one letter at a time), a quick second pick merges into the first,
 * or the double-click-a-word guard leaves a stray pick (or a stray history
 * entry) behind.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks } from '@plannotator/shared/question-block';
import { BlockRenderer } from '@plannotator/ui/components/BlockRenderer';
import { useUndoHistory, type UndoHistoryApi } from '@plannotator/ui/hooks/useUndoHistory';
import type { Annotation } from '@plannotator/ui/types';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { collectQuestionAnswers } from '@plannotator/ui/utils/questionAnswers';
import { applyCollectionMutation, type CollectionMutation } from '@plannotator/ui/utils/undoHistory';
import { QUESTION_TYPING_BURST_MS, useQuestionAnswers } from './useQuestionAnswers';

const hasDom = typeof document !== 'undefined';

const DOC = `# Plan

:::question
Where should conflicts live?

- [ ] Local only
- [ ] Server-side
:::

:::question-text
Describe the test.
:::
`;

let clock = 0;
let history: UndoHistoryApi<CollectionMutation<Annotation>> | null = null;
let latest: Annotation[] = [];

function Harness() {
  const blocks = parseMarkdownToBlocks(DOC);
  const index = indexQuestionBlocks(blocks);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const annotationsRef = useRef<Annotation[]>([]);
  latest = annotations;
  const undo = useUndoHistory<CollectionMutation<Annotation>>({
    context: 'doc',
    apply: (mutation, direction) => {
      const next = applyCollectionMutation(annotationsRef.current, mutation, direction, (a) => a.id);
      annotationsRef.current = next;
      setAnnotations(next);
    },
  });
  history = undo;
  const onAnswer = useQuestionAnswers<CollectionMutation<Annotation>>({
    setAnnotations,
    annotationsRef,
    history: undo,
    toAction: (mutation) => mutation,
    now: () => clock,
  });
  const answers = collectQuestionAnswers(annotations);
  return (
    <div>
      {blocks.map((block) => {
        const question = index.find((q) => q.blockId === block.id);
        return (
          <BlockRenderer
            key={block.id}
            block={block}
            question={question}
            questionTotal={index.length}
            questionAnswer={question ? answers.get(question.question.key) : undefined}
            onAnswerQuestion={onAnswer}
          />
        );
      })}
    </div>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness />));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  history = null;
  latest = [];
  clock = 0;
});

const cards = () => Array.from(host!.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question-key]'));
const rowText = (card: HTMLElement, label: string) =>
  Array.from(card.querySelectorAll('label')).find((l) => l.textContent?.includes(label))!.querySelector('span')!;
const answerAt = (n: number) => latest.find((a) => a.questionAnswer?.key === cards()[n].dataset.questionKey)?.questionAnswer;

async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string, at: number) {
  clock = at;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickRow(text: HTMLElement, at: number, detail = 1) {
  clock = at;
  await act(async () => {
    text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerType: 'mouse' }));
    text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, detail }));
  });
}

const undo = async () => act(async () => { history!.undo(); });
const redo = async () => act(async () => { history!.redo(); });

describe('useQuestionAnswers: undo history', () => {
  test.skipIf(!hasDom)('a typing burst is one entry: undo clears it, redo brings it back', async () => {
    await mount();
    const box = () => cards()[1].querySelector('textarea')!;
    await type(box(), 'T', 0);
    await type(box(), 'Tw', 200);
    await type(box(), 'Two phones', 400);
    expect(answerAt(1)?.text).toBe('Two phones');
    await undo();
    expect(answerAt(1)).toBeUndefined();
    expect(history!.canUndo).toBe(false);
    await redo();
    expect(answerAt(1)?.text).toBe('Two phones');
  });

  test.skipIf(!hasDom)('a pause starts a new entry', async () => {
    await mount();
    const box = () => cards()[1].querySelector('textarea')!;
    await type(box(), 'Two phones', 0);
    await type(box(), 'Two phones, one offline', QUESTION_TYPING_BURST_MS + 500);
    await undo();
    expect(answerAt(1)?.text).toBe('Two phones');
    await undo();
    expect(answerAt(1)).toBeUndefined();
  });

  test.skipIf(!hasDom)('each pick is its own entry, even in quick succession; a note after a pick is separate', async () => {
    await mount();
    await clickRow(rowText(cards()[0], 'Local only'), 0);
    await clickRow(rowText(cards()[0], 'Server-side'), 100);
    await act(async () => {
      Array.from(cards()[0].querySelectorAll('button')).find((b) => b.textContent === 'Add note')!.click();
    });
    await type(cards()[0].querySelector('textarea')!, 'Per user', 200);
    expect(answerAt(0)).toMatchObject({ selected: ['Server-side'], note: 'Per user' });
    await undo();
    expect(answerAt(0)).toMatchObject({ selected: ['Server-side'] });
    expect(answerAt(0)?.note).toBeUndefined();
    await undo();
    expect(answerAt(0)?.selected).toEqual(['Local only']);
    await undo();
    expect(answerAt(0)).toBeUndefined();
  });

  test.skipIf(!hasDom)('double-clicking a word in an option leaves no pick and no history entry', async () => {
    await mount();
    const text = rowText(cards()[0], 'Server-side');
    await clickRow(text, 0, 1);
    await clickRow(text, 50, 2);
    expect(answerAt(0)).toBeUndefined();
    expect(cards()[0].querySelectorAll('input:checked')).toHaveLength(0);
    expect(history!.canUndo).toBe(false);
  });

  test.skipIf(!hasDom)('double-clicking after an earlier answer restores that answer', async () => {
    await mount();
    await clickRow(rowText(cards()[0], 'Local only'), 0);
    const text = rowText(cards()[0], 'Server-side');
    await clickRow(text, 5000, 1);
    await clickRow(text, 5050, 2);
    expect(answerAt(0)?.selected).toEqual(['Local only']);
    await undo();
    expect(answerAt(0)).toBeUndefined();
  });
});
