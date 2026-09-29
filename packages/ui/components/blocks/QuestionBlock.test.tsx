/**
 * `:::question` blocks rendered as answer cards, driven the way a host drives
 * them: answers live in the annotation list (`upsertQuestionAnswerAnnotation`)
 * and the block is re-rendered from it.
 *
 * What regresses if this fails: a pick does not reach the annotation (so the
 * answer never exports), an edit leaves a stale annotation behind, a drag
 * across option text picks the option instead of only selecting text, or an
 * unparseable block stops falling back to the plain callout.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks, type QuestionAnswer } from '@plannotator/core/question-block';
import type { Annotation } from '../../types';
import { parseMarkdownToBlocks } from '../../utils/parser';
import { collectQuestionAnswers, upsertQuestionAnswerAnnotation } from '../../utils/questionAnswers';
import { BlockRenderer } from '../BlockRenderer';

const hasDom = typeof document !== 'undefined';

const DOC = `# Plan

:::question
Where should losing conflict versions be kept?

Last-write-wins drops the loser.

- [ ] Local only — cheap
- [ ] Server-side per user
- [ ] Nowhere

Recommended: Local only
:::

:::question-multi
Which indicators ship?

- [ ] Dot
- [ ] Banner
- [ ] Toasts

Recommended: Dot, Banner
:::

:::question-text
Describe the manual test.

Recommended: Two phones, one offline.
:::

:::question
Transport?

- [x] REST
- [ ] WebSocket
:::

:::question
- [ ] a block with no prompt is not a question
:::
`;

let latest: Annotation[] = [];

function Harness({ markdown, readOnly = false, initial = [] }: { markdown: string; readOnly?: boolean; initial?: Annotation[] }) {
  const blocks = parseMarkdownToBlocks(markdown);
  const index = indexQuestionBlocks(blocks);
  const [annotations, setAnnotations] = useState<Annotation[]>(initial);
  latest = annotations;
  const answers = collectQuestionAnswers(annotations);
  const onAnswer = (blockId: string, answer: QuestionAnswer | null, key: string) =>
    setAnnotations((current) => upsertQuestionAnswerAnnotation(current, blockId, answer, key));
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
            onAnswerQuestion={readOnly ? undefined : onAnswer}
          />
        );
      })}
    </div>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = [];
  window.getSelection()?.removeAllRanges();
});

const cards = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question-key]'));
const answerOf = (n: number): QuestionAnswer | undefined => {
  const key = cards(host!)[n].dataset.questionKey!;
  return latest.find((a) => a.questionAnswer?.key === key)?.questionAnswer;
};
const button = (card: HTMLElement, label: string) =>
  Array.from(card.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const rowText = (card: HTMLElement, label: string) =>
  Array.from(card.querySelectorAll('label')).find((l) => l.textContent?.includes(label))!.querySelector('span')!;

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('QuestionBlock', () => {
  test.skipIf(!hasDom)('renders every parseable question as a numbered card and an unparseable one as the callout', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    expect(cards(el).map((c) => c.getAttribute('data-question-status'))).toEqual(['open', 'open', 'open', 'settled']);
    expect(cards(el)[0].textContent).toContain('Question 1 of 4');
    // The block with no prompt keeps today's directive rendering.
    const callout = el.querySelector('[data-directive-kind="question"]:not(fieldset)');
    expect(callout).not.toBeNull();
    expect(callout!.textContent).toContain('a block with no prompt is not a question');
  });

  test.skipIf(!hasDom)('single choice: a pick writes one answer annotation, a second pick replaces it', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    await click(rowText(cards(el)[0], 'Server-side'));
    expect(answerOf(0)?.selected).toEqual(['Server-side per user']);
    await click(rowText(cards(el)[0], 'Nowhere'));
    expect(latest.filter((a) => a.questionAnswer)).toHaveLength(1);
    expect(answerOf(0)?.selected).toEqual(['Nowhere']);
    expect(latest[0].id).toBe(`ann-question-${cards(el)[0].dataset.questionKey}`);
    expect(latest[0].text).toBe('Answer: Nowhere');
    expect(cards(el)[0].getAttribute('data-question-status')).toBe('answered');
  });

  test.skipIf(!hasDom)('multi choice keeps document order; "Other…" rides along; clearing everything removes the annotation', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const card = () => cards(el)[1];
    await click(rowText(card(), 'Toasts'));
    await click(rowText(card(), 'Dot'));
    expect(answerOf(1)?.selected).toEqual(['Dot', 'Toasts']);
    await type(card().querySelector<HTMLInputElement>('input[type="text"]')!, 'A sound');
    expect(answerOf(1)).toMatchObject({ selected: ['Dot', 'Toasts'], other: 'A sound' });
    await click(rowText(card(), 'Toasts'));
    await click(rowText(card(), 'Dot'));
    await type(card().querySelector<HTMLInputElement>('input[type="text"]')!, '');
    expect(latest).toEqual([]);
  });

  test.skipIf(!hasDom)('"Other…" on a single question replaces the picked choice', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    await click(rowText(cards(el)[0], 'Nowhere'));
    await type(cards(el)[0].querySelector<HTMLInputElement>('input[type="text"]')!, 'In the debug menu');
    expect(answerOf(0)).toMatchObject({ selected: [], other: 'In the debug menu' });
    expect(cards(el)[0].querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')).toHaveLength(0);
  });

  test.skipIf(!hasDom)('Accept recommended fills the recommended choices, or the suggested text, and then goes away', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    await click(button(cards(el)[1], 'Accept recommended')!);
    expect(answerOf(1)?.selected).toEqual(['Dot', 'Banner']);
    expect(button(cards(el)[1], 'Accept recommended')).toBeUndefined();

    await click(button(cards(el)[2], 'Use')!);
    expect(answerOf(2)?.text).toBe('Two phones, one offline.');
    // A settled question has no Accept recommended.
    expect(button(cards(el)[3], 'Accept recommended')).toBeUndefined();
  });

  test.skipIf(!hasDom)('Skip clears the answer but keeps a note; Unskip restores an open question', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const card = () => cards(el)[0];
    await click(rowText(card(), 'Nowhere'));
    await click(button(card(), 'Add note')!);
    await type(card().querySelector<HTMLTextAreaElement>('textarea')!, 'not sure yet');
    await click(button(card(), 'Skip')!);
    expect(answerOf(0)).toMatchObject({ selected: [], skipped: true, note: 'not sure yet' });
    expect(card().getAttribute('data-question-status')).toBe('skipped');
    await click(button(card(), 'Unskip')!);
    expect(answerOf(0)).toMatchObject({ selected: [], note: 'not sure yet' });
    expect(answerOf(0)?.skipped).toBeUndefined();
  });

  test.skipIf(!hasDom)('free text writes the answer; emptying it removes the annotation', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const box = () => cards(el)[2].querySelector<HTMLTextAreaElement>('textarea')!;
    await type(box(), 'Two phones');
    expect(answerOf(2)?.text).toBe('Two phones');
    await type(box(), '');
    expect(latest).toEqual([]);
  });

  test.skipIf(!hasDom)('a settled [x] choice renders picked; changing it becomes an answer', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const card = () => cards(el)[3];
    expect(card().querySelector<HTMLInputElement>('input[type="radio"]:checked')!.closest('label')!.textContent).toContain('REST');
    expect(latest).toEqual([]);
    await click(rowText(card(), 'WebSocket'));
    expect(answerOf(3)?.selected).toEqual(['WebSocket']);
  });

  test.skipIf(!hasDom)('a note on a settled question keeps the settled choice drawn', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const card = () => cards(el)[3];
    await click(button(card(), 'Add note')!);
    await type(card().querySelector('textarea')!, 'fine as is');
    expect(answerOf(3)?.note).toBe('fine as is');
    expect(card().dataset.questionStatus).toBe('settled');
    expect(card().querySelector<HTMLInputElement>('input[type="radio"]:checked')!.closest('label')!.textContent).toContain('REST');
  });

  test.skipIf(!hasDom)('a drag across option text, or a click that ends with text selected, does not pick', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const text = rowText(cards(el)[0], 'Server-side');
    await act(async () => {
      text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerType: 'mouse' }));
      text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 60, clientY: 11 }));
    });
    expect(latest).toEqual([]);

    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => {
      text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerType: 'mouse' }));
      text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    expect(latest).toEqual([]);
    expect(cards(el)[0].querySelectorAll('input:checked')).toHaveLength(0);

    // A still click with nothing selected is a pick.
    window.getSelection()!.removeAllRanges();
    await act(async () => {
      text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerType: 'mouse' }));
      text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 11, clientY: 10 }));
    });
    expect(answerOf(0)?.selected).toEqual(['Server-side per user']);
  });

  test.skipIf(!hasDom)('question and option text stay annotatable; the chrome is excluded', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const card = cards(el)[0];
    const prompt = card.querySelector(`#${card.getAttribute('aria-labelledby')}`)!;
    expect(prompt.closest('.annotation-exclude, .select-none, [data-pinpoint-ignore]')).toBeNull();
    expect(rowText(card, 'Server-side').closest('.annotation-exclude, .select-none, [data-pinpoint-ignore]')).toBeNull();
    for (const chrome of card.querySelectorAll('button')) {
      expect(chrome.closest('.annotation-exclude')).not.toBeNull();
    }
  });

  test.skipIf(!hasDom)('without a handler the block is read-only but still shows a stored answer', async () => {
    const [q] = indexQuestionBlocks(parseMarkdownToBlocks(DOC));
    const stored = upsertQuestionAnswerAnnotation([], q.blockId, {
      v: 1, key: q.question.key, kind: 'single', prompt: q.question.prompt, selected: ['Nowhere'], note: 'keep it simple',
    }, q.question.key);
    const el = await mount(<Harness markdown={DOC} readOnly initial={stored} />);
    const card = cards(el)[0];
    expect(card.disabled).toBe(true);
    expect(button(card, 'Skip')).toBeUndefined();
    expect(card.querySelector<HTMLInputElement>('input:checked')!.closest('label')!.textContent).toContain('Nowhere');
    expect(card.querySelector('textarea')!.value).toBe('keep it simple');
  });
});
