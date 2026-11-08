/**
 * Ask AI's Side and its one icon (approval "inbox-ask-ai-flow", 2026-11-08):
 * selecting words in an agent's message, or in an open file, offers Side
 * after the reactions (Delete · Comment · 👍 | Side | ×), and Side opens the
 * thread's chat with the words quoted in its box. The thread's top bar keeps
 * one Ask icon; a full-screen file's bar has none.
 *
 * The question the agent gets says where the words came from (sideSource.ts),
 * as useAIChat's contextPreamble ahead of it, while the box and the saved
 * question keep only the clean quote.
 *
 * Failures to catch: Side missing from a thread that can ask, or showing in
 * one that cannot (no live agent: a guest's or a linked machine's thread
 * reads `can_ask: false` too), or in the phone layout (the owner hides it
 * there; the top bar icon stays); Side out of its place; a press that opens the
 * window without the words, or not at all; the Ask icon coming back to the
 * full-screen file's bar.
 *
 * The real useInboxAsk, MessageBody, ThreadPane, ui Viewer and
 * web-highlighter, with fetch answering for the Inbox; no Inbox server.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';

const hasDom = typeof document !== 'undefined';
const { MessageBody, ThreadPane } = (hasDom ? await import('../components/Thread') : {}) as typeof import('../components/Thread');
const { useInboxAsk } = (hasDom ? await import('./useInboxAsk') : {}) as typeof import('./useInboxAsk');
const { sideTime } = (hasDom ? await import('./sideSource') : {}) as typeof import('./sideSource');

const PROJECT: InboxProject = { id: 'prj_1', key: 'retry-abcdef', name: 'retry', root: '/work/retry', created_at: '2026-11-08T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const ROOT = 'msg_01K7SIDESIDESIDESIDESIDE01';
const BODY = 'I moved the retry loop into the client.\n\n## Backoff\n\nThe backoff is two, four and eight seconds, and a 429 waits for Retry-After.';
const WORDS = 'and a 429 waits for Retry-After';

const MESSAGE = {
  id: ROOT,
  project_id: PROJECT.id,
  thread_id: ROOT,
  reply_to: null,
  author: AGENT,
  subject: 'Retry budget',
  subject_question: null,
  body: BODY,
  created_at: '2026-11-08T10:00:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  attachments: [],
  questions: [],
} as unknown as InboxMessageWire;

const THREAD: InboxThread = { thread_id: ROOT, project: PROJECT, subject: 'Retry budget', thread_name: null, resolved_at: null, messages: [MESSAGE] } as unknown as InboxThread;

const NOTES: InboxAttachmentState = {
  id: 'att_01K7SIDESIDESIDESIDESIDE01',
  name: 'notes.md',
  path: '/work/retry/notes.md',
  kind: 'markdown',
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  size: 100,
  sent_at: '2026-11-08T10:00:00.000Z',
  sent_mtime: '2026-11-08T10:00:00.000Z',
  message_id: ROOT,
  changed_since_sent: false,
  unavailable: null,
  current: { sha256: 'a'.repeat(64), size: 100, mtime: '2026-11-08T10:00:00.000Z' },
} as InboxAttachmentState;

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  // A page on localhost, as the Inbox is served (the file view keeps its choices in cookies).
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
    window.sessionStorage.clear();
  }
});

/** What the window sent: POST …/ask bodies (the saved turn) and /api/ai/query bodies (what the agent gets). */
let asks: Record<string, unknown>[] = [];
let queries: Record<string, unknown>[] = [];

/** The Inbox's answers: the thread's Ask model (`can_ask` as given), its files, the file's text, and a question taken. */
function serve(canAsk: boolean) {
  asks = [];
  queries = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === 'POST' && url.endsWith(`/threads/${ROOT}/ask`)) {
      asks.push(body);
      const turn = { id: body.turn_id, at: '2026-11-08T12:00:00.000Z', session: 'ses_a', host: 'claude-code', question: body.question, ...(body.source ? { source: body.source } : {}) };
      return Response.json({ conversation: { v: 1, thread_id: ROOT, seen_at: null, turns: [turn] }, turn, provider_id: 'provider-1' });
    }
    if (url.endsWith('/api/ai/session')) return Response.json({ sessionId: 'session-1' });
    if (url.endsWith('/api/ai/query')) {
      queries.push(body);
      return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (method === 'GET' && url.endsWith(`/threads/${ROOT}/ask`)) {
      return Response.json({ subject: 'Retry budget', project: PROJECT.name, conversation: null, running: null, can_ask: canAsk, agent: { host: 'claude-code', name: 'Claude Code' } });
    }
    if (url.includes(NOTES.id) && url.includes('/view')) {
      return Response.json({ attachment: NOTES, version: 'current', text: '# Notes\n\nThe budget is five attempts with a one second start.\n', html: null });
    }
    if (url.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [NOTES], annotations: [] });
    // The file's pin (#2926's artifact pins) reads the pins: none.
    if (url.endsWith('/artifact-pins')) return Response.json({ pins: [] });
    return Response.json({});
  }) as typeof fetch;
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

/** One message as the thread draws it, with the window's Ask: Side comes from the hook, as App passes it. */
function MessageWithAsk({ phone = false }: { phone?: boolean }) {
  const ask = useInboxAsk({ on: true, codeReview: false, threadId: ROOT, phone, openThread: () => {}, replyInThread: () => {} });
  return (
    <div className="pn-inbox">
      <div data-test-top="">{ask.button}</div>
      <MessageBody
        message={MESSAGE}
        projectRoot={PROJECT.root}
        onOpenAttachment={() => {}}
        readOnly={false}
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
        comments={{ annotations: [] as Annotation[], onSave: async () => true, onSide: ask.side }}
      />
      {ask.layer}
    </div>
  );
}

/** The thread with a file open, beside it or full screen, and the window's Ask as App wires it. */
function ThreadWithAsk({ view }: { view: 'full' | 'side' }) {
  const ask = useInboxAsk({ on: true, codeReview: false, threadId: ROOT, phone: false, openThread: () => {}, replyInThread: () => {} });
  return (
    <div className="pn-inbox">
      <ThreadPane
        thread={THREAD}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={{ id: NOTES.id, version: 'current', focus: null, view }}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        askButton={ask.button}
        onSide={ask.side}
      />
      {ask.layer}
    </div>
  );
}

async function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await settle();
}

async function select(scope: HTMLElement, phrase: string) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  if (!node) throw new Error(`no text "${phrase}"`);
  const at = node.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node!.parentElement!.closest('article') ?? scope).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Words after the quote in the box, then Enter: the question goes. */
async function ask(words: string) {
  const box = askBox()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, `${box.value}${words}`);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  });
  await until(() => queries.length > 0, 'the question to reach the agent');
}

const askIcon = () => document.querySelector<HTMLButtonElement>('[data-ask-open]');
const askBox = () => document.querySelector<HTMLTextAreaElement>('[data-chat-window] textarea');
const side = () => document.querySelector<HTMLButtonElement>('.annotation-toolbar [data-annotation-side]');
/** The selection bar left to right: each button's name, "|" for a divider. */
const barOrder = () =>
  [...document.querySelector('.annotation-toolbar [data-pn-annotation-toolbar-row]')!.children].map((el) => {
    const button = el.tagName === 'BUTTON' ? (el as HTMLButtonElement) : el.querySelector('button');
    return button ? button.getAttribute('aria-label') || button.title || button.textContent?.trim() || '' : '|';
  });

test.skipIf(!hasDom)("an agent's message in a thread that can ask: Side after 👍, between dividers; it opens the chat with the words quoted", async () => {
  serve(true);
  await mount(<MessageWithAsk />);
  await until(() => askIcon() !== null, 'the Ask icon');
  // The top bar's icon is the two bubbles, with its name and tooltip as before.
  expect(askIcon()!.getAttribute('aria-label')).toBe('Ask AI about this thread');
  expect(askIcon()!.querySelectorAll('[data-ask-icon="messages-square"]')).toHaveLength(1);

  await select(host!, WORDS);
  expect(barOrder()).toEqual(['Delete', 'Comment', 'Looks good', '|', 'Side', '|', 'Cancel']);
  expect(document.querySelectorAll('[data-chat-window]')).toHaveLength(0);

  await act(async () => side()!.click());
  await until(() => askBox() !== null, 'the Ask window');
  expect(askBox()!.value).toBe(`> ${WORDS}\n\n`);
  // The bar closed; the chat's box has the focus, for the question.
  expect(document.querySelectorAll('.annotation-toolbar')).toHaveLength(0);
  await until(() => document.activeElement === askBox(), 'focus in the box');

  // The question carries where the words came from; the saved question, as the transcript shows it, is the person's alone.
  await ask('Why five?');
  const source = `[Quoted from Claude Code's message ${ROOT} (${sideTime(MESSAGE.created_at)}), under "Backoff".]`;
  expect(asks).toHaveLength(1);
  expect(asks[0]!.question).toBe(`> ${WORDS}\n\nWhy five?`);
  expect(asks[0]!.source).toBe(source);
  expect(queries[0]!.prompt).toBe(`${source}\n\n> ${WORDS}\n\nWhy five?`);
});

test.skipIf(!hasDom)('a thread that cannot ask (no live agent): no Ask icon, and the selection bar has no Side', async () => {
  serve(false);
  await mount(<MessageWithAsk />);
  await settle();
  expect(document.querySelectorAll('[data-ask-open]')).toHaveLength(0);
  await select(host!, WORDS);
  expect(barOrder()).toEqual(['Delete', 'Comment', 'Looks good', '|', 'Cancel']);
  expect(document.querySelectorAll('[data-annotation-side]')).toHaveLength(0);
});

test.skipIf(!hasDom)('the phone layout: the top bar keeps its Ask icon, and the selection bar has no Side', async () => {
  serve(true);
  await mount(<MessageWithAsk phone />);
  await until(() => askIcon() !== null, 'the Ask icon');
  await select(host!, WORDS);
  expect(barOrder()).toEqual(['Delete', 'Comment', 'Looks good', '|', 'Cancel']);
  expect(document.querySelectorAll('[data-annotation-side]')).toHaveLength(0);
});

test.skipIf(!hasDom)('a full-screen file: its bar has no Ask icon (none on the page); Side in the file still opens the chat', async () => {
  serve(true);
  await mount(<ThreadWithAsk view="full" />);
  await until(() => document.querySelector('[data-full-view-bar]') !== null, 'the full-screen bar');
  await until(() => document.body.textContent!.includes('five attempts'), 'the file');
  await settle();
  // Counted, not compared: a failing match would print a whole DOM element.
  expect(document.querySelectorAll('[data-ask-open]')).toHaveLength(0);

  const page = document.querySelector<HTMLElement>('.ib-docscroll')!;
  await select(page, 'five attempts');
  await until(() => side() !== null, 'Side in the file');
  await act(async () => side()!.click());
  await until(() => askBox() !== null, 'the Ask window');
  expect(askBox()!.value).toBe('> five attempts\n\n');

  // The file, the path the agent sent, which version, the line and the heading.
  await ask('Why five?');
  const source = '[Quoted from notes.md (/work/retry/notes.md, attached to this thread; the version sent, unchanged), line 3, under "Notes".]';
  expect(asks[0]!.source).toBe(source);
  expect(queries[0]!.prompt).toBe(`${source}\n\n> five attempts\n\nWhy five?`);
});

test.skipIf(!hasDom)('the file beside the thread: the one Ask icon is in the thread top bar', async () => {
  serve(true);
  await mount(<ThreadWithAsk view="side" />);
  await until(() => askIcon() !== null, 'the Ask icon');
  expect(document.querySelectorAll('[data-ask-open]')).toHaveLength(1);
  expect(askIcon()!.closest('.ib-phead') !== null).toBe(true);
});
