/**
 * `Viewer` `questionTextComments` with `textComments` + `answerOnly` (the Plannotator Inbox; approval
 * "inbox-annotate-own-and-questions"), through the REAL Viewer, QuestionBlock and web-highlighter (DOM-gated,
 * DOM_TESTS=1).
 *
 * Failures to catch: the seam leaking to a host that does not pass it (a question card's words opening the
 * toolbar there), a card's words (prompt, context, a choice's label) not taking comments with it, a click on a
 * choice no longer picking it in one press, or a drag across a choice's words picking it.
 */
import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const MARKDOWN = ['The backoff is two, four and eight seconds.', '', ':::question', 'Which rounding rule wins?', 'It decides the totals.', '', '- [ ] Half up — the old rule', '- [ ] Half even', ':::', ''].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function mount(props: { questionTextComments?: boolean; onAnswerQuestion?: (...args: unknown[]) => void; onAddAnnotation?: (annotation: Annotation) => void }): Promise<HTMLElement> {
  const Viewer = viewerModule!.Viewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parserModule!.parseMarkdownToBlocks(MARKDOWN)}
        markdown={MARKDOWN}
        annotations={[]}
        onAddAnnotation={props.onAddAnnotation ?? (() => {})}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        answerOnly
        textComments
        questionTextComments={props.questionTextComments}
        onAnswerQuestion={props.onAnswerQuestion ?? (() => {})}
      />,
    );
  });
  await settle();
  return host!;
}

async function select(scope: HTMLElement, phrase: string) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  const at = node!.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node!, at);
  range.setEnd(node!, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node!.parentElement!.closest('article') ?? scope).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const toolbarNames = () => [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].map((b) => b.getAttribute('aria-label') ?? b.title);
const cancelToolbar = async () => {
  await act(async () => document.querySelector<HTMLButtonElement>('.annotation-toolbar button[aria-label="Cancel"], .annotation-toolbar button[title="Cancel"]')?.click());
  await settle();
};

/** A press on a choice's words, as a pointer does it: down at `from`, the click at `to` (a drag when they differ). */
async function pressChoice(el: HTMLElement, label: string, from: number, to: number) {
  const row = [...el.querySelectorAll<HTMLElement>('[data-question-option]')].find((r) => r.textContent?.includes(label))!;
  const words = row.querySelector<HTMLElement>('[data-question-part="choice"]')!;
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  await act(async () => {
    words.dispatchEvent(new Ctor('pointerdown', { bubbles: true, cancelable: true, clientX: from, clientY: 10, button: 0, ...(Ctor !== MouseEvent ? { pointerId: 1, pointerType: 'mouse' } : {}) } as MouseEventInit));
    words.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: to, clientY: 10, button: 0, detail: 1 }));
  });
  await settle();
}

test.skipIf(!hasDom)('without it (every other host): a question card stays out of selection', async () => {
  const el = await mount({});
  const card = el.querySelector<HTMLElement>('[data-question-key]')!;
  expect(card.closest('.annotation-exclude')).not.toBeNull();
  await select(card, 'Which rounding');
  expect(toolbarNames()).toEqual([]);
});

test.skipIf(!hasDom)("with it: the prompt, its context and a choice's label and description take comments", async () => {
  const added: Annotation[] = [];
  const el = await mount({ questionTextComments: true, onAddAnnotation: (a) => added.push(a) });
  const card = el.querySelector<HTMLElement>('[data-question-key]')!;
  expect(card.closest('.annotation-exclude')).toBeNull();
  for (const words of ['Which rounding', 'decides the totals', 'Half even', 'the old rule']) {
    await select(card, words);
    expect(toolbarNames()).toContain('Comment');
    await cancelToolbar();
  }
  // The card's own chrome stays out: its eyebrow and footer are not text to comment on.
  expect(card.querySelector('[data-question-control]')?.closest('[data-question-option]')).not.toBeNull();
});

test.skipIf(!hasDom)('with it: a click on a choice picks it at once; a drag across its words does not', async () => {
  const picks: unknown[] = [];
  const el = await mount({ questionTextComments: true, onAnswerQuestion: (_block, answer) => picks.push(answer) });
  await pressChoice(el, 'Half even', 10, 40);
  expect(picks).toHaveLength(0);
  await pressChoice(el, 'Half even', 10, 11);
  expect(picks).toHaveLength(1);
  expect(picks[0]).toMatchObject({ selected: ['Half even'] });
});
