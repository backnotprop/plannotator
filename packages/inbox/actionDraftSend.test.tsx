/**
 * Send carries an action item's note as the person left it (approval
 * "inbox-action-items-in-reply"): a note typed under a Done waiting in the
 * draft is saved after a typing pause, so a Send pressed inside that pause
 * must save it first and wait for the save before it posts the reply.
 * Failures to catch: the reply posted before the note's save (the agent gets
 * the Done without the note), or the note never saved at all. And the reply
 * box's list of what goes with the reply ("Your 2 action items go with this
 * reply"): an item missing from it, or its note or reason; a sent list that
 * says "You did" for a Can't do it the agent then saw done.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { ReplyActions } = (hasDom ? await import('./components/ReplyAnswers') : {}) as typeof import('./components/ReplyAnswers');

const PROJECT: InboxProject = { id: 'prj_1', key: 'web-abcdef', name: 'web', root: '/work/web', created_at: '2026-10-26T10:00:00.000Z' };
const ASKED = 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YE';
const BODY = ['Release 4.2 is built.', '', ':::action', 'Approve the production deploy on Vercel', 'Stopped: release 4.2 waits on it', ':::'].join('\n');
const PARSED = parseInboxActionBlocks(BODY)[0]!;

function action(note: string | null): InboxQuestion {
  return {
    key: PARSED.key,
    position: 0,
    kind: 'action',
    prompt: PARSED.prompt,
    context: null,
    choices: [],
    recommendation: null,
    suggested_text: null,
    stopped: PARSED.stopped,
    holds_up: [],
    asked_by_agent_id: 'ses_a',
    orphaned: false,
    state: 'picked',
    answer: null,
    revision: 1,
    sent_revision: 0,
    picked_by: 'person',
    picked_at: '2026-10-26T15:12:00.000Z',
    sent_reply_id: null,
    message_id: ASKED,
    superseded_by: null,
    set_aside_at: null,
    action: PARSED.action,
    action_result: { outcome: 'done', note, at: '2026-10-26T15:12:00.000Z', by: 'person', staged: true },
  } as unknown as InboxQuestion;
}

function thread(): InboxThread {
  const asked = {
    id: ASKED,
    project_id: PROJECT.id,
    thread_id: ASKED,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', name: 'Claude Code', session: 'ses_a' },
    subject: 'Release 4.2',
    subject_question: null,
    body: BODY,
    created_at: '2026-10-26T15:10:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    actions: [action(null)],
  } as unknown as InboxMessageWire;
  return { thread_id: ASKED, project: PROJECT, subject: 'Release 4.2', thread_name: null, resolved_at: null, messages: [asked] };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** What was posted, in order, and when each answer was given. */
let events: string[] = [];
let releaseMark: () => void = () => {};

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  events = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST' && path.includes('/actions/')) {
      const body = JSON.parse(String(init.body)) as { note?: string };
      events.push(`mark posted: ${body.note ?? ''}`);
      // The save answers only when the test says so: a Send must wait for it.
      await new Promise<void>((resolve) => {
        releaseMark = resolve;
      });
      events.push('mark saved');
      return Response.json({ questions: [action(body.note ?? null)] });
    }
    if (init?.method === 'POST' && path.endsWith('/reply')) {
      events.push(`reply posted: ${JSON.stringify(JSON.parse(String(init.body)).actions)}`);
      return Response.json({ message_id: ASKED, questions: [], reply: { id: 'msg_reply' }, replayed: false });
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

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

test.skipIf(!hasDom)('a Send pressed inside the note\'s typing pause saves the note first, and posts the reply only once it is saved', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={thread()} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await settle();
  const note = host.querySelector<HTMLTextAreaElement>('[data-action-draft-note]')!;
  expect(note).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Promoted from the CLI.');
    note.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Inside the 600 ms pause: nothing saved yet.
  expect(events).toEqual([]);
  const send = [...host.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].find((b) => b.textContent?.trim() === 'Send')!;
  expect(send).toBeDefined();
  act(() => send.click());
  await settle();
  // The Send saved the note at once, and waits for that save.
  expect(events).toEqual(['mark posted: Promoted from the CLI.']);
  await act(async () => {
    releaseMark();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
  expect(events).toEqual(['mark posted: Promoted from the CLI.', 'mark saved', `reply posted: ${JSON.stringify([{ key: PARSED.key }])}`]);
});

test.skipIf(!hasDom)("the reply box lists what goes with the reply: each action item waiting in the draft, its Done and note or its reason", async () => {
  const body = [BODY, '', ':::action', 'Rotate the npm token', ':::'].join('\n');
  const second = parseInboxActionBlocks(body)[1]!;
  const t = thread();
  const asked = t.messages[0]! as InboxMessageWire & { actions: InboxQuestion[] };
  asked.body = body;
  asked.actions = [
    action('Promoted at 3:12.'),
    { ...action(null), key: second.key, position: 1, prompt: second.prompt, stopped: null, action_result: { outcome: 'cant', note: 'No access to the npm org.', at: '2026-10-26T15:13:00.000Z', by: 'person', staged: true } } as unknown as InboxQuestion,
  ];
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={t} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await settle();
  // The box is closed: no list yet (the foot counts them).
  expect(host.querySelector('[data-reply-actions="draft"]')).toBeNull();
  act(() => host!.querySelector<HTMLButtonElement>('[data-reply-button]')!.click());
  await settle();
  const list = host.querySelector<HTMLElement>('[data-reply-actions="draft"]')!;
  expect(list).not.toBeNull();
  expect(list.querySelector('.ib-ranswers-h')!.textContent).toBe('Your 2 action items go with this reply');
  const rows = [...list.querySelectorAll('.ib-ranswer')].map((r) => r.getAttribute('aria-label'));
  expect(rows).toEqual([
    'A1, Approve the production deploy on Vercel: Done · Note: Promoted at 3:12.. Show the action item.',
    "A2, Rotate the npm token: Can't do it: No access to the npm org.. Show the action item.",
  ]);
});

test.skipIf(!hasDom)("a sent reply's list counts a Can't do it the agent then saw done by the person's mark: \"You couldn't do\", never \"You did\"", () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  const row = { id: `${ASKED}/${PARSED.key}`, messageId: ASKED, number: 1, prompt: PARSED.prompt, outcome: 'cant' as const, note: 'No access.', seen: true };
  act(() => {
    root = createRoot(host!);
    root.render(<ReplyActions actions={[row]} sent />);
  });
  const sent = host.querySelector<HTMLElement>('[data-reply-actions="sent"]')!;
  expect(sent.querySelector('.ib-ranswers-h')!.textContent).toBe("You couldn't do 1 action item");
  expect(sent.querySelector('.ib-ranswer-a')!.textContent).toBe('Seen done · Your reason: No access.');
  act(() => root!.render(<ReplyActions actions={[row, { ...row, id: 'x', number: 2, outcome: 'done', note: null, seen: false }]} sent />));
  expect(sent.querySelector('.ib-ranswers-h')!.textContent).toBe("You did 1 action item, couldn't do 1");
});
