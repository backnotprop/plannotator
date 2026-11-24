/**
 * Decision mode in a thread (approval "inbox-decision-mode-one-send", 2026-11-24): the thread's own messages one at
 * a time, its own cards and draft, ONE Send at the end. What regresses if these fail: decision mode sends on its own
 * (a pick, Next, Later, an action item's Done or leaving posts a reply), leaving loses the person's place or their
 * answers, Later does not move a message to the end, the Send is not the thread's own (not one reply per agent
 * session, or without the person's words), or the switch off still offers the way in.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'harbor-abcdef', name: 'harbor', root: '/work/harbor', created_at: '2026-11-24T09:00:00.000Z' };
const CLAUDE: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const CODEX: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'codex', session: 'ses_b', name: null };
const block = (prompt: string, extra: string[] = []) => [':::question', prompt, ...extra, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
const ACTION_BODY = [':::action', 'Approve the staging deploy on Vercel', ':::'].join('\n');

/** Each test its own thread: a sitting is kept per thread for the window's life. */
let threadSeq = 0;
let T = '';
const mid = (n: number) => `${T}_m${n}`;

function questionsOf(messageId: string, author: Extract<InboxAuthor, { kind: 'agent' }>, body: string): InboxQuestion[] {
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
    asked_by_agent_id: author.session,
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
  })) as InboxQuestion[];
}

function actionOf(messageId: string, body: string): InboxQuestion {
  const parsed = parseInboxActionBlocks(body)[0]!;
  return {
    key: parsed.key,
    position: 0,
    kind: 'action',
    prompt: parsed.prompt,
    context: null,
    choices: [],
    recommendation: null,
    suggested_text: null,
    stopped: parsed.stopped,
    holds_up: [],
    asked_by_agent_id: 'ses_a',
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
    action: parsed.action,
    action_result: null,
  } as unknown as InboxQuestion;
}

function agent(n: number, author: Extract<InboxAuthor, { kind: 'agent' }>, body: string, withAction = false): InboxMessageWire {
  const id = mid(n);
  return {
    id,
    project_id: PROJECT.id,
    thread_id: mid(1),
    reply_to: n === 1 ? null : mid(1),
    author,
    subject: n === 1 ? 'Checkout redesign' : null,
    body,
    created_at: `2026-11-24T${String(10 + n).padStart(2, '0')}:15:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    seq: n,
    questions: questionsOf(id, author, body),
    ...(withAction ? { actions: [actionOf(id, body)] } : {}),
  } as InboxMessageWire;
}

/**
 * Claude Code asks two (thread order first), Codex asks one that stops it (so it comes first), and Claude Code's last
 * message asks one and holds an action item.
 */
const sample = () => [
  agent(1, CLAUDE, `Two calls before I wire payments:\n\n${block('Which payment provider goes in first?')}\n\n${block('Keep guest checkout?')}`),
  agent(2, CODEX, `From the promo work.\n\n${block('Change the Pay button words?', ['Stopped: the promo PR'])}`),
  agent(3, CLAUDE, `Last two things.\n\n${ACTION_BODY}\n\n${block('Ship the receipt email?')}`, true),
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let served: InboxMessageWire[] = [];
/** Every write the window made, in order: "picks <message>", "action <message> staged", "reply <message> <words>". */
let writes: string[] = [];

function serve() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const picks = path.match(/\/messages\/([^/]+)\/picks$/);
    if (picks && init?.method === 'POST') {
      const messageId = decodeURIComponent(picks[1]!);
      writes.push(`picks ${messageId}`);
      const entry = (body.questions as { key: string; answer: QuestionAnswer | null }[])[0]!;
      served = served.map((m) =>
        m.id !== messageId
          ? m
          : { ...m, questions: m.questions!.map((q) => (q.key !== entry.key ? q : { ...q, answer: entry.answer, state: entry.answer ? ('picked' as const) : ('open' as const), revision: q.revision + 1, picked_at: '2026-11-24T15:00:00.000Z' })) },
      );
      return Response.json({ questions: served.find((m) => m.id === messageId)!.questions });
    }
    const mark = path.match(/\/messages\/([^/]+)\/actions\/([^/]+)$/);
    if (mark && init?.method === 'POST') {
      const messageId = decodeURIComponent(mark[1]!);
      writes.push(`action ${messageId}${body.staged ? ' staged' : ''}`);
      const marked = served
        .find((m) => m.id === messageId)!
        .actions!.map((a) => ({ ...a, state: 'picked' as const, revision: a.revision + 1, action_result: { outcome: 'done', note: null, at: '2026-11-24T15:01:00.000Z', by: 'person', staged: body.staged === true } }));
      served = served.map((m) => (m.id === messageId ? { ...m, actions: marked as unknown as InboxQuestion[] } : m));
      return Response.json({ questions: marked });
    }
    const reply = path.match(/\/messages\/([^/]+)\/reply$/);
    if (reply && init?.method === 'POST') {
      writes.push(`reply ${decodeURIComponent(reply[1]!)} ${String(body.words ?? '')}`.trim());
      return Response.json({ message_id: decodeURIComponent(reply[1]!), questions: [], reply: { id: `${T}_r${writes.length}` }, replayed: false });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
}

beforeEach(() => {
  if (!hasDom) return;
  threadSeq += 1;
  T = `msg_dm${threadSeq}`;
  savedFetch = globalThis.fetch;
  writes = [];
  serve();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('[data-open-questions-list]').forEach((n) => n.closest('.ib-oq-pos')?.remove());
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

function Live({ decisionMode }: { decisionMode: boolean }) {
  const [messages, setMessages] = React.useState(served);
  const thread: InboxThread = { thread_id: mid(1), project: PROJECT, subject: 'Checkout redesign', thread_name: null, resolved_at: null, messages };
  return (
    <ThreadPane
      thread={thread}
      sent={null}
      decisionMode={decisionMode}
      onQuestions={(messageId, questions) =>
        setMessages((current) =>
          current.map((m) => {
            if (m.id !== messageId) return m;
            const asked = questions.filter((q) => q.kind !== 'action');
            const acts = questions.filter((q) => q.kind === 'action');
            return { ...m, ...(asked.length > 0 ? { questions: asked } : {}), ...(acts.length > 0 ? { actions: acts } : {}) };
          }),
        )
      }
      onChanged={async () => {}}
      onClose={() => {}}
      file={null}
      onOpenFile={() => {}}
      onOpenGuide={() => {}}
    />
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function render(decisionMode = true) {
  served = sample();
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Live decisionMode={decisionMode} />);
  });
  await settle();
}

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
  });
  await settle();
}

const $ = <E extends Element = HTMLElement>(selector: string) => host!.querySelector<E>(selector);
const wayIn = () => document.querySelector<HTMLElement>('[data-thread-decide]');
async function openList() {
  await press($('[data-open-questions]')!);
  await until(() => !!document.querySelector('[data-open-questions-list]'), 'the open questions');
}
/** The messages on screen, by id. */
const shown = () => [...host!.querySelectorAll<HTMLElement>('.ib-pbody > [data-message-article]')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.getAttribute('data-message-article'));
/** The steps, by message id ("send" last). */
const steps = () => [...host!.querySelectorAll<HTMLElement>('[data-decide-step]')].map((n) => n.getAttribute('data-decide-step'));
const current = () => host!.querySelector('[data-decide-step][aria-current]')?.getAttribute('data-decide-step');
async function pickFirst(messageId: string) {
  const radios = host!.querySelectorAll<HTMLInputElement>(`[data-message-article="${messageId}"] input[type="radio"]`);
  for (const card of new Set([...radios].map((r) => r.name))) {
    const first = [...radios].find((r) => r.name === card)!;
    await act(async () => first.click());
  }
  await settle();
}
async function decide() {
  await openList();
  await press(wayIn()!);
  await until(() => !!$('[data-decide-head]'), 'decision mode');
}

test.skipIf(!hasDom)('the way in is the open questions\' first row; one message shows at a time, Stopped first, then thread order', async () => {
  await render();
  await openList();
  // Four questions and one action item wait.
  expect(wayIn()!.textContent).toBe('Decide 5 one at a time');
  await press(wayIn()!);
  await until(() => !!$('[data-decide-head]'), 'decision mode');
  expect(steps()).toEqual([mid(2), mid(1), mid(3), 'send']);
  expect(current()).toBe(mid(2));
  expect(shown()).toEqual([mid(2)]);
  // The thread's own head and foot are put away while it shows.
  expect(host!.querySelector<HTMLElement>('.ib-phead:not(.dm-head)')!.hidden).toBe(true);
  expect(host!.querySelector<HTMLElement>('.ib-pfoot:not(.dm-foot)')!.hidden).toBe(true);
  await press($('[data-decide-next]')!);
  expect(shown()).toEqual([mid(1)]);
  expect(host!.querySelectorAll(`[data-message-article="${mid(1)}"] [data-question-key]`).length).toBe(2);
});

test.skipIf(!hasDom)('Later moves the message to the end, before Send; nothing is sent by picks, Next, Later or an action item\'s Done', async () => {
  await render();
  await decide();
  await pickFirst(mid(2));
  await until(() => writes.includes(`picks ${mid(2)}`), 'the pick saved');
  // The answer is the thread's draft; the step fills.
  expect($(`[data-decide-step="${mid(2)}"]`)!.getAttribute('data-state')).toBe('done');
  await press($('[data-decide-next]')!);
  expect(current()).toBe(mid(1));
  await press($('[data-decide-later]')!);
  expect(steps()).toEqual([mid(2), mid(3), mid(1), 'send']);
  expect(current()).toBe(mid(3));
  expect($(`[data-decide-step="${mid(1)}"]`)!.textContent).toContain('later');
  // The action item's Done waits in the draft like an answer.
  await press($(`[data-message-article="${mid(3)}"] [data-action-done]`)!);
  await until(() => writes.some((w) => w.startsWith(`action ${mid(3)}`)), 'the mark saved');
  expect(writes).toContain(`action ${mid(3)} staged`);
  await press($('[data-decide-next]')!);
  expect(current()).toBe(mid(1));
  expect($('.dm-note')?.textContent).toBe('You put this one off. It is the last before Send.');
  // No Later on the last message before Send.
  expect($('[data-decide-later]')).toBeNull();
  await settle();
  expect(writes.filter((w) => w.startsWith('reply'))).toEqual([]);
});

test.skipIf(!hasDom)('leaving sends nothing and keeps the answers; the way in reads Resume and opens where the person stopped', async () => {
  await render();
  await decide();
  await pickFirst(mid(2));
  await press($('[data-decide-next]')!);
  await pickFirst(mid(1));
  await until(() => writes.filter((w) => w === `picks ${mid(1)}`).length === 2, 'both picks saved');
  await press($('[data-decide-leave]')!);
  expect($('[data-decide-head]')).toBeNull();
  // The whole thread again, the answers in its draft.
  expect(shown().length).toBe(3);
  expect(host!.querySelectorAll('input[type="radio"]:checked').length).toBe(3);
  await openList();
  // Two of three messages are answered; one (Claude Code's last) is left.
  expect(wayIn()!.textContent).toBe('Resume · 1 of 3 messages left');
  await press(wayIn()!);
  await until(() => !!$('[data-decide-head]'), 'decision mode again');
  expect(current()).toBe(mid(1));
  // Away another way (Escape, the list, another thread): the pane goes, and coming back still offers Resume, there.
  act(() => root!.unmount());
  act(() => {
    root = createRoot(host!);
    root.render(<Live decisionMode />);
  });
  await settle();
  expect($('[data-decide-head]')).toBeNull();
  await openList();
  expect(wayIn()!.textContent).toBe('Resume · 1 of 3 messages left');
  await press(wayIn()!);
  await until(() => !!$('[data-decide-head]'), 'decision mode once more');
  expect(current()).toBe(mid(1));
  expect(writes.filter((w) => w.startsWith('reply'))).toEqual([]);
});

test.skipIf(!hasDom)('Send is the thread\'s own: one reply per agent session, the person\'s words with it, only when pressed', async () => {
  await render();
  await decide();
  await pickFirst(mid(2));
  await press($('[data-decide-next]')!);
  await pickFirst(mid(1));
  await press($('[data-decide-next]')!);
  await pickFirst(mid(3));
  await until(() => writes.filter((w) => w.startsWith('picks')).length === 4, 'four picks saved');
  await press($('[data-decide-next]')!);
  expect(current()).toBe('send');
  // Every answer listed as the reply box lists them; a row opens its message, and Back to Send returns.
  expect(host!.querySelectorAll('[data-decide-send] [data-reply-answer]').length).toBe(4);
  await press(host!.querySelector(`[data-decide-send] [data-reply-answer^="${mid(1)}/"]`)!);
  expect(current()).toBe(mid(1));
  await press($('[data-decide-back-to-send]')!);
  expect(current()).toBe('send');
  const words = $<HTMLTextAreaElement>('[data-decide-words]')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(words, 'Go ahead. Ping me when the PR is up.');
    words.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(writes.filter((w) => w.startsWith('reply'))).toEqual([]);
  await press($('[data-decide-send-button]')!);
  await until(() => writes.filter((w) => w.startsWith('reply')).length === 2, 'the replies');
  const replies = writes.filter((w) => w.startsWith('reply'));
  // Codex's session, then Claude Code's (the latest writer), which carries the words.
  expect(replies).toEqual([`reply ${mid(2)}`, `reply ${mid(3)} Go ahead. Ping me when the PR is up.`]);
  expect($('[data-decide-head]')).toBeNull();
});

test.skipIf(!hasDom)('with the switch off there is no way in', async () => {
  await render(false);
  await openList();
  expect(wayIn()).toBeNull();
});
