/**
 * A question's scenario table on its card (approval "question-scenario-table").
 *
 * What regresses if this fails: the table stops being a real table (a screen
 * reader loses its row and column headers or its name); a header names the
 * wrong option; the verdict and detail of a cell run together; the picked
 * option's column stops taking the picked fill (or another column takes it);
 * the narrow form stops being a list with each scenario a heading; an
 * answered, read-only card hides the table; a question parsed without the
 * field (an older record, a table that does not qualify) breaks or loses its
 * table.
 *
 * DOM-gated (DOM_TESTS=1). Container queries do not run here: both forms are
 * in the DOM and the browser shows one (the Inbox e2e checks which).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks, type IndexedQuestion, type QuestionAnswer } from '@plannotator/core/question-block';
import type { Annotation } from '../../types';
import { parseMarkdownToBlocks } from '../../utils/parser';
import { collectQuestionAnswers, upsertQuestionAnswerAnnotation } from '../../utils/questionAnswers';
import { BlockRenderer } from '../BlockRenderer';

const hasDom = typeof document !== 'undefined';

const TABLE = [
  '| Scenario | Nowhere | Local only | Server-side |',
  '| --- | --- | --- | --- |',
  '| You edit offline on a plane | Lost — nothing says so | Kept — in the note\'s History | Kept — on every device |',
  '| Ada and Bob edit the same line | Lost | Kept on Bob\'s laptop — Ada can\'t see it | Kept — both see it |',
].join('\n');

const card = (table = TABLE) => `:::question
Where should an edit that loses a sync conflict go?

- [ ] Nowhere — the losing edit is dropped
- [ ] Local only, purged after 30 days — kept on the device that lost
    Pros: no server change
    Cons: other devices never see it
- [ ] Server-side per user — kept on our server

Recommended: Local only, purged after 30 days
Why: covers a plane or a train with no server work.

${table}
:::`;

let latest: Annotation[] = [];

function Harness({ markdown, answer, strip = false }: { markdown: string; answer?: QuestionAnswer; strip?: boolean }) {
  const blocks = parseMarkdownToBlocks(markdown);
  const index: IndexedQuestion[] = indexQuestionBlocks(blocks, { decisionLines: false, optionLines: true }).map((q) => {
    if (!strip) return q;
    const { scenarios: _s, ...question } = q.question;
    return { ...q, question };
  });
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  latest = annotations;
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
            questionAnswer={answer ?? (question ? answers.get(question.question.key) : undefined)}
            onAnswerQuestion={answer ? undefined : (blockId, next, key) => setAnnotations((current) => upsertQuestionAnswerAnnotation(current, blockId, next, key))}
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

// InlineMarkdown draws typographic apostrophes: fold them back.
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').replace(/’/g, "'").trim();
const onCells = (el: Element) => [...el.querySelectorAll('[data-question-scenarios-table] [data-question-scenario-on]')];
const pickLabel = async (el: Element, label: string) => {
  const row = [...el.querySelectorAll('label[data-question-option]')].find((r) => text(r.querySelector('[data-question-part="choice"] > span')) === label)!;
  await act(async () => (row.querySelector('input') as HTMLInputElement).click());
};

describe('the scenario table', () => {
  test.skipIf(!hasDom)('is a real table under Why and above Trade-offs: a caption, column and row headers, verdict then detail', async () => {
    const el = await mount(<Harness markdown={card()} />);
    const section = el.querySelector('[data-question-part="scenarios"]')!;
    expect(section).not.toBeNull();
    const parts = [...el.querySelectorAll('[data-question-part]')].map((p) => p.getAttribute('data-question-part'));
    expect(parts.indexOf('why')).toBeLessThan(parts.indexOf('scenarios'));
    expect(parts.indexOf('scenarios')).toBeLessThan(parts.indexOf('tradeoffs'));
    const table = section.querySelector('table')!;
    expect(text(table.querySelector('caption'))).toBe('Scenarios');
    const cols = [...table.querySelectorAll('thead th[scope="col"]')].map(text);
    expect(cols).toEqual(['Scenario', 'Nowhere', 'Local only', 'Server-side']);
    expect([...table.querySelectorAll('tbody th[scope="row"]')].map(text)).toEqual(['You edit offline on a plane', 'Ada and Bob edit the same line']);
    const cell = table.querySelectorAll('tbody tr')[1]!.querySelectorAll('td')[1]!;
    const [verdict, detail] = [...cell.children];
    expect(text(verdict)).toBe("Kept on Bob's laptop");
    expect(verdict!.className).toContain('font-semibold');
    expect(text(detail)).toContain("Ada can't see it");
    // The table left the context: it is drawn once, in the section.
    expect(el.querySelectorAll('table').length).toBe(1);
  });

  test.skipIf(!hasDom)('the picked option\'s column takes the picked fill, and moves with the pick', async () => {
    const el = await mount(<Harness markdown={card()} />);
    expect(onCells(el)).toHaveLength(0);
    await pickLabel(el, 'Local only, purged after 30 days');
    const on = onCells(el);
    // Its header and one cell per scenario, all in the third column.
    expect(on).toHaveLength(3);
    expect(on.every((c) => (c as HTMLTableCellElement).cellIndex === 2)).toBe(true);
    expect(text(on[0])).toContain('picked');
    await pickLabel(el, 'Nowhere');
    expect(onCells(el).every((c) => (c as HTMLTableCellElement).cellIndex === 1)).toBe(true);
    expect(latest.length).toBe(1);
  });

  test.skipIf(!hasDom)('the narrow form is a list: each scenario a heading, then one line per option, the picked one filled', async () => {
    const el = await mount(<Harness markdown={card()} />);
    await pickLabel(el, 'Server-side per user');
    const list = el.querySelector('[data-question-scenarios-list] > ul')!;
    expect(list.getAttribute('aria-label')).toBe('Scenarios');
    const items = [...list.children];
    expect(items.map((li) => li.tagName)).toEqual(['LI', 'LI']);
    const heading = items[0]!.querySelector('[role="heading"]')!;
    expect(text(heading)).toBe('You edit offline on a plane');
    const lines = [...items[0]!.querySelectorAll('li')];
    expect(lines.map((l) => [...l.children].map(text))).toEqual([
      ['Nowhere', 'Lost — nothing says so'],
      ['Local only', "Kept — in the note's History"],
      ['Server-side, picked', 'Kept — on every device'],
    ]);
    expect(lines.map((l) => l.hasAttribute('data-question-scenario-on'))).toEqual([false, false, true]);
  });

  test.skipIf(!hasDom)('an answered, read-only card still shows it, its column filled', async () => {
    const answer: QuestionAnswer = { v: 1, key: '', kind: 'single', prompt: '', selected: ['Nowhere'] };
    const el = await mount(<Harness markdown={card()} answer={answer} />);
    expect(el.querySelector('input[data-question-control]')!.hasAttribute('disabled')).toBe(true);
    expect(el.querySelector('[data-question-scenarios-table]')).not.toBeNull();
    expect(onCells(el).every((c) => (c as HTMLTableCellElement).cellIndex === 1)).toBe(true);
  });

  test.skipIf(!hasDom)('a question without the field (an older record) draws no section and nothing breaks', async () => {
    const el = await mount(<Harness markdown={card()} strip />);
    expect(el.querySelector('[data-question-part="scenarios"]')).toBeNull();
    expect(el.querySelector('[data-question-part="why"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('a table that does not qualify stays in the context, drawn as before', async () => {
    const odd = TABLE.replace('| Scenario | Nowhere |', '| Scenario | Somewhere |');
    const el = await mount(<Harness markdown={card(odd)} />);
    expect(el.querySelector('[data-question-part="scenarios"]')).toBeNull();
    expect(text(el)).toContain('Somewhere');
  });
});
