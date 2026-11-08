/**
 * Delete on a linked machine's message (approval "inbox-toolbar-delete"): the
 * window offers Delete on an agent message's words only when the message's
 * home Inbox takes a DELETION. Its health says `message_deletions`, carried on
 * the machine view. An Inbox from before Delete came back refuses one (422,
 * `annotation.type: "COMMENT" …`): the owner pressed Delete on a thread of
 * their Mac mini and got that error in the thread's foot.
 *
 * Failures to catch: Delete offered on an older machine's message; offered
 * while the thread's machine view is not read yet; a newer machine or this
 * machine losing Delete; a Delete that does not go to the message's machine.
 *
 * Driven through the real ThreadPane, ui Viewer and web-highlighter; fetch is
 * stubbed, no Inbox server. DOM-gated (DOM_TESTS=1), listed in
 * tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { MachineView } from './api';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const MAC = `ibx_01K${'0'.repeat(22)}D`;
const PROJECT: InboxProject = { id: 'prj_far', key: 'engine-abcdef', name: 'engine', root: '/work/engine', created_at: '2026-11-08T09:00:00.000Z' };
const AGENT: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const M1 = 'msg_01KLINKEDDELETE00000000001';
const WORDS = 'only if a specific kind of code still matters to you';
const BODY = `Keep hill climbing, ${WORDS}. Otherwise I would pause it.`;

/** MacBook as the machines block names it; `message_deletions` absent: an Inbox from before Delete. */
const macbook = (extra: Partial<MachineView> = {}): MachineView => ({
  id: MAC,
  name: 'MacBook',
  self: false,
  state: 'online',
  since: '2026-11-08T10:00:00.000Z',
  reason: null,
  version: '0.28.51',
  address: null,
  both_ways: true,
  waiting: 0,
  ...extra,
});

const model: InboxThread = {
  thread_id: M1,
  project: PROJECT,
  subject: 'What next',
  thread_name: null,
  resolved_at: null,
  messages: [
    {
      id: M1,
      project_id: PROJECT.id,
      thread_id: M1,
      reply_to: null,
      author: AGENT,
      subject: 'What next',
      body: BODY,
      created_at: '2026-11-08T10:15:00.000Z',
      resolved_at: null,
      idempotency_key: null,
      seq: 1,
      questions: [],
    },
  ],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: { url: string; body: { annotation: { type: string; originalText: string } } }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  posts = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/annotations') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as (typeof posts)[number]['body'];
      posts.push({ url: path, body });
      return Response.json({ annotation: { id: 'rec', message_id: M1, thread_id: M1, attachment_id: '', path: M1, version: 'current', message: { at: model.messages[0]!.created_at }, annotation: body.annotation } });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  globalThis.fetch = savedFetch;
  resetMachineRoutes();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function render(machine: MachineView | null) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <ThreadPane thread={model} machine={machine} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />,
    );
  });
  await settle();
  return host;
}

/** Select `phrase` in the message the way a drag does, and let the viewer hear the pointer go up. */
async function select(scope: HTMLElement, phrase: string) {
  const body = scope.querySelector<HTMLElement>(`[data-message-id="${M1}"][data-text-comments]`);
  expect(body).not.toBeNull();
  const walker = document.createTreeWalker(body!, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  const at = node!.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node!, at);
  range.setEnd(node!, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node!.parentElement!.closest('article') ?? body!).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const toolbarNames = () => [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].map((b) => b.getAttribute('aria-label') ?? b.title);

test.skipIf(!hasDom)("an older machine's message: no Delete (its Inbox refuses one), Comment and 👍 stay", async () => {
  rememberMachine([M1], MAC);
  const el = await render(macbook());
  await select(el, WORDS);
  expect(toolbarNames()).toEqual(['Comment', 'Looks good', 'Cancel']);
});

test.skipIf(!hasDom)("a linked machine's message before its machine view is read: no Delete", async () => {
  rememberMachine([M1], MAC);
  const el = await render(null);
  await select(el, WORDS);
  expect(toolbarNames()).toEqual(['Comment', 'Looks good', 'Cancel']);
});

test.skipIf(!hasDom)('a machine whose Inbox takes a Delete: Delete is offered and the DELETION goes to that machine', async () => {
  rememberMachine([M1], MAC);
  const el = await render(macbook({ version: '0.28.54', message_deletions: true }));
  await select(el, WORDS);
  expect(toolbarNames()).toEqual(['Delete', 'Comment', 'Looks good', 'Cancel']);
  await act(async () => document.querySelector<HTMLButtonElement>('.annotation-toolbar button[aria-label="Delete"], .annotation-toolbar button[title="Delete"]')!.click());
  await settle();
  expect(posts.map((p) => [p.url, p.body.annotation.type, p.body.annotation.originalText])).toEqual([[`/api/inbox/m/${MAC}/messages/${M1}/annotations`, 'DELETION', WORDS]]);
});

test.skipIf(!hasDom)("this machine's own message: Delete is offered", async () => {
  const el = await render(null);
  await select(el, WORDS);
  expect(toolbarNames()).toEqual(['Delete', 'Comment', 'Looks good', 'Cancel']);
});
