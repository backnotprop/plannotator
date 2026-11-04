/**
 * A launched session's permission card (PermissionCard in a ThreadPane):
 * - Allow once takes focus only for a card that arrived after the open's first fresh read
 *   (App's `openedWith`). A card the thread opened with never does, nor one shown in a stale copy
 *   of the thread before that read lands (the pane remounted on a thread kept from an earlier
 *   visit): a person who just opened the thread and presses Enter must never allow a prompt.
 * - An answer still goes out where `crypto.randomUUID` does not exist (plain http to an address
 *   other than localhost): its reply's key comes from `newUuid`.
 * - Its header's Stop and its answers are the owner's: a tailnet guest's page shows neither, as the server refuses both.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPermissionQuestion, inboxPermissionSession } from '@plannotator/core/inbox-permission';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxRun, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { ARM_MS } = (hasDom ? await import('./components/PermissionCard') : {}) as typeof import('./components/PermissionCard');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T10:00:00.000Z' };
const ROOT_ID = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const CARD_1 = 'msg_01M4H8QK2V7D9C1X5RZ3N0AB4T';
const CARD_2 = 'msg_01M4HA1B2C3D4E5F6G7H8J9K0M';
const RUN: InboxRun = {
  state: 'waiting_answer',
  launch_id: 'lch_1',
  agent: 'claude-code',
  project: 'ledger',
  folder: '/work/ledger',
  since: '2026-11-02T10:01:00.000Z',
  again: false,
  stopped_by_person: false,
  cause: null,
} as InboxRun;

const rootMessage = {
  id: ROOT_ID,
  project_id: PROJECT.id,
  thread_id: ROOT_ID,
  reply_to: null,
  author: { kind: 'person' },
  subject: 'Build the Inbox',
  body: 'Build the Inbox, then clean its dist folder.',
  created_at: '2026-11-02T10:00:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  started_by_person: true,
  to: { host: 'claude-code', session: 'ses_a' },
  launch: { id: 'lch_1', agent: 'claude-code', session_ref: 'ses_a', folder: '/work/ledger', scratch: false, started_at: '2026-11-02T10:00:00.000Z' },
} as unknown as InboxMessageWire;

function card(id: string, command: string, minute: number): InboxMessageWire {
  const asked = inboxPermissionQuestion(
    { session_id: 'ses_a', tool_name: 'Bash', tool_input: { command }, cwd: '/work/ledger', permission_suggestions: [], permission_mode: 'default' },
    { agent: 'Claude Code', folder: '/work/ledger' },
  );
  const question = {
    key: 'q1',
    position: 0,
    kind: 'question',
    prompt: asked.prompt,
    context: null,
    choices: asked.choices.map((label) => ({ label, description: null, recommended: false, settled: false })),
    recommendation: null,
    suggested_text: null,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: null,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 1,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: id,
    superseded_by: null,
  } as unknown as InboxQuestion;
  return {
    id,
    project_id: PROJECT.id,
    thread_id: ROOT_ID,
    reply_to: ROOT_ID,
    author: { kind: 'agent', host: 'claude-code', session: inboxPermissionSession('ses_a'), name: null },
    subject: null,
    body: asked.body,
    created_at: `2026-11-02T10:0${minute}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    questions: [question],
  } as unknown as InboxMessageWire;
}

const threadOf = (...messages: InboxMessageWire[]): InboxThread => ({ thread_id: ROOT_ID, project: PROJECT, subject: 'Build the Inbox', thread_name: null, resolved_at: null, messages: [rootMessage, ...messages] });
const idsOf = (thread: InboxThread): ReadonlySet<string> => new Set(thread.messages.map((m) => m.id));

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  posts = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
      if (path.includes('/picks')) return Response.json({ questions: [] });
      if (path.includes('/reply')) return Response.json({ reply: {}, questions: [], replayed: false });
      return Response.json({});
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
});

/** A few turns and animation frames: the card takes focus two frames after it draws. */
async function settle(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function pane(thread: InboxThread, openedWith: ReadonlySet<string> | null, guest = false) {
  return (
    <div className="pn-inbox">
      <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} run={RUN} openedWith={openedWith} guest={guest} />
    </div>
  );
}

async function render(thread: InboxThread, openedWith: ReadonlySet<string> | null, guest = false) {
  // As after a click on a row or a reload: nothing in the page holds focus.
  (document.activeElement as HTMLElement | null)?.blur?.();
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(thread, openedWith, guest));
  });
  await settle();
  return host;
}

async function rerender(thread: InboxThread, openedWith: ReadonlySet<string> | null) {
  act(() => root!.render(pane(thread, openedWith)));
  await settle();
}

const once = (id: string) => host!.querySelector<HTMLButtonElement>(`[data-message-id="${id}"] [data-perm="once"]`);
// Compared as booleans: a failing toBe on two elements prints the whole fiber tree.
const focused = (id: string) => document.activeElement === once(id);

test.skipIf(!hasDom)('a card the thread opened with never takes focus; the next card that arrives does', async () => {
  const opened = threadOf(card(CARD_1, 'bun run --cwd apps/inbox build', 1));
  await render(opened, idsOf(opened));
  expect(once(CARD_1)).not.toBeNull();
  expect(focused(CARD_1)).toBe(false);

  const later = threadOf(card(CARD_1, 'bun run --cwd apps/inbox build', 1), card(CARD_2, 'rm -rf apps/inbox/dist', 2));
  await rerender(later, idsOf(opened));
  expect(focused(CARD_2)).toBe(true);
});

test.skipIf(!hasDom)('a stale copy shown before the fresh read lands: the card that read brings counts as there at the open', async () => {
  // Back on a thread kept from an earlier visit: the pane draws the old copy, without the card, before any read.
  const stale = threadOf();
  await render(stale, null);
  // The open's first fresh read lands, with a card that came while the person was away.
  const fresh = threadOf(card(CARD_1, 'bun run --cwd apps/inbox build', 1));
  await rerender(fresh, idsOf(fresh));
  expect(once(CARD_1)).not.toBeNull();
  expect(focused(CARD_1)).toBe(false);

  // A card that arrives after that read still takes focus.
  const later = threadOf(card(CARD_1, 'bun run --cwd apps/inbox build', 1), card(CARD_2, 'rm -rf apps/inbox/dist', 2));
  await rerender(later, idsOf(fresh));
  expect(focused(CARD_2)).toBe(true);
});

test.skipIf(!hasDom)('before the fresh read lands, a card on screen never takes focus', async () => {
  await render(threadOf(card(CARD_1, 'bun run --cwd apps/inbox build', 1)), null);
  expect(once(CARD_1)).not.toBeNull();
  expect(focused(CARD_1)).toBe(false);
});

test.skipIf(!hasDom)('Allow once is sent where crypto.randomUUID does not exist (plain http, not localhost)', async () => {
  const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  try {
    const opened = threadOf(card(CARD_1, 'bun run --cwd apps/inbox build', 1));
    await render(opened, idsOf(opened));
    // The answers ignore a press until the card has been on screen ARM_MS.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ARM_MS + 50));
    });
    await act(async () => once(CARD_1)!.click());
    await settle();
    expect(host!.textContent).not.toContain('Your answer was not sent');
    const reply = posts.find((p) => p.path.includes(`/messages/${CARD_1}/reply`));
    expect(reply).toBeDefined();
    expect(String(reply!.body.idempotency_key)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    // randomUUID lives on Crypto.prototype: delete the shadow so the prototype's shows again.
    if (original) Object.defineProperty(crypto, 'randomUUID', original);
    else delete (crypto as unknown as Record<string, unknown>).randomUUID;
  }
});

test.skipIf(!hasDom)("the card's header Stop and its answers are the owner's: a tailnet guest's page shows neither", async () => {
  const thread = threadOf(card(CARD_1, 'bun run --cwd apps/inbox build', 1));
  await render(thread, idsOf(thread));
  // Compared as booleans (see `focused`).
  expect(!!host!.querySelector(`[data-message-id="${CARD_1}"] [data-run-stop]`)).toBe(true);
  expect(once(CARD_1)!.closest('footer')!.hidden).toBe(false);
  act(() => root!.unmount());
  host!.remove();
  await render(thread, idsOf(thread), true);
  expect(!!host!.querySelector(`[data-message-id="${CARD_1}"] [data-permission]`)).toBe(true);
  expect(!!host!.querySelector('[data-run-stop]')).toBe(false);
  // Allow once, Deny, Auto and Full: hidden, as the server refuses a guest's answer.
  expect(once(CARD_1)!.closest('footer')!.hidden).toBe(true);
});
