/**
 * The semantic target graph over REAL rendered blocks (BlockRenderer), not
 * hand-written fixtures.
 *
 * What regresses if this fails:
 * - a real list item stops targeting its text (the marker heuristic broke);
 * - a callout or alert (a title, then a body that may hold a list) is
 *   mistaken for a list item and targets only one of its children;
 * - a question card targets its prompt for every pointer position (its first
 *   child is a `select-none` eyebrow), or Vim can no longer step into and out
 *   of the card's parts.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks } from '@plannotator/core/question-block';
import { parseMarkdownToBlocks } from './parser';
import { BlockRenderer } from '../components/BlockRenderer';

const hasDom = typeof document !== 'undefined';
const targeting = hasDom ? await import('./blockTargeting') : null;

const DOC = `- First item with **bold** text
- [ ] A task item

:::note
Callout lead paragraph.

- callout list entry
:::

> [!WARNING]
> Alert lead paragraph.
>
> - alert list entry

:::question
Where should conflicts live?

- [ ] Local only
- [ ] Server-side
:::

Closing paragraph.
`;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(doc = DOC): Promise<HTMLDivElement> {
  const blocks = parseMarkdownToBlocks(doc);
  const index = indexQuestionBlocks(blocks);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <>
      {blocks.map((block) => {
        const question = index.find((q) => q.blockId === block.id);
        return (
          <BlockRenderer
            key={block.id}
            block={block}
            question={question}
            questionTotal={index.length}
            onAnswerQuestion={() => {}}
          />
        );
      })}
    </>,
  ));
  return host;
}

function blockOf(container: HTMLElement, selector: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el.closest<HTMLElement>('[data-block-id]')!;
}

describe.if(hasDom)('semantic target graph over rendered blocks', () => {
  test('a real list item still targets its text, not its marker', async () => {
    const { buildSemanticTargetGraph, resolveSemanticTargetAtPoint } = targeting!;
    const el = await mount();
    const item = Array.from(el.querySelectorAll<HTMLElement>('[data-block-id]'))
      .find((b) => b.textContent?.includes('First item'))!;
    const graph = buildSemanticTargetGraph(el);
    const target = graph.byKey.get(`${item.dataset.blockId}:block`)!;
    expect(target.element).not.toBe(item);
    expect(target.element.textContent).toBe('First item with bold text');
    expect(target.label).toStartWith('list item:');
    const marker = item.firstElementChild as HTMLElement;
    expect(marker.matches('.select-none')).toBe(true);
    expect(resolveSemanticTargetAtPoint(graph, marker)?.key).toBe(target.key);

    // A task item's marker is a checkbox; the same rule applies.
    const task = Array.from(el.querySelectorAll<HTMLElement>('[data-block-id]'))
      .find((b) => b.textContent?.includes('A task item'))!;
    const taskTarget = graph.byKey.get(`${task.dataset.blockId}:block`)!;
    expect(taskTarget.element.textContent).toBe('A task item');
    expect(taskTarget.label).toStartWith('list item:');
  });

  test('a callout or alert whose body holds a list targets the whole block', async () => {
    const { buildSemanticTargetGraph, resolveSemanticTargetAtPoint } = targeting!;
    const el = await mount();
    for (const selector of ['[data-block-type="directive"]:not(fieldset)', '[data-block-type="alert"]']) {
      const block = blockOf(el, selector);
      const graph = buildSemanticTargetGraph(el);
      const target = graph.byKey.get(`${block.dataset.blockId}:block`)!;
      expect(target.element).toBe(block);
      expect(target.label).not.toStartWith('list item');
      const entry = Array.from(block.querySelectorAll<HTMLElement>('span, li, p'))
        .find((n) => /list entry$/.test(n.textContent ?? '') && n.children.length === 0)!;
      expect(resolveSemanticTargetAtPoint(graph, entry)?.key).toBe(target.key);
    }
  });

  test('a question card is one block whose parts the pointer and Vim reach', async () => {
    const { buildSemanticTargetGraph, resolveSemanticTargetAtPoint, moveSemanticTarget, getSemanticTargetChildren } = targeting!;
    const el = await mount();
    const card = el.querySelector<HTMLElement>('fieldset.question-block')!;
    const graph = buildSemanticTargetGraph(el);
    const cardTarget = graph.byKey.get(`${card.dataset.blockId}:block`)!;
    expect(cardTarget.element).toBe(card);

    const parts = getSemanticTargetChildren(graph, cardTarget).map((t) => t.element.textContent);
    expect(parts).toEqual(['Where should conflicts live?', 'Local only', 'Server-side']);

    // Pointer: each choice row (its padding and radio included) is that choice.
    const rows = card.querySelectorAll<HTMLElement>('label[data-question-option]');
    expect(resolveSemanticTargetAtPoint(graph, rows[0])?.element.textContent).toBe('Local only');
    expect(resolveSemanticTargetAtPoint(graph, rows[1].querySelector('input')!)?.element.textContent).toBe('Server-side');
    // The eyebrow is never a target.
    expect(resolveSemanticTargetAtPoint(graph, card.firstElementChild as HTMLElement)).toBeNull();

    // Vim: into the card, across its parts, back out, and on to the next block.
    const prompt = moveSemanticTarget(graph, cardTarget, 'child');
    expect(prompt.element.textContent).toBe('Where should conflicts live?');
    const first = moveSemanticTarget(graph, prompt, 'next-sibling');
    expect(first.element.textContent).toBe('Local only');
    expect(moveSemanticTarget(graph, first, 'parent').key).toBe(cardTarget.key);
    const next = moveSemanticTarget(graph, first, 'next-block');
    expect(next.element.textContent).toBe('Closing paragraph.');
    expect(moveSemanticTarget(graph, next, 'previous-block').key).toBe(cardTarget.key);
  });

  // A card whose context holds a table and a code fence: before the card was
  // checked first, the graph took the whole card for a table (or a code
  // block) because it now contains one.
  test('a question card whose context holds a table or code is still one card of parts', async () => {
    const { buildSemanticTargetGraph, resolveSemanticTargetAtPoint, getSemanticTargetChildren } = targeting!;
    const el = await mount(`:::question\nSet the numbers?\n\n| Limit | Proposed |\n| --- | --- |\n| Agents | 3 |\n\n\`\`\`sh\nrun it\n\`\`\`\n\n- [ ] OK\n- [ ] Change\n:::\n\nAfter.\n`);
    const card = el.querySelector<HTMLElement>('fieldset.question-block')!;
    // The context's blocks carry no block id of their own.
    expect(card.querySelectorAll('[data-block-id]').length).toBe(0);
    const graph = buildSemanticTargetGraph(el);
    const cardTarget = graph.byKey.get(`${card.dataset.blockId}:block`)!;
    expect(cardTarget.element).toBe(card);
    expect(graph.byKey.has(`${card.dataset.blockId}:table`)).toBe(false);
    expect(graph.byKey.has(`${card.dataset.blockId}:code`)).toBe(false);
    const context = card.querySelector<HTMLElement>('[data-question-part="context"]')!;
    expect(getSemanticTargetChildren(graph, cardTarget).map((t) => t.element)).toContain(context);
    // A table cell and a code line in the context resolve to the context part.
    const cell = card.querySelector<HTMLElement>('td')!;
    expect(resolveSemanticTargetAtPoint(graph, cell, { clientX: 0, clientY: 0 })?.element).toBe(context);
    expect(resolveSemanticTargetAtPoint(graph, card.querySelector<HTMLElement>('pre code')!)?.element).toBe(context);
  });
});
