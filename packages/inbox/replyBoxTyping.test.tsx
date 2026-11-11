import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane, MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { AnnotationsChip } = (hasDom ? await import('./components/AnnotationsChip') : {}) as typeof import('./components/AnnotationsChip');
const { REPLY_DRAFT_SAVE_MS } = (hasDom ? await import('./replyDraft') : {}) as typeof import('./replyDraft');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const THREAD = 'msg_01M6RB0000000000000000001';
const id = (n: number) => (n === 1 ? THREAD : `msg_01M6RB000000000000000000${n}`);

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
const TABLE = ['The worker drains in order.', '', '| Step | p95 |', '| --- | --- |', '| read | 40 ms |', '| write | 52 ms |', '', '```ts', 'export const cap = 30_000;', '```'].join('\n');

function questionsOf(messageId: string, body: string): InboxQuestion[] {
  return parseInboxQuestionBlocks(body).map((q) => ({
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
  }));
}

function message(n: number, body: string): InboxMessageWire {
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
    ...(body.includes(':::question') ? { questions: questionsOf(id(n), body) } : {}),
  };
}

const thread = (): InboxThread => ({
  thread_id: THREAD,
  project: PROJECT,
  subject: 'Retry worker',
  thread_name: null,
  resolved_at: null,
  messages: [message(1, TABLE), message(2, TABLE), message(3, CARD)],
});

const KEPT = 'Mostly yes. One thing about the backoff: ';
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let saves: { at: number; body: string }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  saves = [];
  savedFetch = globalThis.fetch;
  const draft = (body: string): InboxReplyDraft => ({ v: 1, thread_id: THREAD, body, created_at: '2026-11-02T10:10:00.000Z', updated_at: new Date().toISOString() });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/draft')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)).body as string;
        saves.push({ at: Date.now(), body });
        return Response.json({ serverSession: 's', draft: draft(body) });
      }
      return Response.json({ serverSession: 's', draft: draft(KEPT) });
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

async function settle(turns = 4, ms = 20) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
  await settle();
  return host;
}

const pane = () => (
  <div className="pn-inbox">
    <ThreadPane thread={thread()} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
  </div>
);

type Fiber = { type: unknown; return: Fiber | null; alternate: Fiber | null; memoizedProps: unknown };

function bodyFibers(el: HTMLElement): Fiber[] {
  return [...el.querySelectorAll<HTMLElement>('[data-message-article] .ib-msg')].map((msg) => {
    const node = msg.querySelector('p, table, [data-block-type]') ?? msg.firstElementChild!;
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'))!;
    let fiber: Fiber | null = (node as unknown as Record<string, Fiber>)[key] ?? null;
    while (fiber && fiber.type !== MessageBody) fiber = fiber.return;
    if (!fiber) throw new Error('no MessageBody above a message node');
    return fiber;
  });
}

const propsOf = (fiber: Fiber) => [fiber.memoizedProps, fiber.alternate?.memoizedProps].filter(Boolean);

function typeKey(field: HTMLTextAreaElement, char: string) {
  // Looked up here, not at load: the file loads without a DOM when DOM tests are off.
  const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setText.call(field, field.value + char);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openWithDraft(): Promise<{ el: HTMLElement; field: HTMLTextAreaElement }> {
  const el = await render(pane());
  const field = el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea');
  expect(field?.value).toBe(KEPT);
  return { el, field: field! };
}

test.skipIf(!hasDom)('a key typed in the reply box re-renders no message body', async () => {
  const { el, field } = await openWithDraft();
  const bodies = bodyFibers(el);
  expect(bodies.length).toBe(3);
  expect(el.querySelectorAll('[data-message-article] input[type="radio"]').length).toBeGreaterThanOrEqual(8);
  const before = bodies.map((fiber) => new Set(propsOf(fiber)));
  field.focus();
  for (const char of 'cap it at 30 s') typeKey(field, char);
  expect(field.value).toBe(`${KEPT}cap it at 30 s`);
  const after = bodyFibers(el);
  after.forEach((fiber, i) => {
    for (const props of propsOf(fiber)) expect(before[i]!.has(props)).toBe(true);
  });
});

test.skipIf(!hasDom)('the draft is saved once typing stops, with every word, not per key', async () => {
  const { field } = await openWithDraft();
  field.focus();
  const started = saves.length;
  for (const char of 'cap it') typeKey(field, char);
  await settle(2, 50);
  expect(saves.length).toBe(started);
  await settle(1, REPLY_DRAFT_SAVE_MS + 100);
  await settle();
  expect(saves.slice(started).map((s) => s.body)).toEqual([`${KEPT}cap it`]);
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
const comment: InboxAnnotationRecord = {
  id: 'ann-1',
  project_id: PROJECT.id,
  thread_id: THREAD,
  message_id: id(1),
  attachment_id: file.id,
  path: file.path,
  version: 'current',
  annotation: { id: 'ann-1', blockId: 'block-0', type: 'COMMENT', text: 'too tight', originalText: 'The worker', startOffset: 0, endOffset: 10, createdA: 1 },
  created_at: '2026-11-02T10:05:00.000Z',
  updated_at: '2026-11-02T10:05:00.000Z',
  removed_at: null,
  sent_reply_id: null,
};

function Box({ records, onRemove }: { records: InboxAnnotationRecord[]; onRemove: (record: InboxAnnotationRecord) => Promise<void> }) {
  return (
    <div className="ib-rbox">
      <textarea aria-label="Reply" />
      <div className="ib-rfoot">
        <AnnotationsChip records={records} attachments={[file]} onEdit={async () => {}} onRemove={onRemove} onOpen={() => {}} />
      </div>
    </div>
  );
}

test.skipIf(!hasDom)('the reply box shows no comments chip with no comment, and "1 comment" with one', async () => {
  const el = await render(<Box records={[]} onRemove={async () => {}} />);
  expect(el.querySelector('[data-annotations-chip]')).toBeNull();
  act(() => root!.render(<Box records={[comment]} onRemove={async () => {}} />));
  await settle();
  expect(el.querySelector('[data-annotations-chip]')?.textContent).toBe('1 comment');
});

test.skipIf(!hasDom)('removing the last comment from the open list closes it, the chip goes, and focus goes back to the reply', async () => {
  let records = [comment];
  const draw = () => root!.render(<Box records={records} onRemove={remove} />);
  const remove = async (record: InboxAnnotationRecord) => {
    records = records.filter((r) => r.id !== record.id);
    draw();
  };
  const el = await render(<Box records={records} onRemove={remove} />);
  await act(async () => el.querySelector<HTMLButtonElement>('[data-annotations-chip]')!.click());
  const removeButton = [...el.querySelectorAll<HTMLButtonElement>('[data-annotation-row] button')].find((b) => b.textContent?.trim() === 'Remove');
  expect(removeButton).toBeDefined();
  removeButton!.focus();
  await act(async () => removeButton!.click());
  await settle();
  expect(el.querySelector('[data-annotation-row]')).toBeNull();
  expect(el.querySelector('[data-annotations-chip]')).toBeNull();
  expect(document.activeElement === el.querySelector('textarea')).toBe(true);
});
