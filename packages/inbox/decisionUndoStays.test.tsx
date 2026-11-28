/**
 * Decision mode: a pick by a click moves the queue on a moment later (the stamp shows first). Undo, or going back to
 * that card, inside that moment must keep the card on screen: the move was for the pick, and the pick is taken back
 * or the person chose the card again. What regresses if this fails: the move still fires and takes the person to the
 * next question just after they undid the pick or opened the card again (seen in the two-computer browser test,
 * inbox-decision-mode-linked.spec.ts step 2, where the card left under the click and never came back).
 *
 * The thread is a linked computer's (Laptop, awake), as in that test. DecisionMode over a stubbed fetch and a thread
 * put in the query cache; no Inbox. DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxDecision, InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { ThreadModel } from '@plannotator/core/inbox-wire-models';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';

const hasDom = typeof document !== 'undefined';
const { DecisionMode } = (hasDom ? await import('./decisions/DecisionMode') : {}) as typeof import('./decisions/DecisionMode');
const { createInboxQueryClient } = (hasDom ? await import('./data/client') : {}) as typeof import('./data/client');
const { putThread } = (hasDom ? await import('./data/queries/thread') : {}) as typeof import('./data/queries/thread');

const LAPTOP = 'ibx_01JDZ8Y3V7Q4K2N6P9R5T8W1XA';
const T = 'msg_01KUNDOSTAYS0000000000000T';
const M = T;
const PLAIN = 'Ship the new search index tonight?';
const CHANGE = 'Keep the result count next to the search box?';
const BODY = [
  'Two things before the harbor search index ships.',
  '',
  ':::question',
  PLAIN,
  '',
  '- [ ] Yes, tonight',
  '- [ ] No, wait for Monday',
  ':::',
  '',
  ':::question',
  CHANGE,
  '',
  '- [ ] Yes, keep it there',
  '- [ ] No, leave it under the filters',
  ':::',
].join('\n');
const AUTHOR = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null } as const;

/** Laptop's questions as its Inbox holds them: each pick saved there raises the revision. */
let onLaptop: InboxQuestion[] = [];
let picks = 0;

function asked(): InboxQuestion[] {
  return parseInboxQuestionBlocks(BODY).map(
    (q) =>
      ({
        key: q.key,
        position: q.position,
        kind: q.kind,
        prompt: q.prompt,
        context: q.parsed.context,
        choices: q.parsed.choices,
        recommendation: null,
        suggested_text: null,
        stopped: q.stopped,
        holds_up: q.holds_up,
        asked_by_agent_id: null,
        orphaned: false,
        state: 'open',
        answer: null,
        revision: 1,
        sent_revision: 0,
        picked_by: null,
        picked_at: null,
        sent_reply_id: null,
        message_id: M,
        superseded_by: null,
      }) as InboxQuestion,
  );
}

function decisions(): InboxDecision[] {
  return onLaptop.map(
    (question) =>
      ({
        id: `${M}/${question.key}`,
        machine: LAPTOP,
        question,
        message: { id: M, created_at: '2026-11-27T10:00:00.000Z', author: AUTHOR, excerpt: null },
        pictures: { inline: [], attachments: [] },
        thread: { id: T, subject: 'Harbor search index rollout', thread_name: null, project: { id: 'prj_1', name: 'harbor' }, section: 'waiting' },
        session: { key: 's:claude-code\u0000ses_a', host: 'claude-code', session: 'ses_a', name: null, wakes: false },
      }) as unknown as InboxDecision,
  );
}

function model(): ThreadModel {
  const message = { id: M, thread_id: T, project_id: 'prj_1', author: AUTHOR, subject: 'Harbor search index rollout', body: BODY, created_at: '2026-11-27T10:00:00.000Z', reply_to: null, seq: 1, questions: onLaptop, actions: [] } as unknown as InboxMessageWire;
  return { serverSession: 'srv', cursor: 1, thread: { thread_id: T, subject: 'Harbor search index rollout', project: { id: 'prj_1', name: 'harbor', root: '/work/harbor' }, messages: [message] } } as unknown as ThreadModel;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient | null = null;
let realFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  onLaptop = asked();
  picks = 0;
  rememberMachine([T, M, 'prj_1'], LAPTOP);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Laptop is awake: a pick lands there at once (through the forward) and answers its questions.
    if (init?.method === 'POST' && url.endsWith('/picks')) {
      picks += 1;
      const body = JSON.parse(String(init.body)) as { questions: { key: string; answer: QuestionAnswer | null }[] };
      onLaptop = onLaptop.map((q) => {
        const pick = body.questions.find((p) => p.key === q.key);
        return pick ? ({ ...q, answer: pick.answer, state: pick.answer ? 'picked' : 'open', revision: q.revision + 1 } as InboxQuestion) : q;
      });
      return new Response(JSON.stringify({ questions: onLaptop }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Promise<Response>(() => {});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  client = null;
  globalThis.fetch = realFetch;
  resetMachineRoutes();
});

const refresh = () => {};
const subscribe = () => () => {};
const dialog = () => document.querySelector<HTMLElement>('[data-decision-mode]');
const card = () => dialog()?.querySelector<HTMLElement>('[data-decision-card]') ?? null;
const prompt = () => card()?.querySelector('[data-decision-question] [data-question-part="prompt"]')?.textContent?.trim() ?? null;
const option = (label: string) => [...(card()?.querySelectorAll<HTMLElement>('[data-question-option]') ?? [])].find((o) => o.textContent?.includes(label)) ?? null;
const button = (selector: string) => dialog()!.querySelector<HTMLButtonElement>(selector)!;

async function wait(ms: number): Promise<void> {
  await act(async () => await new Promise((done) => setTimeout(done, ms)));
}

async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await wait(20);
  }
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

async function render(): Promise<void> {
  client = createInboxQueryClient();
  putThread(client, T, model());
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <QueryClientProvider client={client!}>
        <DecisionMode open decisions={decisions()} rows={new Map()} phone={false} refresh={refresh} subscribeQuestions={subscribe} onTuck={() => {}} onClose={() => {}} />
      </QueryClientProvider>,
    );
  });
  await until(() => prompt() === PLAIN && option('Yes, tonight') !== null, 'the first card');
}

/** A click on a choice, as a pointer makes it (a pointer's pick moves the queue on). */
function pick(label: string): void {
  const radio = option(label)!.querySelector<HTMLInputElement>('input')!;
  act(() => {
    radio.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    radio.click();
  });
}

/** The card on screen, sampled for a while: which question, and whether it is still the same element (never drawn anew). */
async function watchCard(ms: number): Promise<{ prompts: Set<string | null>; same: boolean }> {
  const first = card();
  const prompts = new Set<string | null>();
  let same = true;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    prompts.add(prompt());
    if (card() !== first || !first?.isConnected) same = false;
    await wait(25);
  }
  return { prompts, same };
}

test.skipIf(!hasDom)('Undo right after a pick stays on the card it took back, which stays put and takes the pick again', async () => {
  await render();
  pick('Yes, tonight');
  await until(() => picks === 1, 'the pick saved on Laptop');
  // At once, inside the moment before the queue moves on.
  act(() => button('[data-decision-undo]').click());
  await until(() => picks === 2 && onLaptop[0]!.state === 'open', 'the Undo saved on Laptop');
  expect(await watchCard(900)).toEqual({ prompts: new Set([PLAIN]), same: true });
  pick('Yes, tonight');
  await until(() => onLaptop[0]!.state === 'picked', 'the pick again');
});

test.skipIf(!hasDom)('the card chosen again from All right after its pick and Undo stays on screen', async () => {
  await render();
  pick('Yes, tonight');
  act(() => button('[data-decision-undo]').click());
  // As the two-computer test does: All, then the question's row.
  act(() => button('[data-decision-overview]').click());
  const row = [...dialog()!.querySelectorAll<HTMLButtonElement>('.ib-dm-allrow')].find((b) => b.textContent?.includes(PLAIN))!;
  act(() => row.click());
  await until(() => prompt() === PLAIN, 'the card from All');
  expect(await watchCard(900)).toEqual({ prompts: new Set([PLAIN]), same: true });
  expect(option('Yes, tonight')).not.toBeNull();
});

test.skipIf(!hasDom)('a pick with nothing after it still moves on to the next question', async () => {
  await render();
  pick('Yes, tonight');
  await until(() => prompt() === CHANGE, 'the next card');
});
