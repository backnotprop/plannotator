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
import { exportAnnotations, parseMarkdownToBlocks } from '../../utils/parser';
import { buildQuestionPanelRows, collectQuestionAnswers, upsertQuestionAnswerAnnotation } from '../../utils/questionAnswers';
import { BlockRenderer } from '../BlockRenderer';
import type { QuestionBlockProps } from './QuestionBlock';

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

function Harness({ markdown, readOnly = false, initial = [], statusLabel }: { markdown: string; readOnly?: boolean; initial?: Annotation[]; statusLabel?: QuestionBlockProps['statusLabel'] }) {
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
            questionStatusLabel={statusLabel}
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

  // The owner's 0.28.17 report: a choice longer than 200 characters was cut
  // to 200 when the answer was read back, so it never showed as picked here
  // and the Inbox refused it as "not one of the question's choices".
  const LONG_CHOICE =
    'Spike first. Find out what the sign-in grants (a Claude subscription paying for turns the platform runs?) and whether Anthropic allows it for a third-party product; the placeholder stays off the product until both answers are in';
  for (const [form, line] of [
    ['no separator', LONG_CHOICE],
    ["a ' — ' why", `${LONG_CHOICE} — keeps it reversible`],
    ["a ' - ' why", `${LONG_CHOICE} - keeps it reversible`],
  ] as const) {
    test.skipIf(!hasDom)(`a choice longer than 200 characters (${form}) is saved, shown and exported whole`, async () => {
      const el = await mount(<Harness markdown={`:::question\nWhich way first?\n\n- [ ] ${line}\n- [ ] Ship it now\n:::\n`} />);
      await click(rowText(cards(el)[0], 'Spike first.'));
      expect(answerOf(0)?.selected).toEqual([LONG_CHOICE]);
      expect(cards(el)[0].getAttribute('data-question-status')).toBe('answered');
      expect(cards(el)[0].querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')).toHaveLength(1);
      expect(latest[0].text).toBe(`Answer: ${LONG_CHOICE}`);
    });
  }

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
    // Each control is disabled (not the fieldset, so host footer actions stay live).
    const controls = card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control.disabled).toBe(true);
    expect(button(card, 'Skip')).toBeUndefined();
    expect(card.querySelector<HTMLInputElement>('input:checked')!.closest('label')!.textContent).toContain('Nowhere');
    expect(card.querySelector('textarea')!.value).toBe('keep it simple');
  });

  // The owner's report: a table in a question's context rendered as one
  // paragraph of pipes. The context goes through the document's own block
  // renderers now.
  test.skipIf(!hasDom)('the context renders block markdown with the document renderers', async () => {
    const markdown = [
      ':::question-text',
      '**5. Set the numbers.**',
      '',
      'Each of these is a cap; the numbers are **my** proposals.',
      '',
      '| Limit | Proposed |',
      '| --- | --- |',
      '| Agents at once | 3 |',
      '| Longest run | 60 minutes |',
      '',
      '- first point',
      '  that wraps',
      '- second point',
      '',
      '```sh',
      'echo  "kept  spacing"',
      '```',
      '',
      '> quoted',
      ':::',
    ].join('\n');
    const el = await mount(<Harness markdown={markdown} />);
    const context = cards(el)[0].querySelector<HTMLElement>('[data-question-part="context"]')!;
    const rows = Array.from(context.querySelectorAll('table tr')).map((tr) =>
      Array.from(tr.querySelectorAll('th, td')).map((c) => c.textContent),
    );
    expect(rows).toEqual([['Limit', 'Proposed'], ['Agents at once', '3'], ['Longest run', '60 minutes']]);
    expect(context.textContent).not.toContain('|');
    expect(context.querySelector('strong')?.textContent).toBe('my');
    // List items as the document draws them, the wrapped line kept in its item.
    const items = Array.from(context.querySelectorAll('[data-question-context-list] > div')).map((d) => d.textContent?.trim());
    expect(items).toEqual(['•first point\nthat wraps', '•second point']);
    expect(context.querySelector('pre code')?.textContent).toBe('echo  "kept  spacing"');
    expect(context.querySelector('blockquote')?.textContent).toBe('quoted');
    // Nothing inside the card claims a block id of its own.
    expect(context.querySelectorAll('[data-block-id]').length).toBe(0);
    expect(cards(el)[0].getAttribute('aria-describedby')).toBe(context.id);
  });

  // 0.28.2 pre-tag smoke: an answer saved on 0.28.1 quotes the bullet's first
  // line, which was its label then. It restored as "Answered" with nothing
  // picked.
  test.skipIf(!hasDom)('an answer saved under a 0.28.1 label restores picked, exports, and re-saves with the current label', async () => {
    const markdown = [
      ':::question',
      '**4. How does a Cloudflare-run agent show in the Machines tab?**',
      '',
      'Two ways to name it:',
      '',
      '- **One per session:** "ramos · cloud-3", "ramos · cloud-4". Each agent shows',
      '  as its own machine in the Machines tab.',
      '- **One per person:** "ramos · cloud", shared by all your cloud agents. A',
      '  short Machines tab.',
      '',
      '**Recommendation:** one per session.',
      ':::',
    ].join('\n');
    const blocks = parseMarkdownToBlocks(markdown);
    const [q] = indexQuestionBlocks(blocks);
    const oldLabel = '**One per session:** "ramos · cloud-3", "ramos · cloud-4". Each agent shows';
    const stored = upsertQuestionAnswerAnnotation([], q.blockId, {
      v: 1, key: q.question.key, kind: 'single', prompt: q.question.prompt, selected: [oldLabel],
    }, q.question.key);
    const el = await mount(<Harness markdown={markdown} initial={stored} />);
    const card = cards(el)[0];
    expect(card.getAttribute('data-question-status')).toBe('answered');
    expect(card.querySelector<HTMLInputElement>('input:checked')?.closest('label')?.textContent).toContain('One per session');

    // Untouched, it exports under the current label, as the recommendation.
    expect(exportAnnotations(blocks, latest)).toContain('Answer: One per session (your recommendation)');
    // The panel row reads the current label too.
    expect(buildQuestionPanelRows(blocks, latest)[0].answerText).toBe('One per session');

    // Changing the answer stores current labels only.
    await click(rowText(card, 'One per person'));
    expect(answerOf(0)?.selected).toEqual(['One per person']);
    await click(rowText(card, 'One per session'));
    expect(answerOf(0)?.selected).toEqual(['One per session']);
  });

  // Rows 37 and 38 of the Inbox stress test (the same cards in plan review and annotate).
  const UNMATCHED = [
    ':::question',
    'Which store backs the cache?',
    '',
    '- [ ] Redis',
    '- [ ] Memcached',
    '',
    'Recommended: SQLite on the box',
    ':::',
  ].join('\n');

  test.skipIf(!hasDom)('a choice question whose recommendation names none of its choices shows it, and Use fills Other', async () => {
    const el = await mount(<Harness markdown={UNMATCHED} />);
    const card = cards(el)[0];
    const line = card.querySelector<HTMLElement>('[data-question-suggested]');
    expect(line?.textContent).toContain('SQLite on the box');
    expect(card.getAttribute('aria-describedby')?.split(' ')).toContain(line!.id);
    await click(button(card, 'Use')!);
    expect(answerOf(0)).toMatchObject({ selected: [], other: 'SQLite on the box' });
    // Answered, the line goes (as a text question's does).
    expect(cards(el)[0].querySelector('[data-question-suggested]')).toBeNull();
  });

  test.skipIf(!hasDom)('a read-only card draws the Other row only when the answer used it', async () => {
    const [q] = indexQuestionBlocks(parseMarkdownToBlocks(UNMATCHED));
    const answer = (extra: Partial<QuestionAnswer>) =>
      upsertQuestionAnswerAnnotation([], q.blockId, { v: 1, key: q.question.key, kind: 'single', prompt: q.question.prompt, selected: [], ...extra }, q.question.key);
    const other = (el: HTMLElement) => cards(el)[0].querySelector<HTMLInputElement>('input[aria-label^="Other answer"]');

    let el = await mount(<Harness markdown={UNMATCHED} readOnly initial={answer({ selected: ['Redis'] })} />);
    expect(other(el)).toBeNull();
    await act(async () => root!.unmount());
    host!.remove();

    el = await mount(<Harness markdown={UNMATCHED} readOnly initial={answer({ other: 'Postgres' })} />);
    expect(other(el)?.value).toBe('Postgres');
    await act(async () => root!.unmount());
    host!.remove();

    // An editable card keeps the row to type into.
    el = await mount(<Harness markdown={UNMATCHED} />);
    expect(other(el)).not.toBeNull();
  });

  test.skipIf(!hasDom)('a host status label replaces the card status tag; undefined keeps the card own', async () => {
    const el = await mount(
      <Harness
        markdown={DOC}
        statusLabel={(question, status) => (question.number === 1 && status === 'answered' ? { label: 'host-label-sentinel', tone: 'open' } : undefined)}
      />,
    );
    await click(rowText(cards(el)[0], 'Nowhere'));
    await click(rowText(cards(el)[1], 'Dot'));
    expect(cards(el)[0].textContent).toContain('host-label-sentinel');
    expect(cards(el)[0].textContent).not.toContain('Answered');
    expect(cards(el)[1].textContent).toContain('Answered');
  });
});
