/**
 * When the row menu offers "Mention in reply" (the owner, 2026-11-22: "only with unsent words in a reply box"). It
 * used to aim at the open thread, or else at the last reply the person ever typed in (kept in localStorage for good),
 * so with no thread open it named a thread they were not writing in, even one already sent. What regresses here:
 * - the item with no thread open, with the open thread's box empty, or after its reply was sent;
 * - a remembered reply (an older version's localStorage value included) offered when its draft holds no words;
 * - the item on the reply's own thread (it did nothing and took room);
 * - a reply with words not taking the mention, or a phone's sheet not offering the reply that still has words.
 *
 * The thread pane is the product's (`ThreadPane`, over a scripted Inbox: fetch stubbed, nothing started); the menu is
 * Base UI's, open. A floating draft's window is in floaters/floaters.test.tsx.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { InboxListRow, InboxMessageWire, InboxProject, InboxReplyDraftRow, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { MentionMenuItem } = (hasDom ? await import('./components/MentionMenuItem') : {}) as typeof import('./components/MentionMenuItem');
const { Menu } = (hasDom ? await import('@base-ui/react/menu') : {}) as typeof import('@base-ui/react/menu');
const { resetReplyMentionsForTests } = (hasDom ? await import('./threadMentions') : {}) as typeof import('./threadMentions');
const { createInboxQueryClient } = (hasDom ? await import('./data/client') : {}) as typeof import('./data/client');
const { inboxKeys } = (hasDom ? await import('./data/keys') : {}) as typeof import('./data/keys');

const LAST_KEY = 'plannotator-inbox-last-reply';
const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-20T10:00:00.000Z' };
const HERE = 'msg_01M9MENT10N0000000000000001';
const MESSAGE = 'msg_01M9MENT10N0000000000000002';
const OTHER = 'msg_01M9MENT10N0000000000000003';
const BRAND = 'msg_01M9MENT10N0000000000000004';

const agentMessage: InboxMessageWire = {
  id: MESSAGE,
  project_id: PROJECT.id,
  thread_id: HERE,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', name: 'Claude Code', session: 'ses_a' },
  subject: 'Retry worker',
  body: 'The retry worker drains in order now. Anything else?',
  created_at: '2026-11-20T10:01:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  wakes: true,
} as InboxMessageWire;
const thread = (): InboxThread => ({ thread_id: HERE, project: PROJECT, subject: 'Retry worker', thread_name: null, resolved_at: null, messages: [agentMessage] });
const row = (id: string, name: string): InboxListRow => ({ thread_id: id, thread_name: name, subject: null, resolved_at: null, project: { id: PROJECT.id, name: PROJECT.name } }) as unknown as InboxListRow;
const draftRow = (id: string, name: string, words: string | null): InboxReplyDraftRow =>
  ({ ...row(id, name), unsent: { reply_at: '2026-11-21T09:00:00.000Z', picks: 0, comments: 0 }, reply_preview: words }) as unknown as InboxReplyDraftRow;

let paneRoot: Root | null = null;
let menuRoot: Root | null = null;
const hosts: HTMLElement[] = [];
let savedFetch: typeof fetch;
let posted: string[] = [];
let client: QueryClient;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  window.localStorage.clear();
  resetReplyMentionsForTests();
  client = createInboxQueryClient();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push(path);
      if (path.endsWith('/draft')) {
        const body = String(JSON.parse(String(init.body)).body ?? '');
        return Response.json({ draft: body ? { v: 1, thread_id: HERE, body, created_at: '2026-11-21T09:00:00.000Z', updated_at: new Date().toISOString() } : null });
      }
      return Response.json({ message: {} });
    }
    if (path.includes('/draft')) return Response.json({ serverSession: 's', draft: null });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const asked = new URL(path, 'http://inbox.test').searchParams.get('asker');
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], ...(asked ? { asker: { session: asked, live: true } } : {}) });
    }
    if (path.includes('/skills')) return Response.json({ skills: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => menuRoot?.unmount());
  act(() => paneRoot?.unmount());
  for (const el of hosts.splice(0)) el.remove();
  paneRoot = null;
  menuRoot = null;
  globalThis.fetch = savedFetch;
  window.location.hash = '';
  window.localStorage.clear();
});

async function settle(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function mount(): Root {
  const el = document.createElement('div');
  el.className = 'pn-inbox';
  document.body.appendChild(el);
  hosts.push(el);
  return createRoot(el);
}

/** The thread open beside the list, as App draws it at `#thread=…`. */
async function openThread() {
  window.location.hash = `#thread=${HERE}`;
  paneRoot = mount();
  act(() =>
    paneRoot!.render(
      <QueryClientProvider client={client}>
        <ThreadPane thread={thread()} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

/** A row's menu opened now (right-click on a computer, the row's sheet on a phone): its Mention item, or null. */
function rowMenu(rows: InboxListRow[], phone = false): HTMLElement | null {
  act(() => menuRoot?.unmount());
  menuRoot = mount();
  act(() =>
    menuRoot!.render(
      <QueryClientProvider client={client}>
        <Menu.Root open>
          <Menu.Portal>
            <Menu.Positioner>
              <Menu.Popup>
                <MentionMenuItem rows={rows} phone={phone} />
                <span data-testid="menu-drawn" />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </QueryClientProvider>,
    ),
  );
  expect(document.querySelector('[data-testid="menu-drawn"]')).not.toBeNull();
  return document.querySelector<HTMLElement>('[data-row-action="mention"]');
}

const replyField = () => document.querySelector<HTMLTextAreaElement>('.ib-rbox textarea');

function type(field: HTMLTextAreaElement, text: string) {
  const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    field.focus();
    setText.call(field, text);
    field.setSelectionRange(text.length, text.length);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressReply() {
  const reply = [...document.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply')!;
  await act(async () => reply.click());
  await settle();
}

test.skipIf(!hasDom)('no thread open: no item, even with an older version’s remembered reply in localStorage', () => {
  window.localStorage.setItem(LAST_KEY, BRAND);
  client.setQueryData(inboxKeys.drafts(), { serverSession: 's', drafts: [], replies: [] });
  expect(rowMenu([row(OTHER, 'Rate limit for the public API')])).toBeNull();
  // Its draft holds no words: the old value is dropped, not kept for later.
  expect(window.localStorage.getItem(LAST_KEY)).toBeNull();
});

test.skipIf(!hasDom)('a thread open with an empty reply box, closed or open: no item', async () => {
  await openThread();
  expect(replyField()).toBeNull();
  expect(rowMenu([row(OTHER, 'Rate limit for the public API')])).toBeNull();
  await pressReply();
  expect(replyField()).not.toBeNull();
  expect(rowMenu([row(OTHER, 'Rate limit for the public API')])).toBeNull();
  type(replyField()!, '   ');
  expect(rowMenu([row(OTHER, 'Rate limit for the public API')])).toBeNull();
});

test.skipIf(!hasDom)('words typed and not sent: the item mentions into that reply; on its own thread there is none; after Send it is gone', async () => {
  await openThread();
  await pressReply();
  type(replyField()!, 'Compare with');
  // Its own thread's row: nothing to mention there.
  expect(rowMenu([row(HERE, 'Retry worker')])).toBeNull();
  const item = rowMenu([row(OTHER, 'Rate limit for the public API')]);
  expect(item?.textContent).toBe('Mention in reply');
  await act(async () => {
    item!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(replyField()!.value).toBe('Compare with Rate limit for the public API ');
  expect(window.localStorage.getItem(LAST_KEY)).toBe(HERE);

  await act(async () => document.querySelector<HTMLButtonElement>('[data-reply-send]')!.click());
  for (let i = 0; i < 40 && !posted.some((p) => p.endsWith('/reply')); i++) await settle(1);
  expect(posted).toContain(`/api/inbox/messages/${MESSAGE}/reply`);
  await settle();
  expect(replyField()?.value ?? '').toBe('');
  expect(rowMenu([row(OTHER, 'Rate limit for the public API')])).toBeNull();
  // Sent: no longer the reply being written, on any device this browser opens.
  expect(window.localStorage.getItem(LAST_KEY)).toBeNull();
});

test.skipIf(!hasDom)('the words emptied by hand: no item, and the reply is no longer remembered', async () => {
  await openThread();
  await pressReply();
  type(replyField()!, 'Compare with');
  expect(window.localStorage.getItem(LAST_KEY)).toBe(HERE);
  type(replyField()!, '');
  expect(rowMenu([row(OTHER, 'Rate limit for the public API')])).toBeNull();
  expect(window.localStorage.getItem(LAST_KEY)).toBeNull();
});

test.skipIf(!hasDom)('a phone’s sheet offers the reply being written only while its draft holds words, and names it', () => {
  window.localStorage.setItem(LAST_KEY, BRAND);
  client.setQueryData(inboxKeys.drafts(), { serverSession: 's', drafts: [], replies: [draftRow(BRAND, 'Brand studio', 'Use the darker green for')] });
  client.setQueryData(inboxKeys.list(), { sections: [{ threads: [row(BRAND, 'Brand studio')] }] });
  const item = rowMenu([row(OTHER, 'Rate limit for the public API')], true);
  expect(item).not.toBeNull();
  expect(item!.querySelector('.ib-pmi-hint')?.textContent).toBe('Brand studio');
  // Several picked rows keep their wording.
  expect(rowMenu([row(OTHER, 'Rate limit for the public API'), row(HERE, 'Retry worker')], true)?.textContent).toContain('Mention 2 in reply');

  // Sent or emptied elsewhere: the drafts list holds no words for it. No item, and it is forgotten.
  client.setQueryData(inboxKeys.drafts(), { serverSession: 's', drafts: [], replies: [draftRow(BRAND, 'Brand studio', null)] });
  expect(rowMenu([row(OTHER, 'Rate limit for the public API')], true)).toBeNull();
  expect(window.localStorage.getItem(LAST_KEY)).toBeNull();
});

test.skipIf(!hasDom)('a phone with no reply being written, or the drafts not read yet: no item', () => {
  expect(rowMenu([row(OTHER, 'Rate limit for the public API')], true)).toBeNull();
  window.localStorage.setItem(LAST_KEY, BRAND);
  // Not known yet: nothing offered, and the value is kept until the drafts are read.
  expect(rowMenu([row(OTHER, 'Rate limit for the public API')], true)).toBeNull();
  expect(window.localStorage.getItem(LAST_KEY)).toBe(BRAND);
});
