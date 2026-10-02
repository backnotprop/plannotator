/**
 * The host seams on question cards (Workspaces keeps answers itself and saves
 * them explicitly): the decision flag and link, the footer slot, and the
 * explicit save mode.
 *
 * What regresses if this fails: a flagged question gives no sign that its
 * answer becomes a decision; a host footer action is dead in a read-only card
 * (a disabled fieldset disables every button inside it); a save-mode edit
 * reaches the host before Save, Cancel leaves the draft on screen, or a failed
 * save throws the reviewer's draft away.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks, type IndexedQuestion, type QuestionAnswer } from '@plannotator/core/question-block';
import { parseMarkdownToBlocks } from '../../utils/parser';
import { BlockRenderer } from '../BlockRenderer';

const hasDom = typeof document !== 'undefined';

const DOC = `:::question
Where should losing versions be kept?

Decision: when answered

- [ ] Local
- [ ] Server

Recommended: Local
:::

:::question
Which transport?

- [ ] REST
- [ ] WebSocket

Decision: [Use REST](https://ws.example/decisions/dec_1)
:::

:::question
Plain one?

- [ ] Yes
- [ ] No
:::
`;

type SaveFn = (key: string, answer: QuestionAnswer | null) => void | Promise<unknown>;

let saves: Array<[string, QuestionAnswer | null]> = [];

function Harness({
  readOnly = false,
  save,
  footer,
  initial = {},
}: {
  readOnly?: boolean;
  save?: SaveFn;
  footer?: (q: IndexedQuestion, a: QuestionAnswer | undefined) => React.ReactNode;
  initial?: Record<string, QuestionAnswer>;
}) {
  const blocks = parseMarkdownToBlocks(DOC);
  const index = indexQuestionBlocks(blocks);
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>(initial);
  const onSave: SaveFn | undefined = save
    ? (key, answer) => {
        saves.push([key, answer]);
        const result = save(key, answer);
        const apply = () =>
          setAnswers((current) => {
            const next = { ...current };
            if (answer) next[key] = answer;
            else delete next[key];
            return next;
          });
        if (result instanceof Promise) return result.then(apply);
        apply();
        return result;
      }
    : undefined;
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
            questionAnswer={question ? answers[question.question.key] : undefined}
            onSaveQuestionAnswer={readOnly ? undefined : onSave}
            renderQuestionFooter={footer}
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
  saves = [];
});

const cards = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question-key]'));
const button = (card: HTMLElement, label: string) =>
  Array.from(card.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const radio = (card: HTMLElement, label: string) =>
  Array.from(card.querySelectorAll('label')).find((l) => l.textContent?.includes(label))!.querySelector('input')!;
const checkedLabel = (card: HTMLElement) =>
  card.querySelector<HTMLInputElement>('input:checked')?.closest('label')?.textContent ?? null;

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('QuestionBlock decision lines', () => {
  test.skipIf(!hasDom)('a flagged question says so; an unflagged one does not', async () => {
    const el = await mount(<Harness />);
    const [flagged, , plain] = cards(el);
    expect(flagged.dataset.questionDecision).toBe('on-answer');
    expect(flagged.querySelector('[data-question-decision-row]')).not.toBeNull();
    expect(plain.dataset.questionDecision).toBeUndefined();
    expect(plain.querySelector('[data-question-decision-row]')).toBeNull();
  });

  test.skipIf(!hasDom)('a recorded decision links to its URL in a new tab', async () => {
    const el = await mount(<Harness />);
    const linked = cards(el)[1];
    expect(linked.dataset.questionDecision).toBe('recorded');
    const a = linked.querySelector<HTMLAnchorElement>('[data-question-decision-row] a')!;
    expect(a.getAttribute('href')).toBe('https://ws.example/decisions/dec_1');
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
  });
});

describe('QuestionBlock footer slot', () => {
  test.skipIf(!hasDom)('host actions get the question and saved answer, and stay live in a read-only card', async () => {
    const seen: Array<[string, string[] | undefined]> = [];
    let clicked = 0;
    const footer = (q: IndexedQuestion, a: QuestionAnswer | undefined) => {
      seen.push([q.question.key, a?.selected]);
      // Sentinel label: only presence and clickability are under test.
      return q.number === 1 ? <button type="button" onClick={() => clicked++}>host-action</button> : null;
    };
    const [first] = indexQuestionBlocks(parseMarkdownToBlocks(DOC));
    const saved: QuestionAnswer = { v: 1, key: first.question.key, kind: 'single', prompt: first.question.prompt, selected: ['Server'] };
    const el = await mount(<Harness readOnly footer={footer} initial={{ [first.question.key]: saved }} />);
    const [card, second] = cards(el);
    expect(seen).toContainEqual([first.question.key, ['Server']]);
    const action = button(card, 'host-action')!;
    expect(action.disabled).toBe(false);
    await click(action);
    expect(clicked).toBe(1);
    // A footer that returns null adds no footer row to a read-only card.
    expect(second.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('QuestionBlock explicit save mode', () => {
  test.skipIf(!hasDom)('edits stay a draft until Save, which saves once; Skip is not offered', async () => {
    const el = await mount(<Harness save={() => {}} />);
    let card = cards(el)[2];
    expect(button(card, 'Skip')).toBeUndefined();
    expect(button(card, 'Save answer')).toBeUndefined();

    await click(radio(card, 'No'));
    expect(saves).toHaveLength(0);
    card = cards(el)[2];
    expect(checkedLabel(card)).toContain('No');

    await click(button(card, 'Save answer')!);
    expect(saves).toHaveLength(1);
    expect(saves[0][0]).toBe(card.dataset.questionKey!);
    expect(saves[0][1]?.selected).toEqual(['No']);
    // Saved: the save bar goes away and the host's answer is what shows.
    expect(button(cards(el)[2], 'Save answer')).toBeUndefined();
    expect(checkedLabel(cards(el)[2])).toContain('No');
  });

  test.skipIf(!hasDom)('Cancel returns to the host answer', async () => {
    const [, , plain] = indexQuestionBlocks(parseMarkdownToBlocks(DOC));
    const saved: QuestionAnswer = { v: 1, key: plain.question.key, kind: 'single', prompt: plain.question.prompt, selected: ['Yes'] };
    const el = await mount(<Harness save={() => {}} initial={{ [plain.question.key]: saved }} />);
    await click(radio(cards(el)[2], 'No'));
    expect(checkedLabel(cards(el)[2])).toContain('No');
    await click(button(cards(el)[2], 'Cancel')!);
    expect(checkedLabel(cards(el)[2])).toContain('Yes');
    expect(saves).toHaveLength(0);
  });

  test.skipIf(!hasDom)('a rejected save keeps the draft for a retry', async () => {
    let fail = true;
    const el = await mount(<Harness save={() => (fail ? Promise.reject(new Error('412')) : Promise.resolve())} />);
    await click(radio(cards(el)[2], 'Yes'));
    await click(button(cards(el)[2], 'Save answer')!);
    expect(checkedLabel(cards(el)[2])).toContain('Yes');
    const retry = button(cards(el)[2], 'Save answer')!;
    expect(retry.disabled).toBe(false);
    fail = false;
    await click(retry);
    expect(saves).toHaveLength(2);
    expect(button(cards(el)[2], 'Save answer')).toBeUndefined();
    expect(checkedLabel(cards(el)[2])).toContain('Yes');
  });
});
