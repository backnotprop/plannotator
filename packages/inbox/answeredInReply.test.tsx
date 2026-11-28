import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { ANSWERED_IN_REPLY_LINE } from './apiError';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'harbor-abcdef', name: 'harbor', root: '/work/harbor', created_at: '2026-11-27T16:00:00.000Z' };
const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };
const ASKED = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const REPLY = 'msg_01M4H8QK2V7D9C1X5RZ3N0AB4T';
const GOT_IT = 'msg_01M4HA0000000000000000000A';
const QUOTE = "Yep, keep Jenkins for a week, that's fine.";

const BODY = [
  'The new runner is up.',
  '',
  ':::question',
  'Which region should the new runner live in?',
  '',
  '- [ ] us-east-1',
  '- [ ] eu-west-1',
  ':::',
  '',
  ':::question',
  'Keep the old Jenkins job as a fallback for a week?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

function thread(): InboxThread {
  const [region, jenkins] = parseInboxQuestionBlocks(BODY).map(
    (q): InboxQuestion => ({
      key: q.key, position: q.position, kind: q.kind, prompt: q.prompt, context: q.parsed.context, choices: q.parsed.choices, recommendation: null, suggested_text: null,
      stopped: null, holds_up: [], asked_by_agent_id: 'ses_a', orphaned: false, state: 'open', answer: null, revision: 0, sent_revision: 0,
      picked_by: null, picked_at: null, sent_reply_id: null, message_id: ASKED, superseded_by: null,
    }),
  );
  const answered: InboxQuestion = { ...jenkins!, state: 'answered_in_reply', answered_in_reply: { reply_id: REPLY, quote: QUOTE, message_id: GOT_IT, at: '2026-11-27T17:16:00.000Z' } };
  const base = { project_id: PROJECT.id, thread_id: ASKED, subject: null, resolved_at: null, idempotency_key: null };
  const messages: InboxMessageWire[] = [
    { ...base, id: ASKED, reply_to: null, author: AGENT, subject: region!.prompt, body: BODY, created_at: '2026-11-27T17:00:00.000Z', questions: [region!, answered] },
    { ...base, id: REPLY, reply_to: ASKED, author: { kind: 'person' }, body: `${QUOTE} Region I still need to think about.`, created_at: '2026-11-27T17:10:00.000Z' },
    { ...base, id: GOT_IT, reply_to: REPLY, author: AGENT, body: 'Got it. Jenkins stays as a fallback for a week.', created_at: '2026-11-27T17:16:00.000Z' },
  ];
  return { thread_id: ASKED, project: PROJECT, subject: region!.prompt, thread_name: null, resolved_at: null, messages };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let refuse: ((path: string) => Response | null) | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      return refuse?.(path) ?? Response.json({ questions: [] });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ home: null, project: PROJECT, sessions: [] });
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
  refuse = null;
});

const pane = (data: InboxThread, onChanged: () => Promise<void>) => (
  <div className="pn-inbox">
    <ThreadPane thread={data} sent={null} onQuestions={() => {}} onChanged={onChanged} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
  </div>
);

async function render(onChanged: () => Promise<void> = async () => {}, data: InboxThread = thread()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(data, onChanged));
  });
  await settle();
  return data;
}

function stillOpen(): InboxThread {
  const data = thread();
  const [asked, ...rest] = data.messages;
  const [region, jenkins] = asked!.questions!;
  const { answered_in_reply: _taken, ...open } = jenkins!;
  return { ...data, messages: [{ ...asked!, questions: [region!, { ...open, state: 'open' }] }, ...rest.slice(0, 1)] };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

test.skipIf(!hasDom)('a Reopen that fails says so on the card and can be pressed again', async () => {
  refuse = (path) => (path.endsWith('/reopen') ? Response.json({ code: 'internal', error: 'Internal error.' }, { status: 500 }) : null);
  const data = await render();
  const card = host!.querySelector(`[data-question-key="${data.messages[0]!.questions![1]!.key}"]`) as HTMLElement;
  const reopen = card.querySelector('[data-answered-reopen]') as HTMLButtonElement;
  await act(async () => {
    reopen.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
  expect(card.querySelector('[data-answered-reopen-failed]')?.textContent).toBe("Couldn't reopen it. Try again.");
  expect(reopen.disabled).toBe(false);
});

test.skipIf(!hasDom)('a Send refused because a question was taken from the reply reads the thread again and says so plainly', async () => {
  refuse = (path) => (path.endsWith('/reply') ? Response.json({ code: 'question_answered_in_reply', error: 'This question was marked answered from the reply. Reopen it on its card to answer it there.' }, { status: 409 }) : null);
  let reads = 0;
  const reread = async () => {
    reads += 1;
    act(() => root!.render(pane(thread(), reread)));
  };
  const before = await render(reread, stillOpen());
  const key = before.messages[0]!.questions![1]!.key;
  const card = () => host!.querySelector(`[data-question-key="${key}"]`) as HTMLElement;
  expect(card().querySelector('[data-answered-quote]')).toBeNull();
  const replyButton = [...host!.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === 'Reply')!;
  await act(async () => {
    replyButton.click();
  });
  await settle();
  const box = host!.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(box, 'Use us-east-1.');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = [...host!.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === 'Send')!;
  await act(async () => {
    send.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await settle();
  await settle();
  expect(host!.textContent).toContain(ANSWERED_IN_REPLY_LINE);
  expect(host!.textContent).not.toContain(key);
  expect(reads).toBeGreaterThan(0);
  expect(card().querySelector('[data-answered-quote]')?.textContent).toContain(QUOTE);
  expect((host!.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement).value).toBe('Use us-east-1.');
});

test.skipIf(!hasDom)('a question answered in the reply: the person\'s words as its answer, not counted open, and one Reopen', async () => {
  const data = thread();
  const jenkins = data.messages[0]!.questions![1]!;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={data} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const card = host.querySelector(`[data-message-id="${ASKED}"][data-question-key="${jenkins.key}"]`) as HTMLElement;
  expect(card.getAttribute('data-question-state')).toBe('answered_in_reply');
  expect(card.querySelector('[data-answered-quote]')?.textContent).toContain(`“${QUOTE}”`);
  expect(card.querySelector('[data-answered-by]')?.textContent).toContain('Claude Code took this from your reply');
  expect(card.querySelectorAll('input').length).toBe(0);
  expect(host.textContent).toContain('1 open question');
  expect(host.textContent).not.toContain('2 open questions');
  const reopen = card.querySelector('[data-answered-reopen]') as HTMLButtonElement;
  await act(async () => {
    reopen.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(posted.filter((p) => p.path.endsWith('/reopen')).map((p) => [p.path, p.body.key])).toEqual([[`/api/inbox/messages/${ASKED}/reopen`, jenkins.key]]);
});
