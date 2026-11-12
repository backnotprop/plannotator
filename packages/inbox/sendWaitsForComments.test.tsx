/**
 * A Send pressed while a comment's save is still on its way (a slow link: the
 * server holds the comment, its answer has not reached the window yet). What
 * regresses: the reply going out with the comments the window had confirmed
 * at the press and the newest one left behind as a draft, so the person's
 * reply is split in two; and a comment the server did not take letting the
 * reply go without it.
 *
 * The comments are made through the message's own toolbar and composer; the
 * Inbox's doors are stubbed at `fetch`, the comment's save held until the
 * test lets it answer.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAuthor, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-12T09:00:00.000Z' };
const AGENT: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const M1 = 'msg_01KSENDWAITS0000000000001';
const BODY = 'The retry waits two, four and eight seconds before it gives up on the upstream service.';

const model: InboxThread = {
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
      body: BODY,
      created_at: '2026-11-12T10:00:00.000Z',
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
/** The comments the stub server holds, waiting for a Send. */
let held: InboxAnnotationRecord[] = [];
let replies: { annotation_ids?: string[] }[] = [];
/** Set: each comment save waits here (the server already holds it) until the test lets its answer through. */
let gate: { answer: () => void; refuse: () => void }[] | null = null;

beforeEach(() => {
  if (!hasDom) return;
  held = [];
  replies = [];
  gate = null;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith(`/messages/${M1}/annotations`) && init?.method === 'POST') {
      const annotation = (JSON.parse(String(init.body)) as { annotation: Record<string, unknown> & { id: string } }).annotation;
      const record: InboxAnnotationRecord = {
        id: annotation.id,
        project_id: PROJECT.id,
        thread_id: M1,
        message_id: M1,
        attachment_id: '',
        path: M1,
        version: 'current',
        message: { at: model.messages[0]!.created_at },
        annotation,
        created_at: '2026-11-12T10:10:00.000Z',
        updated_at: '2026-11-12T10:10:00.000Z',
        removed_at: null,
        sent_reply_id: null,
      };
      const waiting = gate;
      if (waiting) {
        const taken = await new Promise<boolean>((resolve) => waiting.push({ answer: () => resolve(true), refuse: () => resolve(false) }));
        if (!taken) return Response.json({ error: 'The Inbox could not save that.' }, { status: 500 });
      }
      held = [...held.filter((r) => r.id !== record.id), record];
      return Response.json({ annotation: record });
    }
    if (path.endsWith('/reply') && init?.method === 'POST') {
      replies.push(JSON.parse(String(init.body)) as { annotation_ids?: string[] });
      return Response.json({ reply: { id: 'msg_reply', thread_id: M1, author: { kind: 'person' } }, questions: [], replayed: false });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: held });
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

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function until(check: () => boolean, what: string, tries = 300) {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await settle(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function render() {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={model}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
      />,
    );
  });
  await settle();
  return host;
}

const messageBody = () => host!.querySelector<HTMLElement>(`[data-message-id="${M1}"]`)!;
const composer = () => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');

/** Select `phrase` in the message the way a drag does, press Comment, write `words`, save. */
async function commentOn(phrase: string, words: string) {
  const walker = document.createTreeWalker(messageBody(), NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  if (!node) throw new Error(`"${phrase}" is not in the message`);
  const at = node.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node!.parentElement!.closest('article') ?? messageBody()).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
  const comment = [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].find((b) => (b.getAttribute('aria-label') ?? b.title) === 'Comment');
  if (!comment) throw new Error('no Comment on the toolbar');
  await act(async () => comment.click());
  await until(() => composer() !== null, 'the composer');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer()!, words);
    composer()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const save = [...document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button')].find((b) => /^(Save|Add comment|Comment)$/.test(b.textContent?.trim() ?? ''));
  if (save) await act(async () => save.click());
  else await act(async () => composer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true })));
  await settle();
}

const sendButton = (el: HTMLElement) => [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === 'Send') ?? null;

async function press(el: HTMLElement) {
  await until(() => sendButton(el) !== null && !sendButton(el)!.disabled, 'the Send');
  await act(async () => sendButton(el)!.click());
}

test.skipIf(!hasDom)('a Send pressed while the newest comment is still saving waits for it, and the one reply carries every comment', async () => {
  const el = await render();
  await until(() => messageBody()?.textContent?.includes('eight seconds') === true, 'the message');
  await commentOn('two, four and eight seconds', 'Cap the total wait.');
  await until(() => held.length === 1, 'the first comment saved');

  // The second comment reaches the server, but its answer is slow to come back.
  gate = [];
  await commentOn('upstream service', 'Name the service.');
  await until(() => gate!.length === 1, 'the second save on its way');
  expect(held).toHaveLength(1);

  await press(el);
  await settle(20);
  // Nothing goes while the save is on its way.
  expect(replies).toHaveLength(0);

  await act(async () => gate!.shift()!.answer());
  await until(() => replies.length === 1, 'the reply');
  await settle(20);
  expect(replies).toHaveLength(1);
  expect(held).toHaveLength(2);
  expect([...(replies[0]!.annotation_ids ?? [])].sort()).toEqual(held.map((r) => r.id).sort());
});

test.skipIf(!hasDom)('a comment the server did not take stops the Send: no reply goes without it', async () => {
  const el = await render();
  await until(() => messageBody()?.textContent?.includes('eight seconds') === true, 'the message');
  await commentOn('two, four and eight seconds', 'Cap the total wait.');
  await until(() => held.length === 1, 'the first comment saved');

  gate = [];
  await commentOn('upstream service', 'Name the service.');
  await until(() => gate!.length === 1, 'the second save on its way');
  await press(el);
  await settle(20);
  await act(async () => gate!.shift()!.refuse());
  await settle(50);
  expect(replies).toHaveLength(0);
  // The Send is over (the button is back) and the line under the reply says why.
  await until(() => sendButton(el) !== null && !sendButton(el)!.disabled, 'the Send back');
  expect(el.querySelector('.ib-error[role="alert"]')).not.toBeNull();
});
