/**
 * The question card's phone fix lives in inbox.css and leans on the DOM ui's
 * QuestionBlock draws: the footer row (`fieldset.question-block > div.border-t`),
 * the right-aligned box holding Accept recommended and the host's status
 * (`> div.ml-auto > [data-question-host-footer]`), and the choice controls
 * (`input[data-question-control]`). If ui reshapes that DOM, the rules stop
 * matching and the owner's phone shows "Acce pt reco mme nded" and solid black
 * radios again, with nothing failing but a screenshot. This renders the card
 * as the Inbox does (a host status in the footer, a note picked, Accept
 * recommended offered) and checks every selector of those rules still finds
 * its element. The layout itself is proved in a real browser
 * (tests/e2e/inbox-mobile-fixes.spec.ts).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { emptyQuestionAnswer, indexQuestionBlocks, type QuestionAnswer } from '@plannotator/core/question-block';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { BlockRenderer } from '@plannotator/ui/components/BlockRenderer';

const hasDom = typeof document !== 'undefined';

const DOC = `:::question
Keep the lede, or shorter?

- [ ] Shorter: "Work in flight, by stage."
- [ ] Keep it

Recommended: Shorter
:::

:::question-multi
Which columns start folded?

- [ ] Icebox
- [ ] Dropped

Recommended: Icebox, Dropped
:::
`;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** A selector list split at its own commas, not those inside :is() or :not(). */
function topLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out;
}

/** The selectors of inbox.css's footer and control rules, without the `.pn-inbox` scope or pseudo parts. */
function cardSelectors(): string[] {
  const css = readFileSync(resolve(import.meta.dir, 'inbox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  for (const match of css.matchAll(/^\s*([^{}@/][^{}]*)\{/gm)) {
    for (const raw of topLevel(match[1]!)) {
      const selector = raw.trim();
      if (!/question-block > div\.border-t|input\[data-question-control\]/.test(selector)) continue;
      out.add(
        selector
          .replace(/^\.pn-inbox\s+/, '')
          .replace(/::before/g, '')
          .replace(/:(hover|focus-visible|focus-within|checked|disabled)/g, '')
          .trim(),
      );
    }
  }
  return [...out];
}

test.skipIf(!hasDom)('every selector of the card footer and control rules finds its element in the card ui draws', async () => {
  const blocks = parseMarkdownToBlocks(DOC);
  const index = indexQuestionBlocks(blocks);
  const noteOnly: QuestionAnswer = { ...emptyQuestionAnswer(index[0]!), note: 'A note.' };
  const tick: QuestionAnswer = { ...emptyQuestionAnswer(index[1]!), selected: ['Icebox'], note: 'Shipped too.' };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <div>
        {blocks.map((block) => {
          const question = index.find((q) => q.blockId === block.id);
          return (
            <BlockRenderer
              key={block.id}
              block={block}
              question={question}
              questionTotal={index.length}
              questionAnswer={question ? (question === index[0] ? noteOnly : tick) : undefined}
              onAnswerQuestion={() => {}}
              renderQuestionFooter={() => <span className="ib-qfoot-st">Picked 8:48 AM · in your draft</span>}
            />
          );
        })}
      </div>,
    ),
  );
  // The state the owner saw: Accept recommended offered beside the host's status.
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Accept recommended')).toBe(true);
  const selectors = cardSelectors();
  expect(selectors.length).toBeGreaterThan(8);
  const missing = selectors.filter((selector) => host!.querySelector(selector) === null);
  expect(missing).toEqual([]);
  // Radios and checkboxes both carry the control mark the drawn controls key on.
  expect(host.querySelectorAll('input[type="radio"][data-question-control]').length).toBe(2);
  expect(host.querySelectorAll('input[type="checkbox"][data-question-control]').length).toBe(2);
});

test('the drawn controls are the same for a touch screen and for iOS and iPadOS WebKit (a trackpad iPad)', () => {
  const css = readFileSync(resolve(import.meta.dir, 'inbox.css'), 'utf8');
  const coarse = /\/\* drawn-controls:start \*\/\n@media \(pointer: coarse\) \{\n([\s\S]*?)\n\}\n\/\* drawn-controls:end \*\//.exec(css)?.[1];
  const ios = /@supports \(-webkit-touch-callout: none\) \{\n([\s\S]*?)\n\}\n/.exec(css.slice(css.indexOf('/* drawn-controls:end */')))?.[1];
  expect(coarse).toBeTruthy();
  expect(coarse).toContain('appearance: none');
  expect(ios).toBe(coarse);
});

/**
 * With the page pinned for a keyboard (phone.ts trackKeyboard), a focused field in the thread hides the reply foot.
 * A radio or a checkbox opens no keyboard: picking a question's option must never hide Reply. The rule's field list
 * is read from inbox.css and checked against the controls ui draws (happy-dom misreads a descendant combinator inside
 * :has(), so the list is matched against the focused element itself).
 */
test.skipIf(!hasDom)("picking a question's option never hides the reply foot; a field that takes the keyboard does", async () => {
  const css = readFileSync(resolve(import.meta.dir, 'inbox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /:root\[data-ib-keyboard-pin\] \.ib-pane:has\(\.ib-pbody (:is\((?:[^()]|\([^()]*\))*\)):focus\) \.ib-pfoot\s*\{\s*display:\s*none;/.exec(css);
  expect(rule).toBeTruthy();
  const fields = rule![1]!;
  const blocks = parseMarkdownToBlocks(DOC);
  const index = indexQuestionBlocks(blocks);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <div>
        {blocks.map((block) => {
          const question = index.find((q) => q.blockId === block.id);
          return (
            <BlockRenderer
              key={block.id}
              block={block}
              question={question}
              questionTotal={index.length}
              questionAnswer={question ? emptyQuestionAnswer(question) : undefined}
              onAnswerQuestion={() => {}}
            />
          );
        })}
        <input type="text" aria-label="Note" />
        <textarea aria-label="Note" />
      </div>,
    ),
  );
  const radio = host.querySelector<HTMLInputElement>('input[type="radio"][data-question-control]')!;
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"][data-question-control]')!;
  expect(radio.matches(fields)).toBe(false);
  expect(box.matches(fields)).toBe(false);
  expect(host.querySelector('input[type="text"]')!.matches(fields)).toBe(true);
  expect(host.querySelector('textarea')!.matches(fields)).toBe(true);
});
