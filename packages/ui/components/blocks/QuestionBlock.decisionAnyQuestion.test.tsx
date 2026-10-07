/**
 * Decision recording on ANY question, and the separate opener for the host's
 * decision card (ui 0.52.1; Workspaces' Inbox, approved 2026-10-06: "the tag
 * is the switch" on every question, and "clicking the tag's words opens the
 * decision card").
 *
 * What regresses if this fails: a question without `Decision: when answered`
 * never offers the tag even when the host opts in (`questionDecisionScope:
 * 'any'`) and supplies a recording state, or offers it when the host did not
 * (including a 0.52.0 host that returns a boolean for every question without
 * opting in, which 0.52.0 documented as ignored); switching it on does not show the
 * "Answering this records a decision" row; with `onOpenDecision` the tag stays
 * one button (so the words cannot open the card), the two targets nest, the
 * opener does not hand the host an anchor element, or either target drops out
 * of the tab order; a read-only card becomes interactive; or a card given none
 * of the new props changes markup (Plannotator passes none of them).
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
Plain one?

- [ ] Yes
- [ ] No
:::

:::question
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
`;

type Props = Partial<React.ComponentProps<typeof BlockRenderer>>;

/** Renders every block; `perQuestion` adds props for each question block. */
function Cards({
  extra = {},
  readOnly = false,
  perQuestion,
}: {
  extra?: Props;
  readOnly?: boolean;
  perQuestion?: (q: IndexedQuestion) => Props;
}) {
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
            {...(question && perQuestion ? perQuestion(question) : {})}
          />
        );
      })}
    </div>
  );
}

/** A host that keeps the recording state itself: off unless the question
 *  asks for a decision, flipped by the toggle. */
function Host({
  toggles,
  opened,
  withOpener = true,
}: {
  toggles: Array<[string, boolean]>;
  opened?: Array<[string, HTMLElement]>;
  withOpener?: boolean;
}) {
  const [state, setState] = useState<Record<string, boolean>>({});
  return (
    <Cards
      perQuestion={(q) => ({
        questionDecisionRecording: state[q.question.key] ?? !!q.question.decisionOnAnswer,
        questionDecisionScope: 'any',
        onToggleQuestionDecisionRecording: (key, next) => {
          toggles.push([key, next]);
          setState((current) => ({ ...current, [key]: next }));
        },
        ...(withOpener ? { onOpenQuestionDecision: (key: string, anchor: HTMLElement) => opened?.push([key, anchor]) } : {}),
      })}
    />
  );
}

const roots: Array<{ root: Root; host: HTMLDivElement }> = [];

async function mount(node: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => root.render(node));
  return host;
}

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

const cards = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question-key]'));
const toggle = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('button[data-question-decision-toggle]');
const opener = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('button[data-question-decision-open]');
// Assertions compare against null rather than passing elements to expect():
// a failing matcher that pretty-prints a happy-dom node never finishes.
const decisionRow = (card: HTMLElement) => card.querySelector('[data-question-decision-row]');
const hasTagText = (card: HTMLElement) => (card.textContent ?? '').includes('Records a decision');

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Focusable controls in document (tab) order; none of these set tabindex. */
const tabbables = (el: HTMLElement) =>
  Array.from(el.querySelectorAll<HTMLElement>('button, input, textarea, a[href]')).filter(
    (n) => !(n as HTMLButtonElement).disabled && n.getAttribute('tabindex') !== '-1',
  );

describe('decision recording on a question without a decision line', () => {
  test.skipIf(!hasDom)('without the any scope a supplied state leaves the plain question alone (0.52.0)', async () => {
    // A 0.52.0 host may return a boolean for every question: the 0.52.0
    // contract said a question with no decision line ignores it.
    const el = await mount(<Cards extra={{ questionDecisionRecording: true, onToggleQuestionDecisionRecording: () => {}, onOpenQuestionDecision: () => {} }} />);
    const [plain, flagged] = cards(el);
    expect(hasTagText(plain)).toBe(false);
    expect(plain.hasAttribute('data-question-decision-recording')).toBe(false);
    expect(decisionRow(plain) === null).toBe(true);
    // The flagged question still gets its tag and the new opener.
    expect(opener(flagged) !== null).toBe(true);
  });

  test.skipIf(!hasDom)('with the any scope, shows the tag only when the host supplies a recording state', async () => {
    const none = await mount(<Cards extra={{ questionDecisionScope: 'any', onToggleQuestionDecisionRecording: () => {} }} />);
    const plainWithout = cards(none)[0];
    expect(hasTagText(plainWithout)).toBe(false);
    expect(plainWithout.hasAttribute('data-question-decision-recording')).toBe(false);

    const supplied = await mount(<Cards extra={{ questionDecisionScope: 'any', questionDecisionRecording: false }} />);
    const plainOff = cards(supplied)[0];
    expect(hasTagText(plainOff)).toBe(true);
    expect(plainOff.dataset.questionDecisionRecording).toBe('off');
    // The question's kind attribute does not move: it still has no decision line.
    expect(plainOff.hasAttribute('data-question-decision')).toBe(false);
    expect(decisionRow(plainOff) === null).toBe(true);
  });

  test.skipIf(!hasDom)('the toggle reports key and next state; on shows the row, off hides it', async () => {
    const toggles: Array<[string, boolean]> = [];
    const el = await mount(<Host toggles={toggles} withOpener={false} />);
    const plain = cards(el)[0];
    const key = plain.dataset.questionKey!;
    const button = toggle(plain)!;
    expect(button !== null).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.style.outlineStyle).toBe('dotted');
    expect(button.style.color).toBe('var(--muted-foreground)');
    expect(decisionRow(plain) === null).toBe(true);

    await click(button);
    expect(toggles).toEqual([[key, true]]);
    const on = cards(el)[0];
    expect(toggle(on)!.getAttribute('aria-pressed')).toBe('true');
    expect(toggle(on)!.getAttribute('style') === null).toBe(true);
    expect(decisionRow(on)?.textContent).toContain('Answering this records a decision');
    expect(on.dataset.questionDecisionRecording).toBe('on');

    await click(toggle(on)!);
    expect(toggles[1]).toEqual([key, false]);
    expect(decisionRow(cards(el)[0]) === null).toBe(true);
  });

  test.skipIf(!hasDom)('a recorded decision is untouched by a supplied state', async () => {
    const el = await mount(<Cards extra={{ questionDecisionScope: 'any', questionDecisionRecording: false, onToggleQuestionDecisionRecording: () => {}, onOpenQuestionDecision: () => {} }} />);
    const linked = cards(el)[2];
    expect(toggle(linked) === null).toBe(true);
    expect(opener(linked) === null).toBe(true);
    expect(hasTagText(linked)).toBe(false);
    expect(decisionRow(linked)?.querySelector('a') !== null).toBe(true);
  });
});

describe('the separate opener for the host decision card', () => {
  test.skipIf(!hasDom)('the diamond switches and the words open the card with their own element', async () => {
    const toggles: Array<[string, boolean]> = [];
    const opened: Array<[string, HTMLElement]> = [];
    const el = await mount(<Host toggles={toggles} opened={opened} />);
    const flagged = cards(el)[1];
    const key = flagged.dataset.questionKey!;
    const sw = toggle(flagged)!;
    const words = opener(flagged)!;
    expect(sw !== null && words !== null).toBe(true);
    // Siblings in one tag, never one inside the other.
    expect(sw.contains(words) || words.contains(sw)).toBe(false);
    expect(sw.parentElement === words.parentElement).toBe(true);
    expect(sw.parentElement!.hasAttribute('data-question-decision-tag')).toBe(true);
    expect(sw.getAttribute('aria-pressed')).toBe('true');
    expect(sw.getAttribute('aria-label')).toBe('Record as a decision');
    expect(words.getAttribute('aria-haspopup')).toBe('dialog');
    expect(words.hasAttribute('aria-pressed')).toBe(false);
    expect(words.textContent).toBe('Records a decision');

    await click(words);
    expect(opened.length).toBe(1);
    expect(opened[0][0]).toBe(key);
    expect(opened[0][1] === words).toBe(true);
    expect(toggles).toEqual([]);

    await click(sw);
    expect(toggles).toEqual([[key, false]]);
    expect(opened.length).toBe(1);
    // Off: the whole tag draws off, and the words still open the card (the
    // host decides what an off question's card does).
    const off = cards(el)[1];
    expect(toggle(off)!.parentElement!.style.outlineStyle).toBe('dotted');
    expect(toggle(off)!.parentElement!.style.color).toBe('var(--muted-foreground)');
    expect(decisionRow(off) === null).toBe(true);
    await click(opener(off)!);
    expect(opened.length).toBe(2);
  });

  test.skipIf(!hasDom)('both targets are in the tab order, switch first, with a focus ring', async () => {
    const el = await mount(<Host toggles={[]} opened={[]} />);
    const plain = cards(el)[0];
    const order = tabbables(plain);
    const sw = order.indexOf(toggle(plain)!);
    const words = order.indexOf(opener(plain)!);
    expect(sw >= 0 && words >= 0).toBe(true);
    expect(words).toBe(sw + 1);
    for (const target of [toggle(plain)!, opener(plain)!]) {
      expect(target.tagName).toBe('BUTTON');
      expect(target.type).toBe('button');
      expect(target.className).toContain('focus-visible:ring-2');
    }
    // Every card control after the tag still follows it (the tag is first).
    expect(sw).toBe(0);
  });

  test.skipIf(!hasDom)('without a toggle handler the diamond is not a control; the words still open', async () => {
    const opened: Array<[string, HTMLElement]> = [];
    const el = await mount(<Cards extra={{ questionDecisionScope: 'any', questionDecisionRecording: true, onOpenQuestionDecision: (k, a) => opened.push([k, a]) }} />);
    const plain = cards(el)[0];
    expect(toggle(plain) === null).toBe(true);
    await click(opener(plain)!);
    expect(opened.length).toBe(1);
  });

  test.skipIf(!hasDom)('without onOpenDecision the whole tag is the toggle, as in 0.52.0', async () => {
    const toggles: Array<[string, boolean]> = [];
    const el = await mount(<Host toggles={toggles} withOpener={false} />);
    const flagged = cards(el)[1];
    expect(opener(flagged) === null).toBe(true);
    expect(flagged.querySelector('[data-question-decision-tag]') === null).toBe(true);
    expect(toggle(flagged)!.textContent).toBe('Records a decision');
  });
});

describe('read-only and no-prop cards', () => {
  test.skipIf(!hasDom)('a read-only card is never interactive', async () => {
    const all: Props = { questionDecisionScope: 'any', questionDecisionRecording: true, onToggleQuestionDecisionRecording: () => {}, onOpenQuestionDecision: () => {} };
    const el = await mount(<Cards readOnly extra={all} />);
    for (const card of cards(el)) {
      expect(toggle(card) === null).toBe(true);
      expect(opener(card) === null).toBe(true);
    }
    // The plain question still shows the state it was given, as a plain tag.
    expect(hasTagText(cards(el)[0])).toBe(true);
    expect(cards(el)[0].querySelector('button') === null).toBe(true);

    // Viewer drops both handlers under readOnly even with an answer handler.
    const Viewer = viewerModule!.Viewer;
    const blocks = parseMarkdownToBlocks(DOC);
    const v = await mount(
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
        readOnly
        onAnswerQuestion={() => {}}
        questionDecisionScope="any"
        questionDecisionRecording={() => true}
        onToggleQuestionDecisionRecording={() => {}}
        onOpenQuestionDecision={() => {}}
      />,
    );
    for (const card of cards(v)) {
      expect(toggle(card) === null).toBe(true);
      expect(opener(card) === null).toBe(true);
    }
  });

  test.skipIf(!hasDom)('Viewer threads the opener and per-question state to the cards', async () => {
    const Viewer = viewerModule!.Viewer;
    const opened: string[] = [];
    const blocks = parseMarkdownToBlocks(DOC);
    const el = await mount(
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
        onAnswerQuestion={() => {}}
        questionDecisionScope="any"
        questionDecisionRecording={(q) => (q.question.decisionOnAnswer ? undefined : false)}
        onOpenQuestionDecision={(key) => opened.push(key)}
      />,
    );
    const plain = cards(el)[0];
    expect(plain.dataset.questionDecisionRecording).toBe('off');
    await click(opener(plain)!);
    expect(opened).toEqual([plain.dataset.questionKey!]);
  });

  test.skipIf(!hasDom)('no host props: the card markup is unchanged by the new props being absent', async () => {
    // useId differs between roots; everything else must match.
    const html = (el: HTMLElement) => el.innerHTML.replace(/(q-(?:prompt|context|suggest|note)-|question-)[A-Za-z0-9_«»]+/g, '$1#');
    const plain = await mount(<Cards />);
    // An explicit undefined for each new seam is the same card.
    const spelled = await mount(<Cards extra={{ questionDecisionRecording: undefined, questionDecisionScope: undefined, onOpenQuestionDecision: undefined }} />);
    expect(html(spelled)).toBe(html(plain));
    // Sentinels: the plain question has no tag and no attribute; the flagged
    // question's tag is a plain span with its row.
    const [p, flagged] = cards(plain);
    expect(hasTagText(p)).toBe(false);
    expect(p.hasAttribute('data-question-decision-recording')).toBe(false);
    expect(flagged.querySelector('button[data-question-decision-toggle], [data-question-decision-tag]') === null).toBe(true);
    expect(decisionRow(flagged) !== null).toBe(true);
  });
});
