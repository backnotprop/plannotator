/**
 * A pick on another machine's question while that machine sleeps (linked machines, rule 12): it is held in
 * this Inbox's outbox, the card stays picked and a toast says it waits; a refusal there unpicks it with a
 * toast; and a second pick on the same question, held behind the first, goes with the next revision, so the
 * queued picks apply there in order.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { MachineView, OutboxView } from './api';
import type { InboxToastModel } from './components/Toast';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const MAC = `ibx_01K${'0'.repeat(22)}M`;
const PROJECT: InboxProject = { id: 'prj_far', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-10-30T09:00:00.000Z' };
const AGENT: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const M1 = 'msg_01KHELDPICK000000000000001';
const ASK = ['Where should the retry live?', '', ':::question', 'Where should the retry live?', '', '- [ ] Pin it', '- [ ] Loosen it', ':::'].join('\n');
const MACBOOK: MachineView = {
  id: MAC,
  name: 'MacBook',
  self: false,
  state: 'offline',
  since: '2026-10-30T10:42:00.000Z',
  reason: null,
  version: '0.28.39',
  address: null,
  both_ways: true,
  waiting: 0,
};

function questions(): InboxQuestion[] {
  return parseInboxQuestionBlocks(ASK).map((q) => ({
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
    asked_by_agent_id: AGENT.session,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 3,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: M1,
    superseded_by: null,
  }));
}

function thread(): InboxThread {
  return {
    thread_id: M1,
    project: PROJECT,
    subject: 'Retry',
    thread_name: null,
    resolved_at: null,
    messages: [
      {
        id: M1,
        project_id: PROJECT.id,
        thread_id: M1,
        reply_to: null,
        author: AGENT,
        subject: 'Retry',
        body: ASK,
        created_at: '2026-10-30T10:15:00.000Z',
        resolved_at: null,
        idempotency_key: null,
        seq: 1,
        questions: questions(),
      },
    ],
  };
}

const held = (key: string, state: OutboxView['state'] = 'queued'): OutboxView => ({
  key,
  machine: MAC,
  route: `messages/${M1}/picks`,
  state,
  queued_at: '2026-10-30T10:50:00.000Z',
  settled_at: state === 'queued' ? null : '2026-10-30T11:00:00.000Z',
  status: state === 'refused' ? 409 : null,
  answer: state === 'refused' ? { error: 'The question changed.' } : null,
  notice: state === 'refused' ? { kind: 'refused', at: '2026-10-30T11:00:00.000Z' } : null,
  dismissed: false,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let picks: { url: string; body: { questions: { key: string; revision: number }[] } }[] = [];
let toasts: Omit<InboxToastModel, 'id'>[] = [];

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  // The question's message is MacBook's: its picks go through MacBook's forward.
  rememberMachine([M1], MAC);
  picks = [];
  toasts = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/picks') && init?.method === 'POST') {
      picks.push({ url: path, body: JSON.parse(String(init.body)) });
      // MacBook sleeps: this Inbox holds the pick and says so (202).
      return Response.json({ outbox: held(`k${picks.length}`), machine: MACBOOK }, { status: 202 });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  resetMachineRoutes();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

const model = thread();

function draw(outbox: OutboxView[]) {
  root!.render(
    <ThreadPane
      thread={model}
      machine={MACBOOK}
      outbox={outbox}
      sent={null}
      onQuestions={() => {}}
      onChanged={async () => {}}
      onClose={() => {}}
      file={null}
      onOpenFile={() => {}}
      onOpenGuide={() => {}}
      onToast={(toast) => {
        toasts.push(toast);
      }}
    />,
  );
}

async function render(outbox: OutboxView[] = []) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(outbox);
  });
  await settle();
  return host;
}

const option = (el: HTMLElement, words: string) =>
  [...el.querySelectorAll<HTMLElement>('[data-question-option]')].find((row) => row.textContent?.includes(words))!.querySelector<HTMLInputElement>('input')!;

async function choose(el: HTMLElement, words: string) {
  await act(async () => {
    option(el, words).click();
  });
  await settle();
}

test.skipIf(!hasDom)('a held pick stays picked and says it waits; a refusal there unpicks it and says so', async () => {
  const el = await render();
  await choose(el, 'Pin it');
  await until(() => picks.length === 1 && toasts.length === 1, 'the held pick');
  expect(picks[0]!.url).toBe(`/api/inbox/m/${MAC}/messages/${M1}/picks`);
  expect(toasts[0]!.icon).toBe('clock');
  expect(toasts[0]!.lead).toBe('Waiting for MacBook: this applies when MacBook is back.');
  await settle();
  expect(option(el, 'Pin it').checked).toBe(true);

  // Still waiting: nothing changes.
  act(() => draw([held('k1')]));
  await settle();
  expect(option(el, 'Pin it').checked).toBe(true);
  expect(toasts).toHaveLength(1);

  // MacBook woke and refused it.
  act(() => draw([held('k1', 'refused')]));
  await until(() => !option(el, 'Pin it').checked, 'the pick undone');
  expect(toasts).toHaveLength(2);
  expect(toasts[1]!.icon).toBe('warn');
  expect(toasts[1]!.lead.startsWith('Pick not saved.')).toBe(true);
});

test.skipIf(!hasDom)('a second pick on the same question while the first waits goes with the next revision', async () => {
  const el = await render();
  await choose(el, 'Pin it');
  await until(() => picks.length === 1, 'the first pick');
  await choose(el, 'Loosen it');
  await until(() => picks.length === 2, 'the second pick');
  expect(picks.map((pick) => pick.body.questions[0]!.revision)).toEqual([3, 4]);
  await settle();
  expect(option(el, 'Loosen it').checked).toBe(true);
});
