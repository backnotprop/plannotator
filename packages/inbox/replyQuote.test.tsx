/**
 * Reply with a quote (approval "inbox-reply-quote", issue #3109), in the window: ↩ on an older message puts one
 * quiet line in the reply box naming it, Send carries it as `quote`, × takes it away, a draft keeps it, the person's
 * own messages take ↩ too, and a sent reply shows the line instead of the lead. The failure this catches: a plain
 * Reply that grows a line or sends a `quote`, or a quote the person removed that still goes.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxReplyQuoteLead } from '@plannotator/core/inbox-reply-quote';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'docs-abcdef', name: 'docs', root: '/work/docs', created_at: '2026-11-01T10:00:00.000Z' };
const CLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: null };
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const M2 = 'msg_01M4H7AAAAAAAAAAAAAAAAAAAA';
const M3 = 'msg_01M4H7BBBBBBBBBBBBBBBBBBBB';
const M4 = 'msg_01M4H7CCCCCCCCCCCCCCCCCCCC';

function message(id: string, author: InboxMessageWire['author'], minute: number, body: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'How the parts fit' : null,
    body,
    created_at: `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    ...extra,
  };
}

const FIRST = message(M1, CLAUDE, 4, 'Here is how the three fit together. Machines run your agents.');
const LATER = message(M2, CLAUDE, 9, 'I also linked the terms. Want a PR?');
const threadOf = (...messages: InboxMessageWire[]): InboxThread => ({ thread_id: M1, project: PROJECT, subject: 'How the parts fit', thread_name: null, resolved_at: null, messages });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
/** The draft the thread opens with (a reload's), or null. */
let savedDraft: Record<string, unknown> | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  savedDraft = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ path, body });
      if (path.endsWith('/draft')) return Response.json({ draft: { thread_id: M1, body: body.body, updated_at: new Date(Date.now() + posted.length).toISOString(), ...(body.quote ? { quote: body.quote } : {}) } });
      if (path.endsWith('/reply')) return Response.json({ reply: {}, questions: [], replayed: false });
      return Response.json({ questions: [] });
    }
    if (path.endsWith('/draft')) return Response.json({ draft: savedDraft });
    if (path.includes('/taggable')) return Response.json({ serverSession: 's', owner: null, sessions: [] });
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

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(thread: InboxThread, phone = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone={phone} />
      </div>,
    );
  });
  await settle();
  await settle();
  return host;
}

function button(el: Element, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

async function arrow(el: HTMLElement, id: string) {
  const press = el.querySelector(`[data-message-reply="${id}"]`) as HTMLButtonElement | null;
  if (!press) throw new Error(`no ↩ on ${id}`);
  act(() => {
    press.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    press.click();
  });
  await settle();
}

async function type(el: HTMLElement, words: string) {
  const text = el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function send(el: HTMLElement) {
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
}

const line = (el: HTMLElement) => el.querySelector('[data-reply-quote]');
const replies = () => posted.filter((p) => p.path.endsWith('/reply'));
const drafts = () => posted.filter((p) => p.path.endsWith('/draft'));

test.skipIf(!hasDom)('a plain Reply (the footer, or ↩ on the newest message) has no quote line and sends no quote', async () => {
  const el = await render(threadOf(FIRST, LATER));
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Reply').click());
  await settle();
  expect(line(el)).toBeNull();
  await arrow(el, M2);
  expect(line(el)).toBeNull();
  await type(el, 'Yes, open it.');
  await send(el);
  expect(replies()).toHaveLength(1);
  expect('quote' in replies()[0]!.body).toBe(false);
});

test.skipIf(!hasDom)('↩ on an older message: the line names it in the box, and Send carries it with its time', async () => {
  const el = await render(threadOf(FIRST, LATER));
  await arrow(el, M1);
  const quote = line(el);
  expect(quote?.getAttribute('data-reply-quote')).toBe(M1);
  expect(quote?.closest('.ib-rbox')).not.toBeNull();
  expect(quote?.textContent).toContain('Here is how the three fit together.');
  expect(quote?.getAttribute('aria-label')?.startsWith("Replying to Claude Code's message from ")).toBe(true);
  await type(el, 'Say the machines part again.');
  await send(el);
  const sent = replies().at(-1)!.body;
  expect(sent.quote).toMatchObject({ of: M1 });
  expect(typeof (sent.quote as { time?: unknown }).time).toBe('string');
  expect((sent.quote as { words?: unknown }).words).toBeUndefined();
});

test.skipIf(!hasDom)('× takes the quote away: the draft learns it (quote null), and Send carries none', async () => {
  const el = await render(threadOf(FIRST, LATER));
  await arrow(el, M1);
  await type(el, 'Scratch the first part.');
  await settle(1100);
  expect(drafts().at(-1)!.body.quote).toEqual({ of: M1 });
  act(() => (el.querySelector('[data-reply-quote-remove]') as HTMLButtonElement).click());
  await settle();
  expect(line(el)).toBeNull();
  await settle(1100);
  expect(drafts().at(-1)!.body.quote).toBeNull();
  await send(el);
  expect('quote' in replies().at(-1)!.body).toBe(false);
});

test.skipIf(!hasDom)('a draft saved with a quote opens with its line, and Send carries it', async () => {
  savedDraft = { thread_id: M1, body: 'Explain this.', updated_at: '2026-11-01T10:20:00.000Z', quote: { of: M1, words: 'Machines run your agents.' } };
  const el = await render(threadOf(FIRST, LATER));
  await settle(50);
  if (!el.querySelector('textarea:not([data-question-other])')) {
    act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Reply').click());
    await settle();
  }
  const quote = line(el);
  expect(quote?.getAttribute('data-reply-quote')).toBe(M1);
  expect(quote?.hasAttribute('data-quote-words')).toBe(true);
  expect(quote?.textContent).toContain('“Machines run your agents.”');
  await send(el);
  expect(replies().at(-1)!.body.quote).toMatchObject({ of: M1, words: 'Machines run your agents.' });
});

test.skipIf(!hasDom)("the person's own message takes ↩ and is quoted", async () => {
  const mine = message(M3, { kind: 'person' }, 6, 'Keep the old path.', { reply_to: M1 });
  const el = await render(threadOf(FIRST, mine, message(M4, CLAUDE, 9, 'Done.')));
  await arrow(el, M3);
  expect(line(el)?.getAttribute('data-reply-quote')).toBe(M3);
  expect(line(el)?.getAttribute('aria-label')?.startsWith('Replying to your message from ')).toBe(true);
});

test.skipIf(!hasDom)('a sent reply with a quote shows the line, not the lead; one without a quote keeps its words as they are', async () => {
  const lead = inboxReplyQuoteLead({ whose: { kind: 'yours' }, id: M1, time: '10:04 AM', text: 'Here is how the three fit together.', selected: false });
  const quoted = message(M3, { kind: 'person' }, 10, `${lead}\n\nSay it again.`, { reply_to: M2, quote: { of: M1 } });
  // A body that only looks like a lead, from a reply without `quote`, is drawn as written.
  const plain = message(M4, { kind: 'person' }, 11, `${lead}\n\nTyped by hand.`, { reply_to: M2 });
  const el = await render(threadOf(FIRST, LATER, quoted, plain));
  const article = el.querySelector(`[data-message-article="${M3}"]`)!;
  expect(article.querySelector('[data-sent-quote]')?.getAttribute('data-sent-quote')).toBe(M1);
  expect(article.textContent).toContain('Say it again.');
  expect(article.textContent).not.toContain(`(${M1})`);
  const other = el.querySelector(`[data-message-article="${M4}"]`)!;
  expect(other.querySelector('[data-sent-quote]')).toBeNull();
  expect(other.textContent).toContain(`(${M1})`);
});

test.skipIf(!hasDom)('words selected in a message, then its ↩ (the newest one too): the line quotes those words, and Send carries them', async () => {
  const el = await render(threadOf(FIRST, LATER));
  const body = el.querySelector(`[data-message-article="${M2}"] .ib-msg`)!;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node && !node.data.includes('linked the terms')) node = walker.nextNode() as Text | null;
  if (!node) throw new Error('no text to select');
  const at = node.data.indexOf('linked the terms');
  document.getSelection()!.setBaseAndExtent(node, at, node, at + 'linked the terms'.length);
  await arrow(el, M2);
  const quote = line(el);
  expect(quote?.getAttribute('data-reply-quote')).toBe(M2);
  expect(quote?.hasAttribute('data-quote-words')).toBe(true);
  expect(quote?.textContent).toContain('“linked the terms”');
  await type(el, 'Which terms?');
  await send(el);
  expect(replies().at(-1)!.body.quote).toMatchObject({ of: M2, words: 'linked the terms' });
});
