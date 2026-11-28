/**
 * Decision mode's Send on a linked computer's thread while that computer is away: the reply is held in this Inbox's
 * outbox. Held, then refused there or cancelled (it surely never applied), the chip says so with Try again, and Try
 * again must send under a NEW key: the outbox answers a key it settled with how it ended ("Cancelled", "Not
 * delivered"), so a replayed key can never go out. What regresses if this fails: Send reads the outbox as it was when
 * the dialog opened (a stale prop), keeps the old key, and Try again fails for good.
 *
 * DecisionMode over a stubbed fetch and a thread put in the query cache; no Inbox.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { InboxDecision, InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { OutboxView, ThreadModel } from '@plannotator/core/inbox-wire-models';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';

const hasDom = typeof document !== 'undefined';
const { DecisionMode } = (hasDom ? await import('./decisions/DecisionMode') : {}) as typeof import('./decisions/DecisionMode');
const { createInboxQueryClient } = (hasDom ? await import('./data/client') : {}) as typeof import('./data/client');
const { putThread } = (hasDom ? await import('./data/queries/thread') : {}) as typeof import('./data/queries/thread');

const LAPTOP = 'ibx_01JDZ8Y3V7Q4K2N6P9R5T8W1XA';
const T = 'msg_t1';
const M = 'msg_1';
const chose = (...selected: string[]) => ({ selected }) as unknown as QuestionAnswer;

function question(): InboxQuestion {
  return {
    key: 'q-1',
    position: 0,
    kind: 'single',
    prompt: 'Ship the ledger export?',
    context: null,
    choices: [
      { label: 'Yes', description: null, recommended: false, settled: false },
      { label: 'No', description: null, recommended: false, settled: false },
    ],
    recommendation: null,
    suggested_text: null,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: null,
    orphaned: false,
    state: 'picked',
    answer: chose('Yes'),
    revision: 1,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: M,
    superseded_by: null,
  } as InboxQuestion;
}

const AUTHOR = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null } as const;

function decision(): InboxDecision {
  return {
    id: `${M}/q-1`,
    question: question(),
    message: { id: M, created_at: '2026-11-27T10:00:00.000Z', author: AUTHOR, excerpt: null },
    pictures: { inline: [], attachments: [] },
    thread: { id: T, subject: 'Ledger export', thread_name: null, project: { id: 'prj_1', name: 'ledger' }, section: 'waiting' },
    session: { key: 's:claude-code\u0000ses_a', host: 'claude-code', session: 'ses_a', name: null, wakes: false },
  } as unknown as InboxDecision;
}

function model(): ThreadModel {
  const message = { id: M, thread_id: T, project_id: 'prj_1', author: AUTHOR, subject: 'Ledger export', body: '', created_at: '2026-11-27T10:00:00.000Z', reply_to: null, questions: [question()], actions: [] } as unknown as InboxMessageWire;
  return { serverSession: 'srv', cursor: 1, thread: { thread_id: T, subject: 'Ledger export', messages: [message] } } as unknown as ThreadModel;
}

function entry(key: string, state: OutboxView['state']): OutboxView {
  return { key, machine: LAPTOP, route: `messages/${M}/reply`, state, queued_at: '2026-11-27T10:01:00.000Z', settled_at: state === 'queued' ? null : '2026-11-27T10:02:00.000Z', status: state === 'refused' ? 409 : null, answer: state === 'refused' ? { error: 'Laptop refused it.' } : null, notice: state === 'refused' ? { kind: 'refused', at: '2026-11-27T10:02:00.000Z' } : null, dismissed: false };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient | null = null;
let realFetch: typeof fetch;
/** The idempotency key of each reply posted, in order. */
let replyKeys: string[] = [];
let setOutbox: ((next: ReadonlyMap<string, OutboxView>) => void) | null = null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  realFetch = globalThis.fetch;
  replyKeys = [];
  rememberMachine([T, M, 'prj_1'], LAPTOP);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/reply')) {
      const key = (JSON.parse(String(init.body)) as { idempotency_key: string }).idempotency_key;
      replyKeys.push(key);
      // Laptop is away: the reply is held in this Inbox's outbox.
      return json(202, { outbox: entry(key, 'queued'), machine: { id: LAPTOP, name: 'Laptop' } });
    }
    // Every read of Laptop's thread: Laptop is away.
    if (url.includes(`/m/${LAPTOP}/`)) return json(503, { error: 'Laptop is asleep.', code: 'machine_offline' });
    return new Promise<Response>(() => {});
  }) as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  client = null;
  setOutbox = null;
  globalThis.fetch = realFetch;
  resetMachineRoutes();
});

// Stable, as App's own `refreshDecisions` is (a useCallback over nothing): Send's callbacks are made once.
const refresh = () => {};
const subscribe = () => () => {};

function Window() {
  const [outbox, set] = useState<ReadonlyMap<string, OutboxView>>(new Map());
  setOutbox = set;
  return (
    <QueryClientProvider client={client!}>
      <DecisionMode
        open
        decisions={[decision()]}
        rows={new Map()}
        outbox={outbox}
        phone={false}
        refresh={refresh}
        subscribeQuestions={subscribe}
        onTuck={() => {}}
        onClose={() => {}}
      />
    </QueryClientProvider>
  );
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector);

async function until(check: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await act(async () => await new Promise((done) => setTimeout(done, 25)));
  }
  return check();
}

const tryAgain = () => [...document.querySelectorAll<HTMLButtonElement>('[data-decision-chip] button')].find((b) => b.textContent?.trim() === 'Try again') ?? null;

async function heldThenSettled(state: OutboxView['state']): Promise<void> {
  client = createInboxQueryClient();
  putThread(client, T, model());
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Window />);
  });
  expect(await until(() => q('[data-decision-send]') !== null && !(q('[data-decision-send]') as HTMLButtonElement).disabled)).toBe(true);
  act(() => q('[data-decision-send]')!.click());
  expect(await until(() => replyKeys.length === 1)).toBe(true);
  // The outbox's frame: the reply waits for Laptop.
  act(() => setOutbox!(new Map([[replyKeys[0]!, entry(replyKeys[0]!, 'queued')]])));
  expect(await until(() => q('[data-decision-chip]')?.getAttribute('data-send') !== 'sending')).toBe(true);
  // The outbox settles the held reply: it never applied on Laptop.
  act(() => setOutbox!(new Map([[replyKeys[0]!, entry(replyKeys[0]!, state)]])));
  expect(await until(() => tryAgain() !== null)).toBe(true);
  act(() => tryAgain()!.click());
  expect(await until(() => replyKeys.length === 2)).toBe(true);
}

test.skipIf(!hasDom)('a held Send refused there: Try again sends under a new key', async () => {
  await heldThenSettled('refused');
  expect(replyKeys[1]).not.toBe(replyKeys[0]);
});

test.skipIf(!hasDom)('a held Send cancelled: Try again sends under a new key', async () => {
  await heldThenSettled('cancelled');
  expect(replyKeys[1]).not.toBe(replyKeys[0]);
});
