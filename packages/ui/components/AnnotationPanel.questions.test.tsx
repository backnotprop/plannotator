/**
 * AnnotationPanel's Questions section (`questionRows`, DOM-gated).
 *
 * What regresses if this fails: answers show twice (as a Questions row AND a
 * Comment card), a row click stops reaching the host (no jump to the card),
 * an answer whose question was edited away vanishes from the panel instead
 * of listing Unanchored, or a host that passes no rows loses its answers
 * from the timeline.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks } from '@plannotator/core/question-block';
import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';
import { buildQuestionPanelRows, questionAnswerToAnnotation, type QuestionPanelRow } from '../utils/questionAnswers';

const hasDom = typeof document !== 'undefined';

const DOC = `# Plan

:::question
Where should conflicts live?

- [ ] Local only
- [ ] Server-side
:::

:::question-text
Describe the test.
:::
`;
const blocks = parseMarkdownToBlocks(DOC);
const [q1] = indexQuestionBlocks(blocks);
const answer = questionAnswerToAnnotation(q1.blockId, {
  v: 1, key: q1.question.key, kind: 'single', prompt: q1.question.prompt, selected: ['Local only'],
}, 1);
const orphan = questionAnswerToAnnotation('', {
  v: 1, key: 'q-deadbeef', kind: 'single', prompt: 'An old question?', selected: ['Yes'],
}, 2);
const comment: Annotation = {
  id: 'c1', blockId: blocks[0].id, startOffset: 0, endOffset: 4, type: AnnotationType.COMMENT, text: 'Rename this', originalText: 'Plan', createdA: 3,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(ui);
  });
  return host;
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
});

const cardIds = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-annotation-id]')).map((c) => c.getAttribute('data-annotation-id'));

describe('AnnotationPanel Questions section', () => {
  test.skipIf(!hasDom)('answers list as Questions rows, not comment cards; a row click reaches the host', async () => {
    const annotations = [answer, comment];
    const rows = buildQuestionPanelRows(blocks, annotations);
    const selected: QuestionPanelRow[] = [];
    const el = await mount(
      <AnnotationPanel
        isOpen
        annotations={annotations}
        blocks={blocks}
        onSelect={() => {}}
        onDelete={() => {}}
        selectedId={null}
        questionRows={rows}
        onSelectQuestion={(row) => selected.push(row)}
      />,
    );
    const rowEls = Array.from(el.querySelectorAll<HTMLElement>('[data-question-row]'));
    expect(rowEls.map((r) => r.dataset.questionRowStatus)).toEqual(['answered', 'open']);
    expect(rowEls[0].textContent).toContain('Local only');
    expect(rowEls[1].textContent).toContain('Not answered yet');
    // The comment stays a card; the answer does not become one.
    expect(cardIds(el)).toEqual(['c1']);
    await act(async () => { rowEls[1].click(); });
    expect(selected.map((r) => r.key)).toEqual([rows[1].key]);
  });

  test.skipIf(!hasDom)('an answer whose question is gone is Unanchored and can be removed', async () => {
    const annotations = [orphan];
    const deleted: string[] = [];
    const el = await mount(
      <AnnotationPanel
        isOpen
        annotations={annotations}
        blocks={blocks}
        onSelect={() => {}}
        onDelete={(id) => deleted.push(id)}
        selectedId={null}
        questionRows={buildQuestionPanelRows(blocks, annotations)}
      />,
    );
    const orphanRow = el.querySelector<HTMLElement>('[data-question-row="q-deadbeef"]')!;
    expect(orphanRow.querySelector('[data-annotation-unanchored]')).not.toBeNull();
    expect(orphanRow.textContent).toContain('An old question?');
    await act(async () => {
      Array.from(orphanRow.querySelectorAll('button')).find((b) => b.textContent === 'Remove answer')!.click();
    });
    expect(deleted).toEqual([orphan.id]);
  });

  test.skipIf(!hasDom)('without questionRows the panel lists answers as it always did', async () => {
    const el = await mount(
      <AnnotationPanel
        isOpen
        annotations={[answer, comment]}
        blocks={blocks}
        onSelect={() => {}}
        onDelete={() => {}}
        selectedId={null}
      />,
    );
    expect(el.querySelector('[data-questions-panel]')).toBeNull();
    expect(cardIds(el).sort()).toEqual([answer.id, 'c1'].sort());
  });
});
