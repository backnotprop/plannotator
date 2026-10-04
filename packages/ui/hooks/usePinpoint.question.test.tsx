/**
 * Pinpoint input mode over a `:::question` card.
 *
 * What regresses if this fails: a pinpoint click on option text both pins
 * the text (opening the comment composer) AND picks the option, because the
 * row is a <label> that forwards the click to its radio; or a click on the
 * radio itself pins the whole card instead of only answering; or a click
 * anywhere in the card pins the PROMPT instead of what was clicked (the card
 * starts with a select-none eyebrow, so the semantic graph mistook it for a
 * list item and made its second child, the prompt, the whole card's target).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks, type QuestionAnswer } from '@plannotator/core/question-block';
import type { Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';
import { collectQuestionAnswers, upsertQuestionAnswerAnnotation } from '../utils/questionAnswers';
import { BlockRenderer } from '../components/BlockRenderer';

const hasDom = typeof document !== 'undefined';
const mod = hasDom ? await import('./usePinpoint') : null;
const usePinpoint = mod?.usePinpoint as typeof import('./usePinpoint')['usePinpoint'];

const DOC = `:::question
Where should conflicts live?

What each changes:
- **Local only** (the spec): no network needed.

- [ ] Local only
- [ ] Server-side
:::
`;

let latest: Annotation[] = [];
let pinned: string[] = [];

function Harness() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blocks = parseMarkdownToBlocks(DOC);
  const index = indexQuestionBlocks(blocks);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  latest = annotations;
  usePinpoint({
    containerRef,
    inputMethod: 'pinpoint',
    enabled: true,
    onSelectRange: (range) => { pinned.push(range.toString()); },
    onCodeBlockClick: () => {},
  });
  const answers = collectQuestionAnswers(annotations);
  const onAnswer = (blockId: string, answer: QuestionAnswer | null, key: string) =>
    setAnnotations((current) => upsertQuestionAnswerAnnotation(current, blockId, answer, key));
  return (
    <div ref={containerRef}>
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

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = [];
  pinned = [];
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness />));
  return host;
}

const row = (el: HTMLElement, label: string) =>
  Array.from(el.querySelectorAll<HTMLLabelElement>('label[data-question-option]')).find((l) => l.textContent?.includes(label))!;

describe('usePinpoint over a question card', () => {
  test.skipIf(!hasDom)('a click on option text pins it and does not pick the option', async () => {
    const el = await mount();
    const text = row(el, 'Server-side').querySelector('span')!;
    await act(async () => {
      text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    expect(pinned).toEqual(['Server-side']);
    expect(latest).toEqual([]);
    expect(el.querySelectorAll('input:checked')).toHaveLength(0);
  });

  test.skipIf(!hasDom)('a click on the first choice pins that choice, not the prompt', async () => {
    const el = await mount();
    const text = row(el, 'Local only').querySelector('span')!;
    await act(async () => {
      text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    expect(pinned).toEqual(['Local only']);
  });

  test.skipIf(!hasDom)('the prompt and the context each pin themselves', async () => {
    const el = await mount();
    const prompt = el.querySelector<HTMLElement>('[data-question-part="prompt"]')!;
    const context = el.querySelector<HTMLElement>('[data-question-part="context"] p')!;
    await act(async () => {
      prompt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      context.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    expect(pinned[0]).toBe('Where should conflicts live?');
    // The context pins as one part (its own list included), never the prompt.
    expect(pinned[1]).toStartWith('What each changes:');
    expect(pinned[1]).not.toContain('Where should conflicts live?');
  });

  test.skipIf(!hasDom)('a click on the radio answers and does not pin', async () => {
    const el = await mount();
    await act(async () => {
      row(el, 'Local only').querySelector('input')!.click();
    });
    expect(pinned).toEqual([]);
    expect(latest[0]?.questionAnswer?.selected).toEqual(['Local only']);
  });
});
