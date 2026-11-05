/**
 * A launched Codex thread's own question (requestUserInput or an MCP elicitation, written by the Inbox as
 * `perm:ask:<thread id>`; packages/server/inbox-launch-codex-questions.ts) is drawn in its thread as the
 * ordinary question card agents' questions use, never as the permission card, though its identity is a
 * `perm:` one (so its answer is never a second turn).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxAskSession } from '@plannotator/core/inbox-permission';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxRun, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T10:00:00.000Z' };
const ROOT_ID = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const CARD = 'msg_01M4H8QK2V7D9C1X5RZ3N0AB4T';
const THREAD = '019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b';
const RUN = { state: 'waiting_answer', launch_id: 'lch_1', agent: 'codex', project: 'ledger', folder: '/work/ledger', since: '2026-11-02T10:01:00.000Z', again: false, stopped_by_person: false, cause: null } as unknown as InboxRun;

const rootMessage = {
  id: ROOT_ID,
  project_id: PROJECT.id,
  thread_id: ROOT_ID,
  reply_to: null,
  author: { kind: 'person' },
  subject: 'Fix the rounding',
  body: 'The refund total is off by a cent.',
  created_at: '2026-11-02T10:00:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  started_by_person: true,
  to: { host: 'codex', session: THREAD },
  launch: { id: 'lch_1', agent: 'codex', session_ref: THREAD, folder: '/work/ledger', scratch: false, started_at: '2026-11-02T10:00:00.000Z' },
} as unknown as InboxMessageWire;

const BODY = '**Rounding**\n\n:::question\nRound refunds how?\n\n- [ ] Banker\'s rounding — Matches the ledger\n- [ ] Half up — Simpler\n:::';

function askCard(): InboxMessageWire {
  const questions = parseInboxQuestionBlocks(BODY).map(
    (q) =>
      ({
        key: q.key,
        position: q.position,
        kind: 'question',
        prompt: q.prompt,
        context: null,
        choices: q.parsed.choices,
        recommendation: null,
        suggested_text: null,
        stopped: null,
        holds_up: [],
        asked_by_agent_id: inboxAskSession(THREAD),
        orphaned: false,
        state: 'open',
        answer: null,
        revision: 1,
        sent_revision: 0,
        picked_by: null,
        picked_at: null,
        sent_reply_id: null,
        message_id: CARD,
        superseded_by: null,
      }) as unknown as InboxQuestion,
  );
  return {
    id: CARD,
    project_id: PROJECT.id,
    thread_id: ROOT_ID,
    reply_to: ROOT_ID,
    author: { kind: 'agent', host: 'codex', session: inboxAskSession(THREAD), name: 'Codex' },
    subject: null,
    body: BODY,
    created_at: '2026-11-02T10:01:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    questions,
  } as unknown as InboxMessageWire;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
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
});

test.skipIf(!hasDom)("Codex's own question in a launched thread is the ordinary question card, never the permission card", async () => {
  const thread: InboxThread = { thread_id: ROOT_ID, project: PROJECT, subject: 'Fix the rounding', thread_name: null, resolved_at: null, messages: [rootMessage, askCard()] };
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} run={RUN} openedWith={new Set(thread.messages.map((m) => m.id))} />
      </div>,
    );
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  // Compared as booleans: a failing toBe on an element prints the whole fiber tree.
  expect(!!host.querySelector('[data-permission]')).toBe(false);
  const card = host.querySelector(`[data-message-id="${CARD}"] fieldset[data-question-key]`);
  expect(!!card).toBe(true);
  expect(card!.textContent).toContain('Round refunds how?');
  expect(card!.textContent).toContain('Half up');
});
