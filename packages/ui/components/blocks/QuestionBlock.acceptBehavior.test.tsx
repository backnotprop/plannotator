/**
 * `acceptBehavior`, the opt-in gentler Accept recommended (the Plannotator
 * Inbox; approval "question-note-vs-accept-recommended"). On a phone the
 * button sat right above the keyboard's Done while a note was typed, and one
 * stray tap replaced the answer, dropping the words typed under Other… with
 * no way back.
 *
 * What regresses if this fails: the button shows while a field of the card
 * is typed in, or stays away after; a tap drops Other… words on pick any; the
 * host's Undo does not put each kind of question back as it was; the pick-any
 * rule of #1913 (offered until the ticks are the recommended ones) breaks; or
 * a host that does not opt in sees any of it.
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
import type { QuestionAcceptBehavior } from './QuestionBlock';

const hasDom = typeof document !== 'undefined';

const PICK_ONE = ':::question\nWhere should losing versions be kept?\n\n- [ ] Local only — cheap\n- [ ] Server-side per user\n\nRecommended: Local only\n:::\n';
const PICK_ANY = ':::question-multi\nWhich checks run before the tag?\n\n- [ ] Unit tests\n- [ ] Canary deploy\n- [ ] Load test\n- [ ] Rollback drill\n\nRecommended: Canary deploy, Rollback drill\n:::\n';
const TEXT = ':::question-text\nDescribe the manual test.\n\nRecommended: Two phones, one offline.\n:::\n';

let latest: Annotation[] = [];
let undos: (() => void)[] = [];

function Harness({ markdown, behavior }: { markdown: string; behavior?: QuestionAcceptBehavior }) {
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
            questionAcceptBehavior={behavior}
          />
        );
      })}
    </div>
  );
}

const ON: QuestionAcceptBehavior = { asideWhileTyping: true, keepOther: true, onAccepted: (undo) => undos.push(undo) };

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
  undos = [];
});

const NOTE = 'textarea[placeholder="Context for the agent…"]';
const OTHER = 'textarea[aria-label^="Other answer"]';
const card = () => host!.querySelector<HTMLFieldSetElement>('fieldset[data-question-key]')!;
const answer = (): QuestionAnswer | undefined => latest.find((a) => a.questionAnswer)?.questionAnswer;
const button = (label: string) => Array.from(card().querySelectorAll('button')).find((b) => b.textContent === label);
const accept = () => button('Accept recommended');
const row = (label: string) => Array.from(card().querySelectorAll('label')).find((l) => l.textContent?.includes(label))!.querySelector('span')!;

async function click(el: Element) {
  await act(async () => (el as HTMLElement).click());
}
async function focus(el: HTMLElement) {
  await act(async () => el.focus());
}
async function blur(el: HTMLElement) {
  await act(async () => el.blur());
}
async function type(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function openNote() {
  await click(button('Add note')!);
  await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  return card().querySelector<HTMLTextAreaElement>(NOTE)!;
}

describe('QuestionBlock acceptBehavior', () => {
  test.skipIf(!hasDom)('Accept recommended steps aside while the note, Other… or a text answer has focus, and is back after', async () => {
    for (const [markdown, field] of [
      [PICK_ONE, 'note'],
      [PICK_ANY, 'other'],
      [TEXT, 'answer'],
    ] as const) {
      await mount(<Harness markdown={markdown} behavior={ON} />);
      expect(accept()).toBeDefined();
      const el =
        field === 'note' ? await openNote() : field === 'other' ? card().querySelector<HTMLTextAreaElement>(OTHER)! : card().querySelector<HTMLTextAreaElement>('textarea')!;
      await focus(el);
      expect(accept()).toBeUndefined();
      // Moving from one field of the card to another is still typing.
      if (field === 'note') {
        await focus(card().querySelector<HTMLTextAreaElement>(OTHER)!);
        expect(accept()).toBeUndefined();
      }
      await blur(document.activeElement as HTMLElement);
      expect(accept()).toBeDefined();
      // A choice's own control is not a field: focus on it keeps the button.
      if (field !== 'answer') {
        await focus(card().querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')!);
        expect(accept()).toBeDefined();
      }
      await act(async () => root!.unmount());
      host!.remove();
      root = null;
    }
  });

  test.skipIf(!hasDom)('a host that does not opt in keeps the button while the note is typed in', async () => {
    await mount(<Harness markdown={PICK_ONE} />);
    await focus(await openNote());
    expect(accept()).toBeDefined();
  });

  test.skipIf(!hasDom)('pick any: Accept keeps the Other… words beside the recommended ticks, and Undo puts the ticks back', async () => {
    await mount(<Harness markdown={PICK_ANY} behavior={ON} />);
    await click(row('Load test'));
    const note = await openNote();
    await type(note, 'only if staging is free');
    await type(card().querySelector<HTMLTextAreaElement>(OTHER)!, 'A smoke test on prod');
    await blur(document.activeElement as HTMLElement);
    await click(accept()!);
    expect(answer()).toMatchObject({ selected: ['Canary deploy', 'Rollback drill'], other: 'A smoke test on prod', note: 'only if staging is free' });
    expect(card().querySelector<HTMLTextAreaElement>(OTHER)!.value).toBe('A smoke test on prod');
    // The ticks are the recommended ones: no button, as before.
    expect(accept()).toBeUndefined();
    expect(undos).toHaveLength(1);
    await act(async () => undos[0]!());
    expect(answer()).toMatchObject({ selected: ['Load test'], other: 'A smoke test on prod', note: 'only if staging is free' });
    expect(accept()).toBeDefined();
  });

  test.skipIf(!hasDom)('pick one and text: Undo takes the accepted answer away and keeps the note', async () => {
    for (const markdown of [PICK_ONE, TEXT]) {
      await mount(<Harness markdown={markdown} behavior={ON} />);
      const note = await openNote();
      await type(note, 'from my phone');
      await blur(note);
      await click(accept()!);
      expect(answer()?.selected.length || answer()?.text).toBeTruthy();
      await act(async () => undos.at(-1)!());
      const back = answer()!;
      expect(back.selected).toEqual([]);
      expect(back.text).toBeUndefined();
      expect(back.note).toBe('from my phone');
      // A text question's Accept leaves focus in its answer field (today's focus rule): typing there still hides it.
      if (document.activeElement instanceof HTMLElement) await blur(document.activeElement);
      expect(accept()).toBeDefined();
      await act(async () => root!.unmount());
      host!.remove();
      root = null;
    }
  });

  test.skipIf(!hasDom)('Undo after the answer changed again does nothing', async () => {
    await mount(<Harness markdown={PICK_ONE} behavior={ON} />);
    await click(accept()!);
    await click(row('Server-side'));
    await act(async () => undos[0]!());
    expect(answer()?.selected).toEqual(['Server-side per user']);
  });

  test.skipIf(!hasDom)('pick any, outside typing: the button stays until the ticks are exactly the recommended ones (#1913)', async () => {
    await mount(<Harness markdown={PICK_ANY} behavior={ON} />);
    await click(row('Load test'));
    expect(accept()).toBeDefined();
    await click(row('Canary deploy'));
    expect(accept()).toBeDefined();
    await click(row('Load test'));
    await click(row('Rollback drill'));
    expect(answer()?.selected).toEqual(['Canary deploy', 'Rollback drill']);
    expect(accept()).toBeUndefined();
  });
});
