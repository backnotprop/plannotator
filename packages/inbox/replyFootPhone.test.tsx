/**
 * Assertions compare booleans and strings, never elements: a failed `expect(element)` makes bun print a happy-dom
 * node, which can take the test process down instead of failing the test.
 *
 * The reply box's foot on a phone (approval "inbox-reply-foot-phone", variant B "Summary"): one row, the
 * paperclip, one quiet line naming only what goes with this Send ("4 questions open · 3 comments"), the mic. The
 * owner, of the stacked chips it replaces: "very bad looking on mobile. not good, not acceptable".
 *
 * - Nothing waiting: no line, and no "2 picks" chip (the answers list above says it).
 * - Comments only: the line opens the comments list itself, and closing the list puts focus back on the line.
 * - Questions: the line opens a sheet; its "Skip them" skips them for this Send, and the line says so.
 * - Both: the sheet holds both; "Review" opens the comments list.
 * - Picks on a replaced question that won't be sent: in the sheet.
 * - Where the row is too narrow for the full words (a 320 px phone): "4 open · 3 comments".
 * - Focus: Escape and × close the sheet, back on the line.
 * - Desktop keeps today's chips.
 *
 * The layout (one row, 44 px targets at 390 and 320) is proved in tests/e2e/inbox-reply-foot-phone.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'codex', session: 'ses_a', name: 'Codex (northwind-industries-holdings platform reviewer)' };
const THREAD = 'msg_01M6RF0000000000000000001';
const id = (n: number) => (n === 1 ? THREAD : `msg_01M6RF000000000000000000${n}`);

const question = (prompt: string, choices: string[]) => [':::question', prompt, '', ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');
const CARD = [
  'Four decisions before I go on.',
  '',
  question('Which backoff should the worker use?', ['Exponential', 'Fixed 5 s']),
  '',
  question('Ship it behind a flag?', ['Yes', 'No']),
  '',
  question('Keep the dead-letter queue for 7 days or 30?', ['7 days', '30 days']),
  '',
  question('Who reviews the migration?', ['You', 'Me']),
].join('\n');
const PROSE = 'The worker drains in order, and the dead-letter path is wired.';

type Tweak = (q: InboxQuestion) => InboxQuestion;
/** The first choice picked. */
const answerOf = (q: InboxQuestion) => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [q.choices[0]!.label] }) as InboxQuestion['answer'];
function questionsOf(messageId: string, body: string, tweak: Tweak): InboxQuestion[] {
  return parseInboxQuestionBlocks(body).map((q) =>
    tweak({
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
      asked_by_agent_id: A.session,
      orphaned: false,
      state: 'open',
      answer: null,
      revision: 0,
      sent_revision: 0,
      picked_by: null,
      picked_at: null,
      sent_reply_id: null,
      message_id: messageId,
      superseded_by: null,
    }),
  );
}

function message(n: number, body: string, tweak: Tweak): InboxMessageWire {
  return {
    id: id(n),
    project_id: PROJECT.id,
    thread_id: THREAD,
    reply_to: n === 1 ? null : id(n - 1),
    author: A,
    subject: n === 1 ? 'Retry worker' : null,
    body,
    created_at: `2026-11-02T10:0${n}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    ...(body.includes(':::question') ? { questions: questionsOf(id(n), body, tweak) } : {}),
  };
}

const thread = (questions: boolean, tweak: Tweak = (q) => q): InboxThread => ({
  thread_id: THREAD,
  project: PROJECT,
  subject: 'Retry worker',
  thread_name: null,
  resolved_at: null,
  messages: [message(1, PROSE, tweak), message(2, questions ? CARD : PROSE, tweak)],
});

const file: InboxAttachmentState = {
  id: 'att_1',
  message_id: id(1),
  name: 'notes.md',
  path: 'docs/notes.md',
  kind: 'markdown',
  size: 10,
  sha256: 'a'.repeat(64),
  sent_at: '2026-11-02T10:00:00.000Z',
  changed: false,
} as unknown as InboxAttachmentState;
const comment = (n: number): InboxAnnotationRecord => ({
  id: `ann-${n}`,
  project_id: PROJECT.id,
  thread_id: THREAD,
  message_id: id(1),
  attachment_id: file.id,
  path: file.path,
  version: 'current',
  annotation: { id: `ann-${n}`, blockId: 'block-0', type: 'COMMENT', text: `note ${n}`, originalText: 'The worker', startOffset: 0, endOffset: 10, createdA: n },
  created_at: '2026-11-02T10:05:00.000Z',
  updated_at: '2026-11-02T10:05:00.000Z',
  removed_at: null,
  sent_reply_id: null,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let comments: InboxAnnotationRecord[] = [];
let closes = 0;

beforeEach(() => {
  if (!hasDom) return;
  comments = [];
  closes = 0;
  savedFetch = globalThis.fetch;
  const draft = (body: string): InboxReplyDraft => ({ v: 1, thread_id: THREAD, body, created_at: '2026-11-02T10:10:00.000Z', updated_at: new Date().toISOString() });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    // A saved draft: the box opens holding it.
    if (path.includes('/draft')) return Response.json({ serverSession: 's', draft: draft(init?.method === 'POST' ? JSON.parse(String(init.body)).body : 'Mostly yes.') });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: comments.length ? [file] : [], annotations: comments });
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

async function settle(turns = 4, ms = 20) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

async function open({ questions, n = 0, phone = true, tweak }: { questions: boolean; n?: number; phone?: boolean; tweak?: Tweak }): Promise<HTMLElement> {
  comments = Array.from({ length: n }, (_, i) => comment(i + 1));
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={thread(questions, tweak)} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => (closes += 1)} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone={phone} />
      </div>,
    );
  });
  await settle();
  expect(!!(host.querySelector('.ib-rbox textarea'))).toBe(true);
  return host;
}

const line = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.ib-rbox [data-foot-summary]');
const words = (el: HTMLElement) => line(el)?.querySelector('[data-foot-summary-text]')?.textContent ?? null;
const sheet = () => document.querySelector<HTMLElement>('[data-foot-sheet] [role="dialog"]');
const press = async (button: HTMLElement | null | undefined) => {
  expect(!!button).toBe(true);
  await act(async () => button!.click());
  await settle(2);
};
const buttonIn = (el: ParentNode | null, name: string) =>
  [...(el?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name) ?? null;

test.skipIf(!hasDom)('nothing waiting: one row of the paperclip alone, no line', async () => {
  const el = await open({ questions: false });
  expect(!!el.querySelector('.ib-rbox [data-reply-foot-phone] [data-reply-attach]')).toBe(true);
  expect(!!(line(el))).toBe(false);
  // Today's chips are gone from the phone's box.
  expect(!!(el.querySelector('.ib-rbox [data-annotations-chip], .ib-rbox [data-skip-chip], .ib-rbox [data-picks-chip]'))).toBe(false);
});

test.skipIf(!hasDom)('comments only: the line names them and opens their list in one press; closing it puts focus back on the line', async () => {
  const el = await open({ questions: false, n: 3 });
  expect(words(el)).toBe('3 comments');
  await press(line(el));
  expect(!!(sheet())).toBe(false);
  const list = el.querySelector<HTMLElement>('[data-comments-list]');
  expect(list?.querySelectorAll('[data-annotation-row]').length).toBe(3);
  await press(buttonIn(list, 'Close the list'));
  expect(!!(el.querySelector('[data-comments-list]'))).toBe(false);
  expect(document.activeElement === line(el)).toBe(true);
});

test.skipIf(!hasDom)('questions only: the line opens a sheet whose Skip them skips them for this Send, and the line says so', async () => {
  const el = await open({ questions: true });
  expect(words(el)).toBe('4 questions open');
  const status = () => [...el.querySelectorAll('.ib-sr[role="status"]')].map((s) => s.textContent).join(' ');
  expect(status()).not.toContain('will be skipped');
  await press(line(el));
  expect(sheet()?.textContent).toContain('4 questions stay open');
  await press(buttonIn(sheet(), 'Skip them'));
  expect(status()).toContain('4 questions will be skipped when you send.');
  expect(words(el)).toBe('4 questions to skip');
  // The sheet stays, its switch now the way back.
  await press(buttonIn(sheet(), 'Keep open'));
  expect(status()).not.toContain('will be skipped');
  expect(words(el)).toBe('4 questions open');
});

test.skipIf(!hasDom)('both: one line for both; the sheet holds both, and Review opens the comments list', async () => {
  const el = await open({ questions: true, n: 3 });
  expect(words(el)).toBe('4 questions open · 3 comments');
  await press(line(el));
  expect(!!(sheet()?.querySelector('[data-foot-sheet-row="questions"]'))).toBe(true);
  expect(sheet()?.querySelector('[data-foot-sheet-row="comments"]')?.textContent).toContain('3 comments');
  await press(buttonIn(sheet(), 'Review comments'));
  expect(!!(sheet())).toBe(false);
  expect(el.querySelectorAll('[data-comments-list] [data-annotation-row]').length).toBe(3);
});

test.skipIf(!hasDom)('Escape and × close the sheet, focus back on the line', async () => {
  const el = await open({ questions: true, n: 1 });
  await press(line(el));
  expect(document.activeElement === sheet()).toBe(true);
  // Escape pressed in the sheet (focus is on it).
  await act(async () => sheet()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle(2);
  expect(!!(sheet())).toBe(false);
  expect(document.activeElement === line(el)).toBe(true);
  // Escape went to the sheet alone: the reply box is still open and the thread was not closed.
  expect(!!(el.querySelector('.ib-rbox textarea'))).toBe(true);
  expect(closes).toBe(0);
  await press(line(el));
  await press(buttonIn(sheet(), 'Close'));
  expect(!!(sheet())).toBe(false);
  expect(document.activeElement === line(el)).toBe(true);
});

test.skipIf(!hasDom)('no "2 picks" chip: the answers list above already says it', async () => {
  const picked: Tweak = (q) => (q.position < 2 ? { ...q, state: 'picked', answer: answerOf(q) } : q);
  const el = await open({ questions: true, tweak: picked });
  expect(!!(el.querySelector('.ib-rbox .ib-ranswers'))).toBe(true);
  expect(!!(el.querySelector('[data-picks-chip]'))).toBe(false);
  expect(words(el)).toBe('2 questions open');
});

test.skipIf(!hasDom)('picks on a replaced question that will not be sent are in the sheet', async () => {
  const replaced: Tweak = (q) => (q.position === 0 ? { ...q, state: 'superseded', answer: answerOf(q) } : q);
  const el = await open({ questions: true, tweak: replaced });
  expect(!!(el.querySelector('[data-dropped-picks-chip]'))).toBe(false);
  await press(line(el));
  expect(sheet()?.querySelector('[data-foot-sheet-row="dropped"]')?.textContent).toContain('1 pick on a replaced question won’t be sent');
});

test.skipIf(!hasDom)('where the full words do not fit (a 320 px phone), the line reads "4 open · 3 comments"', async () => {
  // The line's text box is 170 px wide; its words take 8 px a character.
  const proto = HTMLElement.prototype;
  const saved = { scroll: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'), client: Object.getOwnPropertyDescriptor(proto, 'clientWidth') };
  const isText = (el: HTMLElement) => el.hasAttribute('data-foot-summary-text');
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return isText(this) ? (this.textContent?.length ?? 0) * 8 : (saved.scroll?.get?.call(this) ?? 0); } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return isText(this) ? 170 : (saved.client?.get?.call(this) ?? 0); } });
  try {
    const el = await open({ questions: true, n: 3 });
    expect(words(el)).toBe('4 open · 3 comments');
    // Its name still says it whole.
    expect(line(el)?.getAttribute('aria-label')).toBe('4 questions stay open, 3 comments');
  } finally {
    if (saved.scroll) Object.defineProperty(proto, 'scrollWidth', saved.scroll);
    if (saved.client) Object.defineProperty(proto, 'clientWidth', saved.client);
  }
});

test.skipIf(!hasDom)('desktop keeps its chips: the skip chip and "3 comments", no line', async () => {
  const el = await open({ questions: true, n: 3, phone: false });
  expect(!!(line(el))).toBe(false);
  expect(!!(el.querySelector('[data-reply-foot-phone]'))).toBe(false);
  expect(el.querySelector('.ib-rbox .ib-rfoot [data-skip-chip]')?.textContent).toContain('4 questions stay open');
  expect(el.querySelector('.ib-rbox .ib-rfoot [data-annotations-chip]')?.textContent).toBe('3 comments');
});
