/**
 * Click a word (ui's Viewer: one click on a word highlights it) is OFF in a
 * thread's messages and ON in a file opened from the thread (the owner,
 * 2026-11-10: "Off in thread messages, on in documents, files and plan
 * review").
 *
 * Failures to catch: a click on a word of an agent's message opening the
 * selection bar (a thread is read and clicked through all day); a drag over
 * words in a message no longer offering the comment; the click switched off
 * in an attached Markdown file too.
 *
 * The real MessageBody, ThreadPane, ui Viewer and web-highlighter, with fetch
 * answering for the Inbox; no Inbox server. happy-dom has no layout: the caret
 * under a point is stubbed to a position the test sets.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';
import { CLICK_WORD_WAIT_MS } from '@plannotator/ui/hooks/useClickWord';

const hasDom = typeof document !== 'undefined';
const { MessageBody, ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'retry-abcdef', name: 'retry', root: '/work/retry', created_at: '2026-11-08T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const ROOT = 'msg_01K7CLICKWORDCLICKWORD0001';
const BODY = 'I moved the retry loop into the client.\n\nThe backoff is two, four and eight seconds.';
const FILE_TEXT = '# Notes\n\nThe budget is five attempts with a one second start.\n';

const MESSAGE = {
  id: ROOT, project_id: PROJECT.id, thread_id: ROOT, reply_to: null, author: AGENT, subject: 'Retry budget', subject_question: null,
  body: BODY, created_at: '2026-11-08T10:00:00.000Z', resolved_at: null, idempotency_key: null, attachments: [], questions: [],
} as unknown as InboxMessageWire;
const THREAD = { thread_id: ROOT, project: PROJECT, subject: 'Retry budget', thread_name: null, resolved_at: null, messages: [MESSAGE] } as unknown as InboxThread;
const NOTES = {
  id: 'att_01K7CLICKWORDCLICKWORD0001', name: 'notes.md', path: '/work/retry/notes.md', kind: 'markdown', named_path: null,
  sent_sha256: 'a'.repeat(64), size: 100, sent_at: '2026-11-08T10:00:00.000Z', sent_mtime: '2026-11-08T10:00:00.000Z', message_id: ROOT,
  changed_since_sent: false, unavailable: null, current: { sha256: 'a'.repeat(64), size: 100, mtime: '2026-11-08T10:00:00.000Z' },
} as InboxAttachmentState;

let root: Root | null = null;
let host: HTMLElement | null = null;
let caret: { node: Node; offset: number } | null = null;
const realFetch = globalThis.fetch;
type CaretDoc = { caretRangeFromPoint?: unknown; caretPositionFromPoint?: unknown };
let saved: { range: unknown; position: unknown; rects: unknown } | null = null;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom && saved) {
    (document as unknown as CaretDoc).caretRangeFromPoint = saved.range;
    (document as unknown as CaretDoc).caretPositionFromPoint = saved.position;
    (Range.prototype as unknown as { getClientRects: unknown }).getClientRects = saved.rects;
    saved = null;
  }
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
    window.sessionStorage.clear();
  }
});

function serve() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(NOTES.id) && url.includes('/view')) return Response.json({ attachment: NOTES, version: 'current', text: FILE_TEXT, html: null });
    if (url.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [NOTES], annotations: [] });
    if (url.endsWith('/artifact-pins')) return Response.json({ pins: [] });
    return Response.json({});
  }) as typeof fetch;
}

async function mount(node: React.ReactNode) {
  const doc = document as unknown as CaretDoc;
  saved = { range: doc.caretRangeFromPoint, position: doc.caretPositionFromPoint, rects: Range.prototype.getClientRects };
  doc.caretRangeFromPoint = undefined;
  doc.caretPositionFromPoint = () => (caret ? { offsetNode: caret.node, offset: caret.offset } : null);
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [{ left: 0, right: 0, top: 0, bottom: 0 }];
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

/** The text node holding `word` in the document that holds `near`, and a position inside the word. */
function wordIn(near: string, word: string) {
  const article = [...document.querySelectorAll('article')].find((a) => a.textContent?.includes(near));
  if (!article) throw new Error(`no document with "${near}"`);
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = (n.textContent ?? '').indexOf(word);
    if (at >= 0) return { article, node: n as Text, at, element: (n as Text).parentElement! };
  }
  throw new Error(`no "${word}"`);
}

const pointer = (type: string): Event => {
  const init = { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, pointerType: 'mouse' };
  return typeof PointerEvent === 'function' ? new PointerEvent(type, init) : new MouseEvent(type, init);
};
const mouse = (type: string) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, detail: 1 });

/** One click on `word`, then the wait a word click takes to become a highlight. */
async function clickWord(near: string, word: string) {
  const target = wordIn(near, word);
  caret = { node: target.node, offset: target.at + 1 };
  await act(async () => {
    for (const event of [pointer('pointerdown'), mouse('mousedown'), pointer('pointerup'), mouse('mouseup'), mouse('click')]) target.element.dispatchEvent(event);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, CLICK_WORD_WAIT_MS + 80)); });
  return target.article;
}

const marksIn = (article: Element) => [...article.querySelectorAll('mark')].map((m) => m.textContent).join('|');
const toolbar = () => document.querySelector('.annotation-toolbar');

const message = (
  <div className="pn-inbox">
    <MessageBody
      message={MESSAGE}
      projectRoot={PROJECT.root}
      onOpenAttachment={() => {}}
      readOnly={false}
      answers={new Map()}
      onPick={() => {}}
      footerFor={() => null}
      comments={{ annotations: [] as Annotation[], onSave: async () => true }}
    />
  </div>
);

test.skipIf(!hasDom)('a click on a word of a thread message makes nothing', async () => {
  serve();
  await mount(message);

  const article = await clickWord('retry loop', 'retry');

  expect(marksIn(article)).toBe('');
  expect(toolbar()).toBeNull();
  expect(window.getSelection()!.isCollapsed).toBe(true);
});

test.skipIf(!hasDom)('a drag over words of a thread message still offers the comment', async () => {
  serve();
  await mount(message);
  const target = wordIn('retry loop', 'retry loop');
  const range = document.createRange();
  range.setStart(target.node, target.at);
  range.setEnd(target.node, target.at + 'retry loop'.length);

  await act(async () => {
    target.element.dispatchEvent(mouse('mousedown'));
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    target.element.dispatchEvent(mouse('mouseup'));
  });
  await until(() => toolbar() !== null, 'the selection bar');

  expect(marksIn(target.article)).toBe('retry loop');
});

test.skipIf(!hasDom)('a click on a word of a Markdown file opened from the thread highlights it', async () => {
  serve();
  await mount(
    <div className="pn-inbox">
      <ThreadPane
        thread={THREAD}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={{ id: NOTES.id, version: 'current', focus: null, view: 'side' }}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
      />
    </div>,
  );
  await until(() => [...document.querySelectorAll('article')].some((a) => a.textContent?.includes('budget is five')), 'the file to draw');

  const article = await clickWord('budget is five', 'budget');

  expect(marksIn(article)).toBe('budget');
  expect(toolbar()).not.toBeNull();
});
