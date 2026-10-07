/**
 * Host-controlled decision recording and status tag on question cards
 * (Workspaces lets the reviewer switch a `Decision: when answered` question's
 * recording off, and draws its own status tag).
 *
 * What regresses if this fails: the "Records a decision" tag stops being a
 * real toggle (no button, no aria-pressed, the host never hears the click);
 * switching recording off still shows "Answering this records a decision";
 * a read-only card lets the reviewer flip it; `statusTag: 'none'` takes the
 * decision tag with it; or a card given none of these props changes markup
 * (Plannotator passes none of them).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks, type IndexedQuestion } from '@plannotator/core/question-block';
import { parseMarkdownToBlocks } from '../../utils/parser';
import { BlockRenderer } from '../BlockRenderer';

const hasDom = typeof document !== 'undefined';
// Viewer reads the DOM at module scope; load it only under DOM_TESTS.
const viewerModule = hasDom ? await import('../Viewer') : null;

const DOC = `:::question
Where should losing versions be kept?

Decision: when answered

- [ ] Local
- [ ] Server
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

type Props = Partial<React.ComponentProps<typeof BlockRenderer>>;

function Cards({ extra = {}, readOnly = false }: { extra?: Props; readOnly?: boolean }) {
  const blocks = parseMarkdownToBlocks(DOC);
  const index = indexQuestionBlocks(blocks);
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
            onAnswerQuestion={readOnly ? undefined : () => {}}
            {...extra}
          />
        );
      })}
    </div>
  );
}

/** A host that keeps the recording state itself, keyed by question key. */
function ToggleHost({ toggles, readOnly = false }: { toggles: Array<[string, boolean]>; readOnly?: boolean }) {
  const [off, setOff] = useState<Record<string, boolean>>({});
  const blocks = parseMarkdownToBlocks(DOC);
  const index = indexQuestionBlocks(blocks);
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
            onAnswerQuestion={readOnly ? undefined : () => {}}
            questionDecisionRecording={question ? !off[question.question.key] : undefined}
            onToggleQuestionDecisionRecording={(key, next) => {
              toggles.push([key, next]);
              setOff((current) => ({ ...current, [key]: !next }));
            }}
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
});

const cards = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question-key]'));
const toggle = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('button[data-question-decision-toggle]');
// Assertions compare against null rather than passing elements to expect():
// a failing matcher that pretty-prints a happy-dom node never finishes.
const decisionRow = (card: HTMLElement) => card.querySelector('[data-question-decision-row]');
const tagWith = (card: HTMLElement, text: string) =>
  Array.from(card.querySelectorAll<HTMLElement>('span, button')).find((n) => n.textContent === text) ?? null;

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('QuestionBlock decision recording toggle', () => {
  test.skipIf(!hasDom)('with a handler the tag is a pressed toggle button that reports key and next state', async () => {
    const toggles: Array<[string, boolean]> = [];
    const el = await mount(<ToggleHost toggles={toggles} />);
    const [flagged] = cards(el);
    const button = toggle(flagged)!;
    expect(button !== null).toBe(true);
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(decisionRow(flagged) !== null).toBe(true);

    await click(button);
    expect(toggles).toEqual([[flagged.dataset.questionKey!, false]]);

    // Off: the same toggle, unpressed and drawn off; the row is gone.
    const off = cards(el)[0];
    const offButton = toggle(off)!;
    expect(offButton.getAttribute('aria-pressed')).toBe('false');
    expect(offButton.textContent).toBe(button.textContent);
    expect(offButton.style.outlineStyle).toBe('dotted');
    // Dimmed by the theme's muted-foreground, never by opacity: 60% opacity on
    // primary text fell under 3:1 in the default light theme.
    expect(offButton.style.color).toBe('var(--muted-foreground)');
    expect(offButton.style.opacity).toBe('');
    expect(decisionRow(off) === null).toBe(true);
    expect(off.dataset.questionDecision).toBe('on-answer');
    expect(off.dataset.questionDecisionRecording).toBe('off');

    await click(offButton);
    expect(toggles[1]).toEqual([flagged.dataset.questionKey!, true]);
    expect(toggle(cards(el)[0])!.getAttribute('aria-pressed')).toBe('true');
    expect(decisionRow(cards(el)[0]) !== null).toBe(true);
  });

  test.skipIf(!hasDom)('a recorded decision gets no toggle; a plain question gets none without a host state', async () => {
    const el = await mount(<ToggleHost toggles={[]} />);
    const linked = cards(el)[1];
    expect(toggle(linked) === null).toBe(true);
    expect(linked.dataset.questionDecisionRecording).toBeUndefined();
    expect(decisionRow(linked) !== null).toBe(true);
    // The handler alone does not reach a question with no decision line; a
    // recording state does (QuestionBlock.decisionAnyQuestion.test.tsx).
    const handlerOnly = await mount(<Cards extra={{ onToggleQuestionDecisionRecording: () => {} }} />);
    const plain = cards(handlerOnly)[2];
    expect(toggle(plain) === null).toBe(true);
    expect(plain.dataset.questionDecisionRecording).toBeUndefined();
  });

  test.skipIf(!hasDom)('a recorded decision keeps its row even when the host says recording is off', async () => {
    const el = await mount(<Cards extra={{ questionDecisionRecording: false, onToggleQuestionDecisionRecording: () => {} }} />);
    const linked = cards(el)[1];
    expect(decisionRow(linked)?.querySelector('a') !== null).toBe(true);
    expect(toggle(linked) === null).toBe(true);
  });

  test.skipIf(!hasDom)('a read-only card draws the tag as it stands, not as a button', async () => {
    const el = await mount(<Cards readOnly extra={{ questionDecisionRecording: false, onToggleQuestionDecisionRecording: () => {} }} />);
    const flagged = cards(el)[0];
    expect(toggle(flagged) === null).toBe(true);
    expect(flagged.querySelector('button') === null).toBe(true);
    const tag = tagWith(flagged, 'Records a decision')!;
    expect(tag.tagName).toBe('SPAN');
    expect(tag.style.outlineStyle).toBe('dotted');
    expect(decisionRow(flagged) === null).toBe(true);
  });

  test.skipIf(!hasDom)('decisionRecording false without a handler: static off tag, row hidden', async () => {
    const el = await mount(<Cards extra={{ questionDecisionRecording: false }} />);
    const flagged = cards(el)[0];
    expect(toggle(flagged) === null).toBe(true);
    expect(tagWith(flagged, 'Records a decision')!.style.outlineStyle).toBe('dotted');
    expect(decisionRow(flagged) === null).toBe(true);
    expect(flagged.dataset.questionDecisionRecording).toBe('off');
  });

  test.skipIf(!hasDom)('no host props: the card markup is exactly what it was', async () => {
    // useId differs between roots; everything else must match.
    const html = (el: HTMLElement) => el.innerHTML.replace(/(q-(?:prompt|context|suggest|note)-|question-)[A-Za-z0-9_«»]+/g, '$1#');
    const plainEl = await mount(<Cards />);
    const before = html(plainEl);
    // Defaults spelled out are the same card: the new props add nothing unless set.
    const el2 = document.createElement('div');
    document.body.appendChild(el2);
    const root2 = createRoot(el2);
    await act(async () => root2.render(<Cards extra={{ questionStatusTag: 'card' }} />));
    expect(html(el2)).toBe(before);
    await act(async () => root2.unmount());
    el2.remove();
    // Sentinels of the unchanged card: the tag is a plain span, there is no
    // recording attribute and the flagged row shows.
    const flagged = cards(plainEl)[0];
    expect(toggle(flagged) === null).toBe(true);
    expect(tagWith(flagged, 'Records a decision')!.getAttribute('style') === null).toBe(true);
    expect(flagged.hasAttribute('data-question-decision-recording')).toBe(false);
    expect(decisionRow(flagged) !== null).toBe(true);
  });
});

describe('QuestionBlock statusTag', () => {
  test.skipIf(!hasDom)("'none' hides the status tag and keeps the decision tags", async () => {
    const el = await mount(<Cards extra={{ questionStatusTag: 'none' }} />);
    const [flagged, linked, plain] = cards(el);
    for (const card of [flagged, linked, plain]) {
      expect(tagWith(card, 'Open') === null).toBe(true);
    }
    expect(tagWith(flagged, 'Records a decision') !== null).toBe(true);
    expect(tagWith(linked, 'Decision') !== null).toBe(true);
    // The status itself is still on the card for the host to read.
    expect(plain.dataset.questionStatus).toBe('open');

    const shown = await mount(<Cards />);
    expect(tagWith(cards(shown)[2], 'Open') !== null).toBe(true);
  });
});

describe('Viewer question host props', () => {
  test.skipIf(!hasDom)('threads recording per question, the toggle handler and the status tag to the cards', async () => {
    const Viewer = viewerModule!.Viewer;
    const asked: string[] = [];
    const toggles: Array<[string, boolean]> = [];
    const blocks = parseMarkdownToBlocks(DOC);
    const render = (readOnly: boolean) => (
      <Viewer
        blocks={blocks}
        markdown={DOC}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        inputMethod="drag"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        readOnly={readOnly}
        onAnswerQuestion={() => {}}
        questionDecisionRecording={(q: IndexedQuestion) => {
          asked.push(q.question.key);
          return false;
        }}
        onToggleQuestionDecisionRecording={(key, next) => toggles.push([key, next])}
        questionStatusTag="none"
      />
    );
    const el = await mount(render(false));
    const flagged = cards(el)[0];
    expect(asked).toContain(flagged.dataset.questionKey!);
    expect(decisionRow(flagged) === null).toBe(true);
    expect(tagWith(cards(el)[2], 'Open') === null).toBe(true);
    await click(toggle(flagged)!);
    expect(toggles).toEqual([[flagged.dataset.questionKey!, true]]);

    await act(async () => root!.render(render(true)));
    expect(toggle(cards(el)[0]) === null).toBe(true);
  });
});
