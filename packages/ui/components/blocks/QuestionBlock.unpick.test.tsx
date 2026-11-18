/**
 * A pick-one card: the chosen choice clicked again is un-picked (a Space on
 * its radio is the same click); pick any is unchanged. And a choice's detail
 * lines (`Why:`, `Trade-off:` written under it) are drawn under that choice,
 * never as choices of their own.
 *
 * What regresses if this fails: a single choice can only be taken back with
 * a fast double-click or Skip, or a `- Trade-off: …` bullet under a choice
 * shows as one more radio.
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

const DOC = `:::question
Where should the retry live?

- [ ] Pin it
- [ ] Loosen it
:::

:::question-multi
Which indicators ship?

- [ ] Dot
- [ ] Banner
:::

:::question
Which drawer?

- A — closest to today
  - Trade-off: Pay sits below the fold
- B
  Why: the total never scrolls away

Recommended: B
:::
`;

let latest: Annotation[] = [];

function Harness({ markdown }: { markdown: string }) {
  const blocks = parseMarkdownToBlocks(markdown);
  const index = indexQuestionBlocks(blocks);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
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
            onAnswerQuestion={onAnswer}
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
});

const cards = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question-key]'));
const answerOf = (n: number): QuestionAnswer | undefined => {
  const key = cards(host!)[n].dataset.questionKey!;
  return latest.find((a) => a.questionAnswer?.key === key)?.questionAnswer;
};
const row = (card: HTMLElement, label: string) =>
  Array.from(card.querySelectorAll('label')).find((l) => l.textContent?.includes(label))!;
const tap = async (el: Element, detail = 1) => {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, detail }));
  });
};

describe('QuestionBlock: un-pick and choice details', () => {
  test.skipIf(!hasDom)('pick one: clicking the chosen choice again un-picks it; its radio clicked (Space) does too', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const card = () => cards(el)[0];
    await tap(row(card(), 'Pin it').querySelector('span')!);
    expect(answerOf(0)?.selected).toEqual(['Pin it']);
    await tap(row(card(), 'Pin it').querySelector('span')!);
    expect(answerOf(0)).toBeUndefined();
    expect(card().querySelectorAll('input[type="radio"]:checked')).toHaveLength(0);
    expect(card().getAttribute('data-question-status')).toBe('open');

    // Space on a focused radio is a click on it.
    await tap(row(card(), 'Loosen it').querySelector('span')!);
    const radio = row(card(), 'Loosen it').querySelector<HTMLInputElement>('input[type="radio"]')!;
    expect(radio.checked).toBe(true);
    await act(async () => radio.click());
    expect(answerOf(0)).toBeUndefined();
    expect(radio.checked).toBe(false);
  });

  test.skipIf(!hasDom)('a double-click on the chosen choice still takes back what its first click did', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const text = () => row(cards(el)[0], 'Pin it').querySelector('span')!;
    await tap(text());
    expect(answerOf(0)?.selected).toEqual(['Pin it']);
    // A double-click on it: the first click un-picks, the second puts it back.
    await tap(text(), 1);
    expect(answerOf(0)).toBeUndefined();
    await tap(text(), 2);
    expect(answerOf(0)?.selected).toEqual(['Pin it']);
  });

  test.skipIf(!hasDom)('pick any is unchanged: a second click unticks only that box', async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const card = () => cards(el)[1];
    await tap(row(card(), 'Dot').querySelector('span')!);
    await tap(row(card(), 'Banner').querySelector('span')!);
    expect(answerOf(1)?.selected).toEqual(['Dot', 'Banner']);
    await tap(row(card(), 'Dot').querySelector('span')!);
    expect(answerOf(1)?.selected).toEqual(['Banner']);
  });

  test.skipIf(!hasDom)("a choice's Trade-off and Why lines are drawn under it, not as choices", async () => {
    const el = await mount(<Harness markdown={DOC} />);
    const card = cards(el)[2];
    expect(card.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    const a = row(card, 'closest to today');
    expect(Array.from(a.querySelectorAll('[data-question-part="choice-detail"]')).map((d) => d.textContent)).toEqual(['Trade-off: Pay sits below the fold']);
    // The words after the label keep their place; the detail is not repeated there.
    expect(a.textContent).toContain('A — closest to today');
    expect(a.textContent!.match(/Pay sits below the fold/g)).toHaveLength(1);
    const b = row(card, 'the total never scrolls away');
    expect(b.querySelector('[data-question-part="choice-detail"]')!.textContent).toBe('Why: the total never scrolls away');
    expect(b.textContent).toContain('Recommended');
  });
});
