/**
 * A question the archive of a MOVED thread closed draws closed (the owner, 2026-11-22: only a thread whose
 * questions moved, its root's `moved_to`; a plainly archived thread stays as on main): the server reads it `closed`
 * (no answer, no Mark read), and the card used to take its tag from the
 * missing answer, so an archived thread showed "Open" over its choices and
 * the person could take it for a question still waiting. It reads "Closed"
 * with the archived action item's words in its foot, and no choice can be
 * ticked; a pick saved before the archive does not make it a "Draft". After
 * Unarchive the server reads it open again, and so does the card.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing', root: '/work/billing', created_at: '2026-11-20T06:00:00.000Z' };
const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_sub', name: null };
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
// The person's reply that carried a sent answer or skip (not in the thread here: it would fold the card away).
const M2 = 'msg_01M4H6G73M9H3Z32T859E72DPZ';
const BODY = ['Overnight work on retries.', '', ':::question', 'Retry failed charges automatically?', '', '- [ ] Yes, three times over 24 h', '- [ ] No, email the customer', ':::'].join('\n');

/** `picked`: a pick saved, not sent. `sent`: an answer (or a skip) the person sent before the archive. */
type Given = boolean | 'sent-answer' | 'sent-skip';

function questions(state: InboxQuestion['state'], given: Given = false): InboxQuestion[] {
  const picked = given !== false;
  const sent = given === 'sent-answer' || given === 'sent-skip';
  return parseInboxQuestionBlocks(BODY).map((q) => ({
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
    asked_by_agent_id: AGENT.session,
    orphaned: false,
    state,
    answer:
      given === 'sent-skip'
        ? { v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected: [], skipped: true, by_reply: true }
        : picked
          ? { v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected: ['Yes, three times over 24 h'] }
          : null,
    revision: picked ? 1 : 0,
    sent_revision: sent ? 1 : 0,
    picked_by: null,
    picked_at: picked ? '2026-11-20T03:00:00.000Z' : null,
    sent_reply_id: sent ? M2 : null,
    message_id: M1,
    superseded_by: null,
  }));
}

const BRIEF = 'msg_01M4H6G73M9H3Z32T859E72DQ0';

/** `moved`: the archive pointed its questions at another thread (resolve_message's `moved_to`). */
function thread(archived: boolean, picked: Given = false, moved = archived): InboxThread {
  const root: InboxMessageWire = {
    id: M1,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: null,
    author: AGENT,
    subject: 'Retry policy',
    body: BODY,
    created_at: '2026-11-20T02:00:00.000Z',
    resolved_at: archived ? '2026-11-20T07:00:00.000Z' : null,
    idempotency_key: null,
    seq: 1,
    questions: questions(archived ? 'closed' : 'open', picked),
    ...(moved ? { moved_to: { thread_id: BRIEF, subject: 'Morning brief', open: true as const, name: 'Morning brief' } } : {}),
  };
  return { thread_id: M1, project: PROJECT, subject: 'Retry policy', thread_name: null, resolved_at: root.resolved_at, archive_seq: archived ? 5 : null, messages: [root] };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/draft')) return Response.json({ draft: null });
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

const pane = (t: InboxThread) => (
  <div className="pn-inbox">
    <ThreadPane thread={t} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
  </div>
);

async function settle() {
  for (let i = 0; i < 2; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

async function render(t: InboxThread) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(t));
  });
  await settle();
  return host;
}

/** The card's tags (status and the others), its foot, and whether any choice can be ticked. */
function card(el: HTMLElement) {
  const block = el.querySelector('[data-question-status]')!;
  const inputs = [...block.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')];
  return {
    text: block.textContent ?? '',
    inputs: inputs.length,
    enabled: inputs.filter((input) => !input.disabled).length,
  };
}

test.skipIf(!hasDom)('a plainly archived thread (no moved_to) is as on main: no Closed tag, no archived words', async () => {
  const el = await render(thread(true, false, false));
  const plain = card(el);
  expect(plain.text).toContain('Open');
  expect(plain.text).not.toContain('Closed');
  expect(plain.enabled).toBe(0);
});

test.skipIf(!hasDom)('a moved thread: its question reads Closed, with the archived words, and no choice can be ticked; Unarchive opens it again', async () => {
  const el = await render(thread(true));
  const closed = card(el);
  expect(closed.text).toContain('Closed');
  expect(closed.text).not.toContain('Open');
  expect(closed.text).toContain('Closed when the thread was archived.');
  expect(closed.inputs).toBeGreaterThan(0);
  expect(closed.enabled).toBe(0);

  // Unarchive: the server reads the question open again, and the next read draws it open.
  act(() => root!.render(pane(thread(false))));
  await settle();
  const open = card(el);
  expect(open.text).toContain('Open');
  expect(open.text).not.toContain('Closed when the thread was archived.');
  expect(open.enabled).toBe(open.inputs);
});

test.skipIf(!hasDom)('a pick saved before the archive does not make the closed card a Draft', async () => {
  const el = await render(thread(true, true));
  const closed = card(el);
  expect(closed.text).toContain('Closed');
  expect(closed.text).not.toContain('Draft');
  expect(closed.enabled).toBe(0);
});

test.skipIf(!hasDom)('an answer sent before the archive keeps its Answered tag; the archive did not close it', async () => {
  const el = await render(thread(true, 'sent-answer'));
  const sent = card(el);
  expect(sent.text).toContain('Answered');
  expect(sent.text).not.toContain('Closed');
});

test.skipIf(!hasDom)('a skip sent before the archive keeps its Skipped tag', async () => {
  const el = await render(thread(true, 'sent-skip'));
  const sent = card(el);
  expect(sent.text).toContain('Skipped');
  expect(sent.text).not.toContain('Closed');
});
