import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxMessageWire } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';
import { attachmentFeedback } from './attachments';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : { MessageBody: null }) as typeof import('./components/Thread');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const AGENT = { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' } as const;
const PERSON = { kind: 'person' } as const;
const MESSAGE_ID = 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-11-06T16:10:00.000Z';
const BODY = 'I moved the retry loop into the client.\n\nThe backoff is two, four and eight seconds, and a 429 waits for Retry-After.';

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function render(author: InboxMessageWire['author'], saved: Annotation[]) {
  const message = {
    id: MESSAGE_ID,
    thread_id: MESSAGE_ID,
    project_id: 'prj_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    author,
    body: BODY,
    created_at: AT,
    attachments: [],
    questions: [],
  } as unknown as InboxMessageWire;
  const comments = author.kind === 'agent'
    ? { annotations: [] as Annotation[], onSave: async (annotation: Annotation) => (saved.push(annotation), true) }
    : undefined;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody message={message} projectRoot="/work/widgets" onOpenAttachment={() => {}} readOnly={false} answers={new Map()} onPick={() => {}} footerFor={() => null} comments={comments} />,
    );
  });
  await settle();
  return host;
}

async function select(scope: HTMLElement, phrase: string) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  const at = node!.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node!, at);
  range.setEnd(node!, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node!.parentElement!.closest('article') ?? scope).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const toolbarNames = () => [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].map((b) => b.getAttribute('aria-label') ?? b.title);

test.skipIf(!hasDom)("words in an agent's message: Delete, Comment, 👍 (plan review's order, no label picker); Delete saves a DELETION the Send tells the agent to remove", async () => {
  const saved: Annotation[] = [];
  const el = await render(AGENT, saved);
  await select(el, 'and a 429 waits for Retry-After');
  expect(toolbarNames()).toEqual(['Delete', 'Comment', 'Looks good', 'Cancel']);

  await act(async () => document.querySelector<HTMLButtonElement>('.annotation-toolbar button[aria-label="Delete"], .annotation-toolbar button[title="Delete"]')!.click());
  await settle();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ type: 'DELETION', originalText: 'and a 429 waits for Retry-After' });
  expect(saved[0]!.text ?? '').toBe('');
  expect(el.querySelector('mark.annotation-highlight.deletion')?.textContent).toBe('and a 429 waits for Retry-After');

  const record: InboxAnnotationRecord = {
    id: saved[0]!.id,
    project_id: 'prj_x',
    thread_id: MESSAGE_ID,
    message_id: MESSAGE_ID,
    attachment_id: '',
    path: MESSAGE_ID,
    version: 'current',
    message: { at: AT },
    annotation: JSON.parse(JSON.stringify(saved[0])),
    created_at: AT,
    updated_at: AT,
    removed_at: null,
    sent_reply_id: null,
  };
  const feedback = attachmentFeedback([record], [], new Map(), '/work/widgets');
  expect(feedback).toContain(`(${MESSAGE_ID})`);
  expect(feedback).toContain('### 1. Remove this: "and a 429 waits for Retry-After"\n> I don\'t want this in your message.');
});

test.skipIf(!hasDom)("the person's own message opens no toolbar, Delete included", async () => {
  const el = await render(PERSON, []);
  await select(el, 'and a 429 waits for Retry-After');
  expect(toolbarNames()).toEqual([]);
});
