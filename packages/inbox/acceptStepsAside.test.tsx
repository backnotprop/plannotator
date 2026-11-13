/**
 * The Inbox opts its question cards into the gentler Accept recommended
 * (approval "question-note-vs-accept-recommended"): the button steps aside
 * while the note is typed in, and a tap hands the thread an Undo for its
 * toast. What regresses here: the Inbox's cards losing either (the card's own
 * rules are proved in ui's QuestionBlock.acceptBehavior.test.tsx).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';

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

test.skipIf(!hasDom)("the thread's card hides Accept recommended while the note has focus, and a tap gives the thread an Undo", async () => {
  const undos: (() => void)[] = [];
  let latest: QuestionAnswer | null = null;
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
          latest = answer;
          setAnswers((current) => {
            const next = new Map(current);
            if (answer) next.set(key, answer);
            else next.delete(key);
            return next;
          });
        }}
        footerFor={() => null}
        onAcceptedRecommended={(undo) => undos.push(undo)}
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
  const accept = () => [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Accept recommended');
  const addNote = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add note')!;
  await act(async () => addNote.click());
  const note = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Context for the agent…"]')!;
  await act(async () => note.focus());
  expect(accept()).toBeUndefined();
  await act(async () => note.blur());
  expect(accept()).toBeDefined();
  await act(async () => accept()!.click());
  expect(latest!.selected).toEqual(['Canary deploy', 'Rollback drill']);
  expect(undos).toHaveLength(1);
  await act(async () => undos[0]!());
  expect(latest).toBeNull();
});
