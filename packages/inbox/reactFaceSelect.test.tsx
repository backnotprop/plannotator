/**
 * Selecting a message's words with the mouse past its reaction face (approval "inbox-reactions-every-message"), on
 * the real ThreadPane. The face sits over the end of the text's first line; a drag there must select the words as it
 * does with no face (the comment toolbar follows the release), so:
 * - a press on the words and its drag are never prevented, and the face the drag reaches opens nothing (it lets the
 *   pointer through: a release over it lands on the words); let go over it, it stays shut until the pointer leaves;
 * - a press on the face that drags selects the words from the press to the pointer; one that does not move is its click;
 * - text gestures win over the face: a double-click on a word under it (whose second press lands on the emoji its first
 *   click opened) selects the word and sends nothing, a question waiting or not; a Shift-click extends the selection;
 *   a reaction is only a deliberate single press on an emoji of a face already open;
 * - the stylesheet leaves the words' user-select alone and the face's slot takes no pointer.
 * DOM (happy-dom): `DOM_TESTS=1 bun test packages/inbox/reactFaceSelect.test.tsx --isolate`.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxReaction, InboxThread } from '@plannotator/core/inbox-types';
import { resetSavedReactionsForTests } from './reactions';
import { FACE_OPEN_MS, STRIP_SETTLE_MS, faceHover } from './thread/messageReact';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'fern-api-abcdef', name: 'fern-api', root: '/work/fern-api', created_at: '2026-11-24T09:00:00.000Z' };
const CLAUDE: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const [M1, M2, M3] = ['msg_01M8B00000000000000000001', 'msg_01M8B00000000000000000002', 'msg_01M8B00000000000000000003'] as const;
const WORDS = 'The ledger export is ready for the March close.';

const message = (id: string, author: InboxAuthor, body: string, minute: number): InboxMessageWire =>
  ({ id, thread_id: M1, project_id: PROJECT.id, reply_to: id === M1 ? null : M1, author, subject: id === M1 ? 'Ledger export' : null, body, created_at: `2026-11-24T14:${String(minute).padStart(2, '0')}:00.000Z`, resolved_at: null, idempotency_key: null, seq: minute }) as InboxMessageWire;

const THREAD: InboxThread = {
  thread_id: M1,
  project: PROJECT,
  subject: 'Ledger export',
  thread_name: 'ledger',
  resolved_at: null,
  messages: [message(M1, CLAUDE, 'Starting the export.', 1), message(M2, { kind: 'person' }, 'Go.', 2), message(M3, CLAUDE, WORDS, 3)],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const restores: (() => void)[] = [];
let acks: { id: string; on: boolean; reaction: InboxReaction | null | undefined }[] = [];
let posts: string[] = [];

const M4 = 'msg_01M8B00000000000000000004';
const ASK = 'Which retry cap?\n\n:::question\nKeep the cap at 3?\n\n- [ ] Yes\n- [ ] No\n:::';
/** THREAD and, after it, an agent message whose question is open (only skill emoji are offered then). */
function asking(): InboxThread {
  const questions = parseInboxQuestionBlocks(ASK).map(
    (q) =>
      ({
        key: q.key, position: q.position, kind: q.kind, prompt: q.prompt, context: q.parsed.context, choices: q.parsed.choices,
        recommendation: q.parsed.recommendation, suggested_text: q.parsed.suggested_text, stopped: q.stopped, holds_up: q.holds_up,
        asked_by_agent_id: CLAUDE.session, orphaned: false, state: 'open', answer: null, revision: 1, sent_revision: 0, picked_by: null,
        picked_at: null, sent_reply_id: null, message_id: M4, superseded_by: null,
      }) as unknown as InboxQuestion,
  );
  return { ...THREAD, messages: [...THREAD.messages, { ...message(M4, CLAUDE, ASK, 4), questions } as InboxMessageWire] };
}

beforeEach(() => {
  if (!hasDom) return;
  resetSavedReactionsForTests([{ emoji: '🎉', label: 'Ship it' }]);
  savedFetch = globalThis.fetch;
  acks = [];
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push(path);
      return Response.json({ reply: null, questions: [], replayed: false });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  jest.useRealTimers();
  for (const restore of restores.splice(0).reverse()) restore();
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('.ib-pm-pos, .ib-react-pos, .ib-skcard-pos, style[data-test-inbox-css]').forEach((n) => n.remove());
  window.getSelection()?.removeAllRanges();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  resetSavedReactionsForTests();
});

/** Sets `key` on `target` for this test only. */
function stub<T extends object, K extends keyof T>(target: T, key: K, value: T[K]) {
  const had = Object.prototype.hasOwnProperty.call(target, key);
  const was = target[key];
  (target as Record<K, T[K]>)[key] = value;
  restores.push(() => {
    if (had) (target as Record<K, T[K]>)[key] = was;
    else delete (target as Partial<T>)[key];
  });
}

async function settle(times = 2) {
  for (let i = 0; i < times; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}

async function render(thread: InboxThread = THREAD) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={thread}
        sent={null}
        lookSeq={0}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        onAck={(id, on, _agent, reaction) => acks.push({ id, on, reaction })}
        phone={false}
      />,
    );
  });
  await settle();
}

const face = () => document.querySelector<HTMLButtonElement>(`[data-react-face="${M3}"]`)!;
const strip = () => document.querySelector(`[data-react-strip="${M3}"]`);
const words = () => [...document.querySelectorAll<HTMLElement>(`[data-message-article="${M3}"] p`)].find((p) => p.textContent === WORDS)!;
const wordsText = () => words().firstChild as Text;

const mouse = (el: EventTarget, type: string, x: number, buttons = 1, more: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: 10, detail: 1, ...more });
  act(() => void el.dispatchEvent(event));
  return event;
};
const pointer = (el: Element, type: 'over' | 'enter' | 'out' | 'leave') =>
  act(() => void el.dispatchEvent(new PointerEvent(`pointer${type}`, { bubbles: type === 'over' || type === 'out', pointerType: 'mouse' })));
const rest = () => act(() => void jest.advanceTimersByTime(FACE_OPEN_MS * 3));

test.skipIf(!hasDom)('a drag over the words is the browser’s, and the face it reaches opens nothing; let go over it, it stays shut until left', async () => {
  await render();
  expect(words()).toBeTruthy();
  jest.useFakeTimers();
  const seen: boolean[] = [];
  try {
    const down = mouse(words(), 'mousedown', 4);
    expect(down.defaultPrevented).toBe(false);
    expect(mouse(words(), 'mousemove', 120).defaultPrevented).toBe(false);
    // The drag reaches the face, at the end of the first line, and rests there.
    pointer(face(), 'over');
    pointer(face(), 'enter');
    rest();
    seen.push(!!strip());
    expect(mouse(face(), 'mousemove', 300).defaultPrevented).toBe(false);
    // Let go over the face: it stays shut while the pointer is still on it (the words' comment toolbar is there).
    stub(document, 'elementFromPoint', (() => face()) as Document['elementFromPoint']);
    expect(mouse(words(), 'mouseup', 300, 0).defaultPrevented).toBe(false);
    act(() => faceHover.close());
    pointer(face(), 'over');
    pointer(face(), 'enter');
    rest();
    seen.push(!!strip());
    // Off it and back: the face opens on a rest again.
    pointer(face(), 'out');
    pointer(face(), 'leave');
    pointer(face(), 'over');
    pointer(face(), 'enter');
    rest();
    seen.push(!!strip());
    act(() => faceHover.close());
  } finally {
    jest.useRealTimers();
  }
  // Open: under the drag, after it let go over the face, after leaving and coming back.
  expect(seen).toEqual([false, false, true]);
});

test.skipIf(!hasDom)('a press on the face that drags selects the words from the press to the pointer; one that does not move is its click', async () => {
  await render();
  // Each x is a letter of the words (no layout here): the face lets the pointer through, so the point reads the words.
  const caretAt = (x: number) => ({ offsetNode: wordsText(), offset: Math.min(WORDS.length, Math.max(0, Math.round(x / 10))) });
  stub(document, 'caretPositionFromPoint', caretAt as unknown as Document['caretPositionFromPoint']);
  const down = mouse(face(), 'mousedown', 400);
  expect(down.defaultPrevented).toBe(false);
  // Within a click's wobble: nothing selected yet.
  mouse(document, 'mousemove', 402);
  expect(window.getSelection()!.toString()).toBe('');
  const move = mouse(document, 'mousemove', 160);
  expect(move.defaultPrevented).toBe(false);
  expect(window.getSelection()!.toString()).toBe(WORDS.slice(16, 40));
  mouse(words(), 'mouseup', 160, 0);
  expect(strip()).toBeNull();

  // A press that does not move: the face's click opens it.
  window.getSelection()!.removeAllRanges();
  mouse(face(), 'mousedown', 400);
  mouse(face(), 'mouseup', 400, 0);
  await act(async () => face().click());
  await settle();
  expect(strip()).not.toBeNull();
  expect(window.getSelection()!.toString()).toBe('');
});

test.skipIf(!hasDom)('the stylesheet leaves the words selectable and the face’s slot takes no pointer', async () => {
  const style = document.createElement('style');
  style.setAttribute('data-test-inbox-css', '');
  // The rules for a message and its face (the whole sheet is more than this DOM's parser takes).
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  style.textContent = [...css.matchAll(/^[^@{}\n][^{}\n]*\{[^{}]*\}/gm)].map((m) => m[0]).filter((rule) => /\.ib-(msg|message|rface|rstrip)\b/.test(rule.split('{')[0]!)).join('\n');
  document.head.appendChild(style);
  await render();
  for (const el of [words(), words().closest('.ib-msg')!, words().closest('[data-message-article]')!]) {
    expect(getComputedStyle(el).userSelect).not.toBe('none');
    expect(getComputedStyle(el).getPropertyValue('-webkit-user-select')).not.toBe('none');
  }
  expect(getComputedStyle(face().parentElement!).pointerEvents).toBe('none');
  // At rest the face is unseen and takes no pointer either (it shows on hover).
  expect(getComputedStyle(face()).opacity).toBe('0');
});

/** Each x is a letter of the words (no layout here): the face lets the pointer through, so a point reads the words. */
function lettersByX() {
  const caretAt = (x: number) => ({ offsetNode: wordsText(), offset: Math.min(WORDS.length, Math.max(0, Math.round(x / 10))) });
  stub(document, 'caretPositionFromPoint', caretAt as unknown as Document['caretPositionFromPoint']);
}

/** A whole click on `el` at `x`: press, release, click, the `detail` the browser counts. */
function click(el: Element, x: number, more: MouseEventInit = {}) {
  mouse(el, 'mousedown', x, 1, more);
  mouse(el, 'mouseup', x, 0, more);
  mouse(el, 'click', x, 0, more);
}

for (const waits of [false, true]) {
  test.skipIf(!hasDom)(`a double-click on a word under the face selects the word and sends nothing${waits ? ' (a question waits: its emoji is a skill)' : ''}`, async () => {
    if (waits) resetSavedReactionsForTests([{ emoji: '🎉', label: 'Ship it' }, { emoji: '😵‍💫', skill: 'bro' }]);
    await render(waits ? asking() : THREAD);
    lettersByX();
    // The first click opens the face at once; its last emoji now sits under the pointer.
    click(face(), 400, { detail: 1 });
    await settle();
    const cells = [...strip()!.querySelectorAll<HTMLButtonElement>('button')];
    expect(cells.map((c) => c.querySelector('.ib-react-e')?.textContent ?? 'face').at(-1)).toBe(waits ? '😵‍💫' : 'face');
    const last = cells.at(-1)!;
    // The second press of the double-click: the word under it is selected, as with no face there.
    const down = mouse(last, 'mousedown', 400, 1, { detail: 2 });
    expect(down.defaultPrevented).toBe(false);
    expect(window.getSelection()!.toString()).toBe('March');
    mouse(words(), 'mouseup', 400, 0, { detail: 2 });
    // Its click reaches the emoji (the worst case): still nothing is sent.
    mouse(last, 'click', 400, 0, { detail: 2 });
    mouse(words(), 'dblclick', 400, 0, { detail: 2 });
    await settle();
    expect(acks).toEqual([]);
    expect(posts).toEqual([]);
    expect(document.querySelector('[data-reaction-tray]')).toBeNull();
    expect(strip()).toBeNull();
  });
}

test.skipIf(!hasDom)('a Shift-click on the face extends the selection to the word under it and opens nothing', async () => {
  await render();
  lettersByX();
  window.getSelection()!.setBaseAndExtent(wordsText(), 4, wordsText(), 10);
  expect(window.getSelection()!.toString()).toBe('ledger');
  const down = mouse(face(), 'mousedown', 400, 1, { shiftKey: true });
  expect(down.defaultPrevented).toBe(false);
  expect(window.getSelection()!.toString()).toBe(WORDS.slice(4, 40));
  mouse(words(), 'mouseup', 400, 0, { shiftKey: true });
  mouse(face(), 'click', 400, 0, { shiftKey: true });
  await settle();
  expect(strip()).toBeNull();
});

test.skipIf(!hasDom)('a deliberate click on the face, then a press on an emoji, reacts; a press the moment it opened does not', async () => {
  await render();
  click(face(), 400);
  await settle();
  const ship = () => [...strip()!.querySelectorAll<HTMLButtonElement>('button')].find((c) => c.querySelector('.ib-react-e')?.textContent === '🎉')!;
  // Right after the click opened it: nothing.
  click(ship(), 300);
  await settle();
  expect(acks).toEqual([]);
  expect(strip()).not.toBeNull();
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, STRIP_SETTLE_MS + 30))));
  click(ship(), 300);
  await settle();
  expect(acks).toEqual([{ id: M3, on: true, reaction: { emoji: '🎉', label: 'Ship it' } }]);
});
