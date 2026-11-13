/**
 * The Inbox opts its question cards into the gentler Accept recommended
 * (approval "question-note-vs-accept-recommended"): the button steps aside
 * while the note is typed in, and after a tap the card's status line ends in
 * an Undo (no toast). What regresses here: the button showing while typing;
 * the Undo missing after a tap, not putting the answer back, staying after a
 * later change or a Send, or showing after a plain pick. The card's own rules
 * are proved in ui's QuestionBlock.acceptBehavior.test.tsx.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import { createRoot, type Root } from 'react-dom/client';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

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
  id: 'msg_01M7ACCEPTACCEPTACCEPTACCE',
  project_id: 'prj_01M7PPPPPPPPPPPPPPPPPPPPPP',
  thread_id: 'msg_01M7ACCEPTACCEPTACCEPTACCE',
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' },
  subject: 'Checks',
  body: ':::question-multi\nWhich checks run before the tag?\n\n- [ ] Canary deploy\n- [ ] Load test\n- [ ] Rollback drill\n\nRecommended: Canary deploy, Rollback drill\n:::',
  created_at: '2026-11-13T09:41:00.000Z',
  resolved_at: null,
  idempotency_key: null,
} as unknown as InboxMessageWire;

let latest: QuestionAnswer | null = null;
let send: (() => void) | null = null;
const KEY = parseInboxQuestionBlocks(MESSAGE.body)[0]!.key;

function Card() {
  const [answers, setAnswers] = useState<ReadonlyMap<string, QuestionAnswer>>(new Map());
  const [sent, setSent] = useState(false);
  send = () => setSent(true);
  const message = { ...MESSAGE, questions: [{ key: KEY, state: sent ? 'sent' : answers.has(KEY) ? 'picked' : 'open' } as InboxQuestion] };
  return (
    <MessageBody
      message={message}
      projectRoot="/work/web"
      onOpenAttachment={() => {}}
      readOnly={sent}
      answers={answers}
      onPick={(key, answer) => {
        latest = answer;
        setAnswers((current) => {
          const next = new Map(current);
          if (answer) next.set(key, answer);
          else next.delete(key);
          return next;
        });
      }}
      footerFor={() => (answers.has(KEY) ? (sent ? 'Sent 9:42 AM' : 'Picked 9:41 AM · in your draft') : null)}
    />
  );
}

async function mount() {
  latest = null;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Card />);
  });
}
const button = (label: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === label);
const accept = () => button('Accept recommended');
const undo = () => host!.querySelector<HTMLButtonElement>('.ib-qfoot-st button');
const tick = (label: string) => [...host!.querySelectorAll('label')].find((l) => l.textContent?.includes(label))!.querySelector('span')!;
const click = async (el: Element) => act(async () => (el as HTMLElement).click());

test.skipIf(!hasDom)("the thread's card hides Accept recommended while the note has focus", async () => {
  await mount();
  await click(button('Add note')!);
  const note = host!.querySelector<HTMLTextAreaElement>('textarea[placeholder="Context for the agent…"]')!;
  await act(async () => note.focus());
  expect(accept()).toBeUndefined();
  await act(async () => note.blur());
  expect(accept()).toBeDefined();
});

test.skipIf(!hasDom)('a tap puts Undo at the end of the status line; Undo puts the answer back and goes', async () => {
  await mount();
  await click(tick('Load test'));
  // A plain pick: the status line, no Undo.
  expect(host!.querySelector('.ib-qfoot-st')?.textContent).toBe('Picked 9:41 AM · in your draft');
  expect(undo()).toBeNull();
  await click(accept()!);
  expect(latest!.selected).toEqual(['Canary deploy', 'Rollback drill']);
  expect(undo()?.textContent).toBe('Undo');
  await click(undo()!);
  expect(latest!.selected).toEqual(['Load test']);
  expect(undo()).toBeNull();
});

test.skipIf(!hasDom)('the Undo goes once the answer changes again, and once the question is sent', async () => {
  await mount();
  await click(accept()!);
  expect(undo()).not.toBeNull();
  await click(tick('Load test'));
  expect(undo()).toBeNull();
  // Ticking back to the accepted answer does not bring it back.
  await click(tick('Load test'));
  expect(latest!.selected).toEqual(['Canary deploy', 'Rollback drill']);
  expect(undo()).toBeNull();

  await click(tick('Load test'));
  await click(accept()!);
  expect(undo()).not.toBeNull();
  await act(async () => send!());
  expect(host!.querySelector('.ib-qfoot-st')?.textContent).toBe('Sent 9:42 AM');
  expect(undo()).toBeNull();
});
