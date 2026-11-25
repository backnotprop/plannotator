/**
 * Assertions compare booleans and strings, never elements: a failed `expect(element)` makes bun print a happy-dom
 * node, which can take the test process down instead of failing the test.
 *
 * The owner's rule for the reply box: "The moment I start typing text, that's a draft." Words typed in a thread's reply
 * box are never lost, whatever arrives meanwhile:
 *
 * - A saved draft that arrives while the box is open (another window or device saved it, or the thread's first read
 *   answered late): an untouched box takes it; a box the person wrote in offers it (Restore draft), and the box's next
 *   edit takes it in, the typed words after it, and saves both.
 *
 * The thread pane over a scripted Inbox (a stubbed fetch holding drafts with the server's compare-and-set). DOM-gated:
 * runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';
import type { Signal } from './signal';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { replyDraftUnsaved, resetReplyDraftPageForTests } = (hasDom ? await import('./replyDraft') : {}) as typeof import('./replyDraft');
const { createSignal } = (hasDom ? await import('./signal') : {}) as typeof import('./signal');
const { inboxReconnected } = (hasDom ? await import('./sessionAdopt') : {}) as typeof import('./sessionAdopt');
const { rememberMachine, resetMachineRoutes } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'codex', session: 'ses_a', name: 'Codex' };
const ONE = 'msg_01M6RF0000000000000000001';
const TWO = 'msg_01M6RF0000000000000000002';

const threadOf = (id: string, subject: string): InboxThread => ({
  thread_id: id,
  project: PROJECT,
  subject,
  thread_name: null,
  resolved_at: null,
  messages: [
    { id, project_id: PROJECT.id, thread_id: id, reply_to: null, author: A, subject, body: 'The retry loop backs off two, four and eight seconds.', created_at: '2026-11-02T10:01:00.000Z', resolved_at: null, idempotency_key: null } as InboxMessageWire,
  ],
});

/** The scripted Inbox's drafts, by thread, and every draft save it took (or refused). */
let drafts = new Map<string, InboxReplyDraft>();
let saves: { thread: string; body: string; at: number; status: number }[] = [];
/** How a draft save is answered instead of the store's own (null: the store's). */
let saveAnswer: ((thread: string, body: Record<string, unknown>) => Response | Promise<Response>) | null = null;
/** A draft read held until this resolves (null: answered at once). */
let readHeld: Promise<void> | null = null;
let clock = 0;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let signal: Signal;

/** A draft as another window or device saves it (the store's compare-and-set skipped: it is theirs). */
function saveElsewhere(thread: string, body: string) {
  clock += 1;
  drafts.set(thread, { v: 1, thread_id: thread, body, created_at: '2026-11-02T10:10:00.000Z', updated_at: new Date(Date.UTC(2026, 10, 2, 11, 0, clock)).toISOString() });
}

function storeSave(thread: string, input: Record<string, unknown>): Response {
  const current = drafts.get(thread) ?? null;
  const base = (input.base as string | null | undefined) ?? null;
  // The server's compare-and-set: a base behind the draft is refused unless the draft still holds the words this window saved last.
  if ((current?.updated_at ?? null) !== base && !(current && typeof input.base_body === 'string' && current.body === input.base_body)) {
    return Response.json({ error: 'The draft changed.', code: 'draft_conflict', draft: current }, { status: 409 });
  }
  const body = String(input.body ?? '');
  if (body === '') {
    drafts.delete(thread);
    return Response.json({ draft: null });
  }
  saveElsewhere(thread, body);
  return Response.json({ draft: drafts.get(thread) });
}

beforeEach(() => {
  if (!hasDom) return;
  drafts = new Map();
  saves = [];
  saveAnswer = null;
  readHeld = null;
  signal = createSignal();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const draftPath = /\/threads\/([^/]+)\/draft$/.exec(path.split('?')[0]!);
    if (draftPath) {
      const thread = decodeURIComponent(draftPath[1]!);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const answer = saveAnswer ? await saveAnswer(thread, body) : storeSave(thread, body);
        saves.push({ thread, body: String(body.body ?? ''), at: Date.now(), status: answer.status });
        return answer;
      }
      if (readHeld) await readHeld;
      return Response.json({ serverSession: 's', draft: drafts.get(thread) ?? null });
    }
    if (/\/draft\/delete$/.test(path)) return Response.json({ ok: true, deleted: true });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  saveAnswer = null;
  readHeld = null;
  for (let i = 0; i < 100 && replyDraftUnsaved(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const left = replyDraftUnsaved();
  globalThis.fetch = savedFetch;
  // Each test starts on a page of its own: nothing one leaves can make the next pass or fail.
  resetReplyDraftPageForTests();
  localStorage.clear();
  if (left) throw new Error('the test left a reply draft save on its way, or words not saved');
});

async function settle(turns = 4, ms = 20) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(1, 10);
  }
}

function draw(id: string) {
  root!.render(
    <div className="pn-inbox">
      <ThreadPane thread={threadOf(id, id === ONE ? 'Retry worker' : 'Ledger export')} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} draftSignal={signal} />
    </div>,
  );
}

async function open(id = ONE): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(id);
  });
  await settle();
  return host;
}

const box = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea');
const offerShown = (el: HTMLElement) => el.querySelector('[data-draft-restore]') !== null;

async function reply(el: HTMLElement) {
  const button = el.querySelector<HTMLButtonElement>('[data-reply-button]');
  expect(!!button).toBe(true);
  await act(async () => button!.click());
  await settle(2);
  expect(!!box(el)).toBe(true);
}

/** Keys typed at the end of the box's words, as a person types them. */
function typeOn(el: HTMLElement, words: string) {
  const text = box(el)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    text.focus();
    const next = text.value + words;
    setter.call(text, next);
    text.setSelectionRange(next.length, next.length);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The last draft save that landed for the thread, made after `since`. */
const landedSince = (thread: string, since: number) => saves.filter((s) => s.thread === thread && s.status === 200 && s.at >= since).at(-1)?.body ?? null;

test.skipIf(!hasDom)('another device saves while this box is open and untouched: the box takes its words, and typing on saves both', async () => {
  const el = await open();
  await reply(el);
  saveElsewhere(ONE, 'Words from the iPad.');
  await act(async () => signal.emit());
  await until(() => box(el)?.value === 'Words from the iPad.', 'the box takes the saved draft');
  expect(offerShown(el)).toBe(false);
  const at = Date.now();
  typeOn(el, ' And from the Mac.');
  await until(() => landedSince(ONE, at) !== null, 'a save', 1000);
  expect(drafts.get(ONE)?.body).toBe('Words from the iPad. And from the Mac.');
});

test.skipIf(!hasDom)('another device goes on from words typed here: the box offers it, and the next key takes it in and saves both within a second', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Started on the Mac.');
  await until(() => drafts.get(ONE)?.body === 'Started on the Mac.', 'the first save');
  saveElsewhere(ONE, 'Started on the Mac. Added on the iPad.');
  await act(async () => signal.emit());
  await until(() => offerShown(el), 'the offer');
  expect(box(el)!.value).toBe('Started on the Mac.');
  const at = Date.now();
  typeOn(el, ' More from the Mac.');
  // The box holds both devices' words at once, and the draft is saved with them.
  expect(box(el)!.value).toBe('Started on the Mac. Added on the iPad. More from the Mac.');
  expect(offerShown(el)).toBe(false);
  await until(() => landedSince(ONE, at) !== null, 'a save', 1000);
  expect(drafts.get(ONE)?.body).toBe('Started on the Mac. Added on the iPad. More from the Mac.');
  expect(replyDraftUnsaved()).toBe(false);
});

test.skipIf(!hasDom)('another device rewrote words typed here: the next key keeps both, its draft first and a blank line, and saves them', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Ship on Friday.');
  await until(() => drafts.get(ONE)?.body === 'Ship on Friday.', 'the first save');
  saveElsewhere(ONE, 'Hold the release.');
  await act(async () => signal.emit());
  await until(() => offerShown(el), 'the offer');
  typeOn(el, ' Unless QA passes.');
  await until(() => drafts.get(ONE)?.body === 'Hold the release.\n\nShip on Friday. Unless QA passes.', 'both saved', 1000);
  expect(box(el)!.value).toBe('Hold the release.\n\nShip on Friday. Unless QA passes.');
});

test.skipIf(!hasDom)('the box opened before a slow draft read answers, and the person types: both are saved, the draft first', async () => {
  saveElsewhere(ONE, 'Words saved yesterday.');
  let letGo!: () => void;
  readHeld = new Promise<void>((done) => (letGo = done));
  const el = await open();
  await reply(el);
  typeOn(el, 'Thanks');
  await settle(2);
  letGo();
  const at = Date.now();
  await until(() => drafts.get(ONE)?.body === 'Words saved yesterday.\n\nThanks', 'both saved', 1500);
  expect(box(el)!.value).toBe('Words saved yesterday.\n\nThanks');
  expect(el.querySelector('[data-draft-conflict]') === null).toBe(true);
  expect(offerShown(el)).toBe(false);
  // Nothing saved only the typed word over the draft on the way.
  expect(saves.filter((s) => s.at >= at && s.status === 200).every((s) => s.body.includes('Words saved yesterday.'))).toBe(true);
});

test.skipIf(!hasDom)('the box opened before a slow draft read answers, untouched: it takes the draft, and typing after saves both', async () => {
  saveElsewhere(ONE, 'Words saved yesterday.');
  let letGo!: () => void;
  readHeld = new Promise<void>((done) => (letGo = done));
  const el = await open();
  await reply(el);
  letGo();
  await until(() => box(el)?.value === 'Words saved yesterday.', 'the box takes the draft');
  expect(offerShown(el)).toBe(false);
  typeOn(el, ' And today.');
  await until(() => drafts.get(ONE)?.body === 'Words saved yesterday. And today.', 'both saved', 1000);
});

/** A thread opened holding a saved draft: the box is back with its words, without focus, its caret at their start (as a browser draws it). */
async function openRestored(words: string): Promise<{ el: HTMLElement; text: HTMLTextAreaElement }> {
  saveElsewhere(ONE, words);
  const el = await open();
  await until(() => box(el)?.value === words, 'the draft back in the box');
  const text = box(el)!;
  expect(document.activeElement === text).toBe(false);
  text.setSelectionRange(0, 0);
  return { el, text };
}
const caretAtEnd = (text: HTMLTextAreaElement) => document.activeElement === text && text.selectionStart === text.value.length && text.selectionEnd === text.value.length;

test.skipIf(!hasDom)("a restored draft: the message's Reply arrow puts focus in the box, the caret after the words", async () => {
  const { el, text } = await openRestored('Keep the totals column.');
  const arrow = el.querySelector<HTMLButtonElement>(`[data-message-article="${ONE}"] button[aria-label="Reply"]`);
  expect(!!arrow).toBe(true);
  await act(async () => {
    arrow!.focus();
    arrow!.click();
  });
  // At once, before a frame: a key typed right after the click goes into the box, never to a thread shortcut.
  expect(caretAtEnd(text)).toBe(true);
  await settle(2);
  expect(caretAtEnd(text)).toBe(true);
});

test.skipIf(!hasDom)('a restored draft: R puts focus in the box, the caret after the words', async () => {
  const { text } = await openRestored('Keep the totals column.');
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true }));
  });
  expect(caretAtEnd(text)).toBe(true);
  await settle(2);
  expect(caretAtEnd(text)).toBe(true);
});

test.skipIf(!hasDom)('a restored draft focused by a key (Tab): the caret lands after the words, never in front of them', async () => {
  const { text } = await openRestored('Keep the totals column.');
  await act(async () => text.focus());
  expect(caretAtEnd(text)).toBe(true);
});

/** The page predates an update of the Inbox: its session is not the running Inbox's, and the save is refused. */
const refusedForSession = () => Response.json({ error: 'This Inbox page is out of date.', code: 'session_mismatch' }, { status: 409 });
const noNetwork = (): Response => {
  throw new TypeError('Failed to fetch');
};

/** Words typed, then a save that does not land: returns the pane with the newer words unsaved. */
async function typedThenFailed(fail: () => Response): Promise<HTMLElement> {
  const el = await open();
  await reply(el);
  typeOn(el, 'Older words.');
  await until(() => drafts.get(ONE)?.body === 'Older words.', 'the first save');
  saveAnswer = fail;
  typeOn(el, ' Newer words.');
  await until(() => el.querySelector('[data-draft-failed]') !== null, '"Not saved"');
  expect(drafts.get(ONE)?.body).toBe('Older words.');
  return el;
}

async function failedThenBack(fail: () => Response, back: () => void) {
  const el = await typedThenFailed(fail);
  // To another thread and back: the box holds the newer words, never the older draft.
  act(() => draw(TWO));
  await settle();
  act(() => draw(ONE));
  await until(() => box(el)?.value === 'Older words. Newer words.', 'the newer words back in the box');
  expect(replyDraftUnsaved()).toBe(true);
  // The Inbox answers again: the words are saved without a key typed.
  saveAnswer = null;
  back();
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'the newer words saved');
  await until(() => el.querySelector('[data-draft-failed]') === null, '"Not saved" gone');
  expect(replyDraftUnsaved()).toBe(false);
}

test.skipIf(!hasDom)('a save refused for an out-of-date page: the words stay with the thread, and land once the stream is back', async () => {
  await failedThenBack(refusedForSession, () => inboxReconnected());
});

test.skipIf(!hasDom)('a save with no network: the words stay with the thread, and land once the page is back online', async () => {
  await failedThenBack(noNetwork, () => window.dispatchEvent(new Event('online')));
});

test.skipIf(!hasDom)('words that did not land are saved again when their thread is opened again', async () => {
  await typedThenFailed(noNetwork);
  act(() => draw(TWO));
  await settle();
  saveAnswer = null;
  act(() => draw(ONE));
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'saved on opening the thread');
});

test.skipIf(!hasDom)('words that did not land, while another device saved the draft: both are kept, the conflict shows', async () => {
  const el = await typedThenFailed(noNetwork);
  act(() => draw(TWO));
  await settle();
  saveAnswer = null;
  saveElsewhere(ONE, 'The iPad wrote this.');
  act(() => draw(ONE));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  expect(box(el)!.value).toBe('Older words. Newer words.');
  expect(drafts.get(ONE)?.body).toBe('The iPad wrote this.');
  // Keep mine saves them over it (and leaves nothing waiting for the next test).
  act(() => [...el.querySelectorAll<HTMLButtonElement>('[data-draft-conflict] button')].find((b) => b.textContent === 'Keep mine')!.click());
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'Keep mine saved');
});

/** The page hidden (a phone's app switch, the tab switcher, a locked screen) or shown again, as `visibilitychange` says. */
function pageVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test.skipIf(!hasDom)('the page hidden inside the pause in typing: the words are sent at once, and read back when it shows again', async () => {
  const el = await open();
  await reply(el);
  try {
    const at = Date.now();
    typeOn(el, 'Typed on the phone, then another app.');
    pageVisibility('hidden');
    // Well inside the pause in typing (500 ms): sent as the page hid, not after it.
    await until(() => drafts.get(ONE)?.body === 'Typed on the phone, then another app.', 'the save as the page hid', 200);
    expect(Date.now() - at < 400).toBe(true);
    pageVisibility('visible');
    await settle(4);
    expect(el.querySelector('[data-draft-failed]') === null).toBe(true);
    expect(replyDraftUnsaved()).toBe(false);
    // Typing on saves over it: never a conflict with this window's own words.
    typeOn(el, ' Back.');
    await until(() => drafts.get(ONE)?.body === 'Typed on the phone, then another app. Back.', 'saved on top', 1500);
    expect(el.querySelector('[data-draft-conflict]') === null).toBe(true);
  } finally {
    pageVisibility('visible');
  }
});

test.skipIf(!hasDom)("another computer's thread: words typed in its box stay with it when the person goes to another thread and back, and are guarded", async () => {
  const MAC = `ibx_01K${'0'.repeat(22)}M`;
  rememberMachine([TWO], MAC);
  try {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      draw(TWO);
    });
    await settle();
    const el = host;
    await reply(el);
    typeOn(el, 'Words for the Mac mini thread.');
    await settle(2);
    expect(replyDraftUnsaved()).toBe(true);
    act(() => draw(ONE));
    await settle();
    act(() => draw(TWO));
    await until(() => box(el)?.value === 'Words for the Mac mini thread.', 'the words back in the box');
    expect(replyDraftUnsaved()).toBe(true);
    // Discard lets them go (and nothing is left waiting for the next test).
    const bin = el.querySelector<HTMLButtonElement>('[data-reply-discard]');
    expect(!!bin).toBe(true);
    await act(async () => bin!.click());
    await settle(2);
    expect(replyDraftUnsaved()).toBe(false);
  } finally {
    resetMachineRoutes();
  }
});

test.skipIf(!hasDom)('a draft offered here, then sent from the other device: its words never come back into this box or a save', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Started on the Mac.');
  await until(() => drafts.get(ONE)?.body === 'Started on the Mac.', 'the first save');
  saveElsewhere(ONE, 'The iPad rewrote it and sent it.');
  await act(async () => signal.emit());
  await until(() => offerShown(el), 'the offer');
  // The iPad sends it: its draft goes.
  drafts.delete(ONE);
  const sentAt = Date.now();
  await act(async () => signal.emit());
  await settle(6);
  if (box(el)) typeOn(el, ' k');
  await settle(4, 300);
  expect((box(el)?.value ?? '').includes('The iPad rewrote it')).toBe(false);
  expect(saves.some((s) => s.at >= sentAt && s.status === 200 && s.body.includes('The iPad rewrote it'))).toBe(false);
  expect((drafts.get(ONE)?.body ?? '').includes('The iPad rewrote it')).toBe(false);
  expect(el.querySelector('[data-draft-conflict]') === null).toBe(true);
});

test.skipIf(!hasDom)('a draft offered here, then saved again on the other device: the next key takes the newer one in', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Started on the Mac.');
  await until(() => drafts.get(ONE)?.body === 'Started on the Mac.', 'the first save');
  saveElsewhere(ONE, 'Started on the Mac. iPad, first pass.');
  await act(async () => signal.emit());
  await until(() => offerShown(el), 'the offer');
  saveElsewhere(ONE, 'Started on the Mac. iPad, second pass.');
  await act(async () => signal.emit());
  await settle(6);
  typeOn(el, ' Mac again.');
  expect(box(el)!.value).toBe('Started on the Mac. iPad, second pass. Mac again.');
  await until(() => drafts.get(ONE)?.body === 'Started on the Mac. iPad, second pass. Mac again.', 'both saved', 1500);
  expect(el.querySelector('[data-draft-conflict]') === null).toBe(true);
});

test.skipIf(!hasDom)('the page shown again with a slow read-back while newer words are typed: the older words never land after them', async () => {
  const el = await open();
  await reply(el);
  try {
    typeOn(el, 'Words typed first.');
    // The phone hides inside the pause, and its keepalive does not land.
    saveAnswer = noNetwork;
    pageVisibility('hidden');
    await settle(2);
    saveAnswer = null;
    let letGo!: () => void;
    readHeld = new Promise<void>((done) => (letGo = done));
    pageVisibility('visible');
    await settle(1);
    // Newer words, whose save waits behind the slow read-back.
    typeOn(el, ' Then newer ones.');
    await settle(4, 200);
    letGo();
    readHeld = null;
    await until(() => drafts.get(ONE)?.body !== undefined, 'a save');
    await settle(6, 100);
    expect(drafts.get(ONE)?.body).toBe('Words typed first. Then newer ones.');
  } finally {
    pageVisibility('visible');
  }
});

test.skipIf(!hasDom)('words that did not land, the thread left and opened again, Reply tapped and a key typed before the read answers: both are kept and saved', async () => {
  const el = await typedThenFailed(noNetwork);
  act(() => draw(TWO));
  await settle();
  saveAnswer = null;
  let letGo!: () => void;
  readHeld = new Promise<void>((done) => (letGo = done));
  act(() => draw(ONE));
  await settle(1);
  await reply(el);
  typeOn(el, ' And k.');
  letGo();
  readHeld = null;
  await until(() => (drafts.get(ONE)?.body ?? '').includes('And k.'), 'a save with the new key', 2000);
  expect(drafts.get(ONE)?.body).toBe('Older words. Newer words. And k.');
  expect(box(el)!.value).toBe('Older words. Newer words. And k.');
  await until(() => !replyDraftUnsaved(), 'nothing left unsaved');
});

test.skipIf(!hasDom)('the page hidden while its save did not land: the words are sent again as it hides', async () => {
  const el = await typedThenFailed(noNetwork);
  try {
    saveAnswer = null;
    pageVisibility('hidden');
    await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'the save as the page hid', 300);
    pageVisibility('visible');
    await until(() => el.querySelector('[data-draft-failed]') === null, '"Not saved" gone');
  } finally {
    pageVisibility('visible');
  }
});
