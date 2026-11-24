/**
 * Decision mode in a thread (approval "inbox-decision-mode-one-send", 2026-11-24): the thread's own messages one at
 * a time, its own cards and draft, ONE Send at the end. What regresses if these fail: decision mode sends on its own
 * (a pick, Next, Later, an action item's Done or leaving posts a reply), leaving loses the person's place or their
 * answers, Later does not move a message to the end, the Send is not the thread's own (not one reply per agent
 * session, or without the person's words), or the switch off still offers the way in. Also: the Send step's words box
 * saving over a draft the reply box kept (its words or files), a Send that did not go ending the sitting, the thread
 * not given back where it was scrolled, Escape closing the whole thread, another thread and back reopening decision
 * mode by itself, and "Resume · 0 of N left" when everything is answered.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';
import type { InboxAttachmentState, InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { threadDeciding } from './shortcuts/guards';
import { threadWhole, useDecidingWhole } from './decisions/wholeWindow';

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
/** The thread's reply draft as the Inbox holds it, and every save of it the window posted. */
let draft: InboxReplyDraft | null = null;
let draftSaves: Record<string, unknown>[] = [];
/** The Inbox refuses every reply (a Send that does not go). */
let replyFails = false;
/** The Inbox refuses every reply because a question it answers was replaced (the Send stops on the thread's guard). */
let replyReplaced = false;
/** The files the thread's messages attached (none unless a test attaches one). */
let files: InboxAttachmentState[] = [];
/** A picture the first message attached, as a person opens it from the message. */
const picture = (): InboxAttachmentState =>
  ({
    id: 'att_picture',
    name: 'drawer-b.png',
    path: '/work/harbor/design/drawer-b.png',
    kind: 'image',
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 100,
    sent_at: '2026-11-24T10:15:00.000Z',
    sent_mtime: '2026-11-24T10:15:00.000Z',
    message_id: mid(1),
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 100, mtime: '2026-11-24T10:15:00.000Z' },
  }) as InboxAttachmentState;
const UPLOAD = { upload_id: 'upl_notes', name: 'notes.txt', size: 12, kind: 'text', sha256: 'a'.repeat(64), created_at: '2026-11-24T09:00:00.000Z' } as const;

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
    if (reply && init?.method === 'POST' && replyFails) return Response.json({ error: 'The Inbox could not write the reply.', code: 'write_failed' }, { status: 500 });
    if (reply && init?.method === 'POST' && replyReplaced) return Response.json({ error: 'A question you answered was replaced.', code: 'question_superseded' }, { status: 409 });
    if (/\/threads\/[^/]+\/draft$/.test(path)) {
      if (init?.method === 'POST') {
        draftSaves.push(body);
        draft = { v: 1, thread_id: mid(1), body: String(body.body ?? ''), created_at: '2026-11-24T09:30:00.000Z', updated_at: `2026-11-24T09:31:${String(draftSaves.length).padStart(2, '0')}.000Z`, files: draft?.files ?? [] };
      }
      return Response.json({ draft });
    }
    if (reply && init?.method === 'POST') {
      writes.push(`reply ${decodeURIComponent(reply[1]!)} ${String(body.words ?? '')}`.trim());
      return Response.json({ message_id: decodeURIComponent(reply[1]!), questions: [], reply: { id: `${T}_r${writes.length}` }, replayed: false });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: files, annotations: [] });
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
  draft = null;
  draftSaves = [];
  replyFails = false;
  replyReplaced = false;
  files = [];
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

/** The pane moves to another thread ('b', one message of its own) and back ('a'), as a list press or J does. */
let showThread: ((which: 'a' | 'b') => void) | null = null;
function otherThread(): InboxThread {
  const message = { ...agent(9, CLAUDE, `Elsewhere.\n\n${block('Rename the repo?')}`), thread_id: mid(9), reply_to: null, subject: 'Elsewhere' } as InboxMessageWire;
  return { thread_id: mid(9), project: PROJECT, subject: 'Elsewhere', thread_name: null, resolved_at: null, messages: [message] };
}

/** A file or picture opened beside the thread (the route's `file`), as a press on a message's picture does. */
let openFile: ((file: React.ComponentProps<typeof ThreadPane>['file']) => void) | null = null;
function Live({ decisionMode, threadAlone = false }: { decisionMode: boolean; threadAlone?: boolean }) {
  const [messages, setMessages] = React.useState(served);
  const [which, setWhich] = React.useState<'a' | 'b'>('a');
  const [file, setFile] = React.useState<React.ComponentProps<typeof ThreadPane>['file']>(null);
  showThread = setWhich;
  openFile = setFile;
  const other = React.useMemo(otherThread, []);
  const thread: InboxThread = which === 'b' ? other : { thread_id: mid(1), project: PROJECT, subject: 'Checkout redesign', thread_name: null, resolved_at: null, messages };
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
      // A read of the thread again: what the stub Inbox holds now (an action item's mark lands this way).
      onChanged={async () => setMessages(served)}
      onClose={() => {}}
      threadAlone={threadAlone}
      file={file}
      onOpenFile={(next) => setFile(next)}
      onOpenGuide={() => {}}
    />
  );
}

/**
 * The window around the pane, as App draws it: the thread takes the whole window (App.tsx `full`, `threadWhole`) when
 * the person put it in full screen or decision mode shows in it; then the sidebar and the list hide and the pane is
 * told it is alone (`threadAlone`, its `data-full`). `full`: the person's own full screen; `phone`: a phone's window.
 */
let windowWas = { full: false, phone: false };
function Window() {
  const deciding = useDecidingWhole(mid(1));
  const full = threadWhole({ threadFull: windowWas.full, deciding, thread: true, phone: windowWas.phone, fromCard: false, stacked: false });
  return (
    <div data-window="" data-thread-full={full ? '' : undefined}>
      <nav data-window-sidebar="" hidden={full} />
      <div data-window-list="" hidden={full} />
      <Live decisionMode threadAlone={full} />
    </div>
  );
}

async function renderWindow(was: typeof windowWas) {
  windowWas = was;
  served = sample();
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Window />);
  });
  await settle();
}

/** What the window shows around the thread: its sidebar, its list, whether the pane has the whole window, which thread. */
const layout = () => ({
  sidebar: !$('[data-window-sidebar]')!.hidden,
  list: !$('[data-window-list]')!.hidden,
  whole: $('section.ib-pane')!.hasAttribute('data-full'),
  thread: $('section.ib-pane')!.getAttribute('data-thread-id'),
});

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

async function render(decisionMode = true, messages: () => InboxMessageWire[] = sample) {
  served = messages();
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

/** Words typed in a textarea, as a key does. */
async function typeInto(field: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
async function answerAll() {
  for (const id of [mid(2), mid(1), mid(3)]) {
    await pickFirst(id);
    const done = $(`[data-message-article="${id}"] [data-action-done]`);
    if (done) await press(done);
    await press($('[data-decide-next]')!);
  }
  await until(() => writes.filter((w) => w.startsWith('picks')).length === 4 && writes.some((w) => w.startsWith('action')), 'every answer saved');
}

test.skipIf(!hasDom)('the Send step shows the draft the reply box kept when it closed, and a change there keeps its words and files', async () => {
  draft = { v: 1, thread_id: mid(1), body: 'Kept words from before.', created_at: '2026-11-24T09:30:00.000Z', updated_at: '2026-11-24T09:30:00.000Z', files: [UPLOAD] };
  await render();
  // The draft came back in the box; Cancel (the box's ×) closes it and keeps the draft, words and file.
  await until(() => !!$('[data-reply-close]'), 'the draft back in the box');
  await press($('[data-reply-close]')!);
  await until(() => !$('[data-reply-close]'), 'the box closed');
  await decide();
  await press($('[data-decide-step="send"]')!);
  expect(current()).toBe('send');
  const words = () => $<HTMLTextAreaElement>('[data-decide-words]')!;
  // The words the Send would carry are the words it shows.
  await until(() => words().value === 'Kept words from before.', 'the kept words on the Send step');
  const before = draftSaves.length;
  await typeInto(words(), 'Kept words from before. And these.');
  await wait(700);
  await until(() => draftSaves.length > before, 'the draft saved');
  const saved = draftSaves.at(-1)!;
  expect(saved.body).toBe('Kept words from before. And these.');
  // The kept file stays in the draft.
  expect((saved.files_remove as string[] | undefined) ?? []).not.toContain(UPLOAD.upload_id);
  // The Send carries it, so the step lists it under the words, with the reply box's own tile, and it can go there.
  const tile = () => $(`[data-decide-send] [data-decide-files] [data-compose-file-name="${UPLOAD.name}"]`);
  expect(tile()).not.toBeNull();
  await press(tile()!.querySelector('.ib-cp-fx')!);
  await until(() => tile() === null, 'the file taken off the Send step');
  expect(writes.filter((w) => w.startsWith('reply'))).toEqual([]);
});

/** Escape pressed where focus is (the page itself when nothing has it), as a key does: whether the key was used. */
async function escapeFrom(el: Element) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => void el.dispatchEvent(event));
  await settle();
  return event.defaultPrevented;
}

test.skipIf(!hasDom)('Escape with a file or picture open beside the thread is the file\'s: decision mode stays', async () => {
  await render();
  await decide();
  act(() => openFile!({ id: 'att_picture', version: 'current', focus: null }));
  await settle();
  // Not used here, so the file viewer's own Escape (the window's last, which skips a used key) closes the picture.
  const used = await escapeFrom($('[data-decide-head]')!);
  expect({ used, deciding: !!$('[data-decide-head]') }).toEqual({ used: false, deciding: true });
  // Closed: the next Escape puts decision mode away again.
  act(() => openFile!(null));
  await settle();
  expect(await escapeFrom($('[data-decide-head]')!)).toBe(true);
  expect($('[data-decide-head]')).toBeNull();
});

test.skipIf(!hasDom)('Escape with the prototype window open and focus on the page closes the window, not decision mode', async () => {
  await render();
  await decide();
  // The window opens over decision mode (its key listener after decision mode's, as when a card's Try opens it).
  const { PrototypeWindow } = await import('./components/PrototypeWindow');
  const layer = document.createElement('div');
  document.body.appendChild(layer);
  const windowRoot = createRoot(layer);
  let closed = 0;
  act(() =>
    windowRoot.render(
      <PrototypeWindow
        threadId={mid(1)}
        options={[{ label: 'A', letter: 'A', lettered: false, recommended: false, page: null }]}
        start={0}
        shared={false}
        picked={[]}
        readOnly={false}
        records={[]}
        attachments={[]}
        onSaved={() => {}}
        onPick={() => {}}
        onClose={() => (closed += 1)}
      />,
    ),
  );
  (document.activeElement as HTMLElement | null)?.blur();
  await escapeFrom(document.body);
  const after = { closed, deciding: !!$('[data-decide-head]') };
  act(() => windowRoot.unmount());
  layer.remove();
  expect(after).toEqual({ closed: 1, deciding: true });
});

test.skipIf(!hasDom)('a Send the thread stops puts decision mode away each time, the stop already showing included (Resume, Send again)', async () => {
  await render();
  await decide();
  await answerAll();
  expect(current()).toBe('send');
  replyReplaced = true;
  for (const press_ of [1, 2]) {
    await press($('[data-decide-send-button]')!);
    await until(() => !$('[data-decide-head]'), `decision mode put away after Send ${press_}`);
    // The sitting is kept: Resume opens it where it was, on the Send step.
    await openList();
    expect(wayIn()!.textContent).toBe('Resume · all answered, not sent yet');
    await press(wayIn()!);
    await until(() => !!$('[data-decide-head]'), 'decision mode again');
    expect(current()).toBe('send');
  }
  expect(writes.filter((w) => w.startsWith('reply'))).toEqual([]);
});

test.skipIf(!hasDom)('the way in counts what it opens: three questions and a permission prompt read "Decide these 3"', async () => {
  const PERMISSION: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'perm:ses_a', name: null };
  await render(true, () => [...sample().slice(0, 2), agent(4, PERMISSION, `Allow a command?\n\n${block('Run bun install?')}`)]);
  await openList();
  expect(wayIn()!.textContent).toBe('Decide these 3');
});

test.skipIf(!hasDom)('a Send that did not go keeps the sitting: it stays on the Send step with the thread\'s error', async () => {
  await render();
  await decide();
  await answerAll();
  expect(current()).toBe('send');
  replyFails = true;
  await press($('[data-decide-send-button]')!);
  await until(() => !!$('[data-decide-foot] .ib-error'), 'the error shown');
  expect($('[data-decide-head]')).not.toBeNull();
  expect(current()).toBe('send');
  // Leaving now still offers Resume: the sitting was kept.
  await press($('[data-decide-leave]')!);
  await openList();
  expect(wayIn()!.textContent).toBe('Resume · all answered, not sent yet');
});

test.skipIf(!hasDom)('every message answered and nothing sent: the way in says so, and opens on the Send step', async () => {
  await render();
  await decide();
  await answerAll();
  await press($('[data-decide-step]')!);
  expect(current()).toBe(mid(2));
  await press($('[data-decide-leave]')!);
  await openList();
  expect(wayIn()!.textContent).toBe('Resume · all answered, not sent yet');
  await press(wayIn()!);
  await until(() => !!$('[data-decide-head]'), 'decision mode again');
  expect(current()).toBe('send');
});

test.skipIf(!hasDom)('leaving gives the thread back where it was scrolled', async () => {
  await render();
  const body = $('.ib-pbody')!;
  body.scrollTop = 140;
  expect(body.scrollTop).toBe(140);
  await decide();
  expect(body.scrollTop).toBe(0);
  await press($('[data-decide-next]')!);
  await press($('[data-decide-leave]')!);
  expect($('[data-decide-head]')).toBeNull();
  expect(body.scrollTop).toBe(140);
});

test.skipIf(!hasDom)('Escape puts decision mode away, back to the thread, and the window\'s Escape sees it used; the next one is the window\'s', async () => {
  await render();
  await decide();
  const seen: boolean[] = [];
  const windowEscape = (event: KeyboardEvent) => event.key === 'Escape' && seen.push(event.defaultPrevented);
  window.addEventListener('keydown', windowEscape);
  // Escape in a field (the Send step's words) is the field's.
  await press($('[data-decide-step="send"]')!);
  await act(async () => void $('[data-decide-words]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const afterField = !!$('[data-decide-head]');
  await act(async () => void $('[data-decide-send-heading]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle();
  const afterEscape = !!$('[data-decide-head]');
  const used = seen.at(-1);
  // Back in the thread: the next Escape is not decision mode's (the window closes the thread then).
  await act(async () => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  const next = seen.at(-1);
  window.removeEventListener('keydown', windowEscape);
  expect({ afterField, afterEscape, used, next }).toEqual({ afterField: true, afterEscape: false, used: true, next: false });
  expect(writes.filter((w) => w.startsWith('reply'))).toEqual([]);
});

test.skipIf(!hasDom)('the window\'s thread keys know when decision mode shows in a thread (threadDeciding)', async () => {
  await render();
  expect(threadDeciding(mid(1))).toBe(false);
  await decide();
  expect(threadDeciding(mid(1))).toBe(true);
  expect(threadDeciding(mid(9))).toBe(false);
  await press($('[data-decide-leave]')!);
  expect(threadDeciding(mid(1))).toBe(false);
});

test.skipIf(!hasDom)('another thread in the pane and back: the thread shows with its Resume row, not decision mode by itself', async () => {
  await render();
  await decide();
  await pickFirst(mid(2));
  act(() => showThread!('b'));
  await settle();
  expect($('[data-decide-head]')).toBeNull();
  act(() => showThread!('a'));
  await settle();
  expect($('[data-decide-head]')).toBeNull();
  expect(shown().length).toBe(3);
  await openList();
  expect(wayIn()!.textContent).toMatch(/^Resume · /);
});

test.skipIf(!hasDom)('decision mode takes the whole window: the sidebar and the list hide while it shows, and leaving gives the layout back as it was', async () => {
  await renderWindow({ full: false, phone: false });
  const before = layout();
  expect(before).toEqual({ sidebar: true, list: true, whole: false, thread: mid(1) });
  await decide();
  expect(layout()).toEqual({ sidebar: false, list: false, whole: true, thread: mid(1) });
  // The frame spans the window: its bar and steps lead the pane, its foot ends it, and the message is drawn in the
  // pane's own body (the thread's reading column, centred by the window's stylesheet).
  const section = $('section.ib-pane')!;
  expect(['[data-decide-head]', '[data-decide-steps]', '[data-decide-foot]'].map((s) => section.querySelector(`:scope > ${s}`) !== null)).toEqual([true, true, true]);
  expect(section.querySelector('.ib-pbody[data-deciding]')).not.toBeNull();
  await press($('[data-decide-next]')!);
  await press($('[data-decide-leave]')!);
  expect($('[data-decide-head]')).toBeNull();
  expect(layout()).toEqual(before);
  // Escape leaves too, with the same layout back.
  await openList();
  await press(wayIn()!);
  await until(() => !!$('[data-decide-head]'), 'decision mode again');
  expect(layout().whole).toBe(true);
  await act(async () => void $('[data-decide-head]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle();
  expect(layout()).toEqual(before);
});

test.skipIf(!hasDom)('the person\'s own full screen stays on after decision mode, and a phone, already whole, is left as it is', async () => {
  await renderWindow({ full: true, phone: false });
  const before = layout();
  expect(before).toEqual({ sidebar: false, list: false, whole: true, thread: mid(1) });
  await decide();
  expect(layout()).toEqual(before);
  await press($('[data-decide-leave]')!);
  expect(layout()).toEqual(before);
  act(() => root!.unmount());
  host!.remove();
  await renderWindow({ full: false, phone: true });
  const phone = layout();
  await decide();
  expect(layout()).toEqual(phone);
});

test.skipIf(!hasDom)('a file opened from a message while deciding shows beside the frame, and closing it returns to the frame across the window', async () => {
  files = [picture()];
  await renderWindow({ full: false, phone: false });
  await decide();
  await press($('[data-decide-next]')!);
  const step = current();
  act(() => openFile!({ id: 'att_picture', version: 'current', focus: null }));
  await settle();
  // Beside the file the pane narrows as a thread's does, still deciding, and the window stays the thread's.
  const section = $('section.ib-pane')!;
  expect({ beside: section.classList.contains('ib-withfile'), deciding: !!$('[data-decide-head]'), sidebar: layout().sidebar, list: layout().list }).toEqual({ beside: true, deciding: true, sidebar: false, list: false });
  act(() => openFile!(null));
  await settle();
  expect({ beside: section.classList.contains('ib-withfile'), deciding: !!$('[data-decide-head]'), step: current(), ...layout() }).toEqual({ beside: false, deciding: true, step, sidebar: false, list: false, whole: true, thread: mid(1) });
});
