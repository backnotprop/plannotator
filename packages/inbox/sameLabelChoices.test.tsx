/**
 * Two choices of a pick-one question whose text before the dash is the same
 * ("Yes — keep what I typed, and let me undo the tap" and "Yes — keep what I
 * typed, no undo needed"). Read as the label "Yes" twice, they were one
 * answer: a pick marked both rows, the card's radio flipped between them on
 * every draw, and the reply could not say which was meant. What regresses
 * here: the two rows sharing an answer, the recommendation, or a picked mark.
 *
 * DOM-gated parts run under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const UNDO = 'Yes — keep what I typed, and let me undo the tap';
const NO_UNDO = 'Yes — keep what I typed, no undo needed';
const BODY = [':::question', 'Keep what you typed?', '', `- [ ] ${UNDO}`, `- [ ] ${NO_UNDO}`, '- [ ] Leave it', '', `Recommended: ${UNDO}`, ':::'].join('\n');

test('each choice is its own answer, and the recommendation names only the one it quotes', () => {
  const choices = parseInboxQuestionBlocks(BODY)[0]!.parsed.choices;
  expect(choices.map((c) => c.label)).toEqual([UNDO, NO_UNDO, 'Leave it']);
  expect(choices.map((c) => c.recommended)).toEqual([true, false, false]);
  // A label of its own already keeps its description.
  const plain = parseInboxQuestionBlocks([':::question', 'Ship?', '', '- [ ] Yes — now', '- [ ] No — later', ':::'].join('\n'))[0]!.parsed.choices;
  expect(plain.map((c) => [c.label, c.description])).toEqual([
    ['Yes', 'now'],
    ['No', 'later'],
  ]);
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const MESSAGE = {
  id: 'msg_01M79SAMESAMESAMESAMESAMES',
  project_id: 'prj_01M79PPPPPPPPPPPPPPPPPPPPP',
  thread_id: 'msg_01M79SAMESAMESAMESAMESAMES',
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' },
  subject: 'Keep it',
  body: BODY,
  created_at: '2026-11-12T15:15:00.000Z',
  resolved_at: null,
  idempotency_key: null,
} as unknown as InboxMessageWire;

test.skipIf(!hasDom)('a pick on the second "Yes" picks it alone, and stays picked when the card draws again', async () => {
  const picked: (string[] | null)[] = [];
  function Card() {
    const [answers, setAnswers] = useState<ReadonlyMap<string, QuestionAnswer>>(new Map());
    return (
      <MessageBody
        message={MESSAGE}
        projectRoot="/work/web"
        onOpenAttachment={() => {}}
        readOnly={false}
        answers={answers}
        onPick={(key, answer) => {
          picked.push(answer?.selected ?? null);
          setAnswers((current) => new Map(current).set(key, answer!));
        }}
        footerFor={() => null}
      />
    );
  }
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Card />);
  });
  const rows = () => [...host!.querySelectorAll<HTMLLabelElement>('label[data-question-option]')];
  const control = (row: HTMLLabelElement) => row.querySelector<HTMLInputElement>('input[data-question-control]')!;
  expect(rows()).toHaveLength(3);
  await act(async () => control(rows()[1]!).click());
  expect(picked.at(-1)).toEqual([NO_UNDO]);
  // One row is drawn picked, the one tapped; its control is the one checked.
  expect(rows().map((row) => row.className.includes('bg-primary/12'))).toEqual([false, true, false]);
  expect(rows().map((row) => control(row).checked)).toEqual([false, true, false]);
  await act(async () => control(rows()[0]!).click());
  expect(picked.at(-1)).toEqual([UNDO]);
  expect(rows().map((row) => row.className.includes('bg-primary/12'))).toEqual([true, false, false]);
});
