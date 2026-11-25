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
 *
 * happy-dom has no Web Locks (`navigator.locks`), as a phone's page on plain http has none: every test here runs that
 * path (a page keeping words says it is open with a heartbeat in localStorage), except those that install
 * `locksHeldBy` or `slowLocks` (the Web Locks path).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxReplyDraft, InboxReplyDraftRow, InboxThread } from '@plannotator/core/inbox-types';
import type { Signal } from './signal';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { FloaterBox } = (hasDom ? await import('./floaters/FloaterBox') : {}) as typeof import('./floaters/FloaterBox');
const { ChatWindowStore } = (hasDom ? await import('@plannotator/ui/components/chat') : {}) as typeof import('@plannotator/ui/components/chat');
const { replyDraftUnsaved, resetReplyDraftPageForTests } = (hasDom ? await import('./replyDraft') : {}) as typeof import('./replyDraft');
const { createSignal } = (hasDom ? await import('./signal') : {}) as typeof import('./signal');
const { keepWords } = (hasDom ? await import('./replyWordsKept') : {}) as typeof import('./replyWordsKept');
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
  // The server keeps the draft's files: a save names only the files it changes.
  const files = drafts.get(thread)?.files;
  drafts.set(thread, { v: 1, thread_id: thread, body, created_at: '2026-11-02T10:10:00.000Z', updated_at: new Date(Date.UTC(2026, 10, 2, 11, 0, clock)).toISOString(), ...(files ? { files } : {}) });
}
/** Every reply the window sent, as sent. */
let replies: Record<string, unknown>[] = [];

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
  replies = [];
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
    if (/\/messages\/[^/]+\/reply$/.test(path) && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      replies.push(body);
      // The server's clear: the draft named by its `updated_at`, or ('') one holding exactly these words and no file.
      const kept = drafts.get(ONE);
      const clear = body.clear_draft;
      if (kept && typeof clear === 'string' && (clear === kept.updated_at || (clear === '' && kept.body.trim() === String(body.words ?? '').trim() && !kept.files?.length))) drafts.delete(ONE);
      return Response.json({ reply: { id: 'msg_reply' }, questions: [], replayed: false });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

/** Floating draft windows a test opened (unmounted with the pane). */
const floaters: { root: Root; host: HTMLElement }[] = [];

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  for (const floater of floaters.splice(0)) {
    act(() => floater.root.unmount());
    floater.host.remove();
  }
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

test.skipIf(!hasDom)('Send from a closed box after a save did not land: the Send takes the draft as saved then, its files too, and clears it', async () => {
  saveElsewhere(ONE, 'Older words.');
  drafts.set(ONE, { ...drafts.get(ONE)!, files: [{ upload_id: 'upl_shot', name: 'shot.png', size: 10, kind: 'image', sha256: 'a'.repeat(64), created_at: '2026-11-02T10:00:00.000Z', media_type: 'image/png' }] });
  const el = await open();
  await until(() => box(el)?.value === 'Older words.', 'the draft back in the box');
  saveAnswer = noNetwork;
  typeOn(el, ' Newer words.');
  await until(() => el.querySelector('[data-draft-failed]') !== null, '"Not saved"');
  // Closed (Escape keeps the words as the draft): the foot's Send carries them.
  await act(async () => {
    box(el)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => box(el) === null, 'the box closed');
  saveAnswer = null;
  const send = el.querySelector<HTMLButtonElement>('[data-foot-buttons] button.ib-pri');
  expect(!!send).toBe(true);
  await act(async () => send!.click());
  await until(() => replies.length === 1, 'the Send');
  expect(replies[0]!.words).toBe('Older words. Newer words.');
  expect(replies[0]!.uploads).toEqual(['upl_shot']);
  await until(() => !drafts.has(ONE), 'the draft cleared by the Send');
  await settle(6);
  // Sent: the words do not come back as a draft.
  expect(box(el) === null || !box(el)!.value.includes('Newer words.')).toBe(true);
  expect(drafts.has(ONE)).toBe(false);
});

/** The box's words as a person's edit leaves them, the caret at `caret`. */
function editTo(el: HTMLElement, value: string, caret: number) {
  const text = box(el)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    text.focus();
    setter.call(text, value);
    text.setSelectionRange(caret, caret);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('another device added to words typed here, and the next edit is in their middle: made once in the newer words, the caret where it was', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Ship on Friday.');
  await until(() => drafts.get(ONE)?.body === 'Ship on Friday.', 'the first save');
  saveElsewhere(ONE, 'Ship on Friday. QA signed off.');
  await act(async () => signal.emit());
  await until(() => offerShown(el), 'the offer');
  editTo(el, 'Ship on Monday.', 'Ship on Mon'.length);
  expect(box(el)!.value).toBe('Ship on Monday. QA signed off.');
  await settle(2);
  expect([box(el)!.selectionStart, box(el)!.selectionEnd]).toEqual([11, 11]);
  await until(() => drafts.get(ONE)?.body === 'Ship on Monday. QA signed off.', 'saved', 1500);
});

const keptInBrowser = () => Object.keys(localStorage).filter((key) => key.startsWith('plannotator-inbox-reply-kept:'));

const ALIVE = 'plannotator-inbox-reply-kept-alive:';
/**
 * The browser ends the tab (a phone short of memory): nothing of the page runs again, and a new page opens the thread.
 * `satHidden`: the tab sat hidden first (a phone freezes a hidden tab), so its last heartbeat is older than 30 s.
 */
async function newPageAfterTabEnded(id = ONE, satHidden = true): Promise<HTMLElement> {
  act(() => root?.unmount());
  host?.remove();
  if (satHidden) for (const key of Object.keys(localStorage)) if (key.startsWith(ALIVE)) localStorage.setItem(key, String(Date.now() - 60_000));
  resetReplyDraftPageForTests();
  return open(id);
}

test.skipIf(!hasDom)('words that did not land, and the tab ended: a new page has them back in the box, "Not saved", and saves them once the Inbox answers', async () => {
  await typedThenFailed(noNetwork);
  const el = await newPageAfterTabEnded();
  await until(() => box(el)?.value === 'Older words. Newer words.', 'the words back in the box');
  await until(() => el.querySelector('[data-draft-failed]') !== null, '"Not saved"');
  saveAnswer = null;
  window.dispatchEvent(new Event('online'));
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'saved');
  await until(() => !replyDraftUnsaved(), 'nothing left unsaved');
  expect(keptInBrowser()).toEqual([]);
});

/** Words that did not land while another device saved the draft: the conflict shows. */
async function conflictShown(): Promise<HTMLElement> {
  const el = await typedThenFailed(noNetwork);
  act(() => draw(TWO));
  await settle();
  saveAnswer = null;
  saveElsewhere(ONE, 'The iPad wrote this.');
  act(() => draw(ONE));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  return el;
}
const conflictButton = (el: HTMLElement, label: string) => [...el.querySelectorAll<HTMLButtonElement>('[data-draft-conflict] button')].find((b) => b.textContent === label)!;

test.skipIf(!hasDom)('a conflict, and the tab ended: a new page shows the conflict again with these words; Discard mine then leaves nothing to come back', async () => {
  await conflictShown();
  let el = await newPageAfterTabEnded();
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict again');
  expect(box(el)!.value).toBe('Older words. Newer words.');
  expect(drafts.get(ONE)?.body).toBe('The iPad wrote this.');
  await act(async () => conflictButton(el, 'Discard mine').click());
  await settle(2);
  expect(keptInBrowser()).toEqual([]);
  el = await newPageAfterTabEnded();
  await settle(4);
  expect(el.querySelector('[data-draft-conflict]') === null).toBe(true);
  expect((box(el)?.value ?? '').includes('Newer words.')).toBe(false);
});

test.skipIf(!hasDom)('Keep mine on its way when the tab ended: a new page saves the words over the other draft', async () => {
  const el = await conflictShown();
  // The Inbox does not answer Keep mine's save.
  saveAnswer = noNetwork;
  await act(async () => conflictButton(el, 'Keep mine').click());
  expect(keptInBrowser().length).toBe(1);
  await settle(2);
  saveAnswer = null;
  await newPageAfterTabEnded();
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'saved by the new page');
  await until(() => !replyDraftUnsaved(), 'nothing left unsaved');
  expect(keptInBrowser()).toEqual([]);
});

test.skipIf(!hasDom)('words that did not land, then Discard: a new page after the tab ended brings nothing back', async () => {
  const el = await typedThenFailed(noNetwork);
  saveAnswer = null;
  const bin = el.querySelector<HTMLButtonElement>('[data-reply-discard]');
  expect(!!bin).toBe(true);
  await act(async () => bin!.click());
  await settle(2);
  expect(keptInBrowser()).toEqual([]);
  const next = await newPageAfterTabEnded();
  await settle(4);
  expect((box(next)?.value ?? '').includes('Newer words.')).toBe(false);
  expect(next.querySelector('[data-draft-failed]') === null).toBe(true);
});

test.skipIf(!hasDom)('words that did not land, then sent from the closed box: a new page after the tab ended brings nothing back', async () => {
  const el = await typedThenFailed(noNetwork);
  await act(async () => {
    box(el)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => box(el) === null, 'the box closed');
  // Still no network for drafts: the Send carries the words that did not land.
  await act(async () => el.querySelector<HTMLButtonElement>('[data-foot-buttons] button.ib-pri')!.click());
  await until(() => replies.length === 1, 'the Send');
  expect(replies[0]!.words).toBe('Older words. Newer words.');
  await settle(4);
  expect(keptInBrowser()).toEqual([]);
  saveAnswer = null;
  const next = await newPageAfterTabEnded();
  await settle(4);
  expect((box(next)?.value ?? '').includes('Newer words.')).toBe(false);
  expect(saves.some((s) => s.status === 200 && s.body.includes('Newer words.'))).toBe(false);
});

test.skipIf(!hasDom)("another computer's thread, and the tab ended: a new page has its words back in the box", async () => {
  const MAC = `ibx_01K${'0'.repeat(22)}M`;
  rememberMachine([TWO], MAC);
  try {
    const el = await open(TWO);
    await reply(el);
    typeOn(el, 'Words for the Mac mini thread.');
    await settle(2);
    const next = await newPageAfterTabEnded(TWO);
    await until(() => box(next)?.value === 'Words for the Mac mini thread.', 'the words back in the box');
    await act(async () => next.querySelector<HTMLButtonElement>('[data-reply-discard]')!.click());
    await settle(2);
    expect(keptInBrowser()).toEqual([]);
  } finally {
    resetMachineRoutes();
  }
});

/** Escape closes the box (its words stay as the draft). */
async function closeBox(el: HTMLElement) {
  await act(async () => {
    box(el)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => box(el) === null, 'the box closed');
}

test.skipIf(!hasDom)('words that did not land, the box closed, and another device saves: the words are never saved over its draft, the conflict shows', async () => {
  const el = await typedThenFailed(noNetwork);
  await closeBox(el);
  // The iPad saves while the box is closed, and this window reads it.
  saveElsewhere(ONE, 'The iPad wrote this.');
  await act(async () => signal.emit());
  await settle(4);
  // The network is back: whatever is retried never lands over the iPad's draft.
  saveAnswer = null;
  window.dispatchEvent(new Event('online'));
  await settle(6);
  expect(drafts.get(ONE)?.body).toBe('The iPad wrote this.');
  // Both are kept: the box opens with this window's words and the choice.
  await reply(el);
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  expect(box(el)!.value).toBe('Older words. Newer words.');
  // A new page after the tab ended has the same choice, never a quiet save over the iPad's draft.
  const next = await newPageAfterTabEnded();
  await settle(6);
  expect(drafts.get(ONE)?.body).toBe('The iPad wrote this.');
  await until(() => next.querySelector('[data-draft-conflict]') !== null, 'the conflict on a new page');
  expect(box(next)!.value).toBe('Older words. Newer words.');
  await act(async () => conflictButton(next, 'Keep mine').click());
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'Keep mine saved');
});

/** A thread's floating draft window, beside the thread pane (another thread is open there). */
async function openFloater(id = ONE): Promise<HTMLElement> {
  const floaterHost = document.createElement('div');
  floaterHost.className = 'pn-inbox';
  document.body.appendChild(floaterHost);
  const floaterRoot = createRoot(floaterHost);
  const row = { thread_id: id, subject: 'Retry worker', thread_name: null, project: { id: PROJECT.id, name: PROJECT.name }, author: A, unseen: 0, unsent: { reply_at: drafts.get(id)?.updated_at ?? null, picks: 0, comments: 0 }, reply_preview: drafts.get(id)?.body ?? null } as unknown as InboxReplyDraftRow;
  act(() => floaterRoot.render(<FloaterBox row={row} phone={false} frame={new ChatWindowStore()} takeFocus={false} onMinimize={() => {}} onPutAway={() => {}} onOpenThread={() => {}} onSent={() => {}} onDiscarded={() => {}} onGone={() => {}} />));
  floaters.push({ root: floaterRoot, host: floaterHost });
  await settle();
  return floaterHost;
}
const floaterBox = () => document.querySelector<HTMLTextAreaElement>(`[data-rf-box="${ONE}"] textarea`);

test.skipIf(!hasDom)("words that did not land, then the thread's floating draft: it shows them, and its next key saves them, never the older draft", async () => {
  const el = await typedThenFailed(noNetwork);
  act(() => draw(TWO));
  await settle();
  // Still no network as the floating window opens: its own try of the words does not land either.
  await openFloater();
  await until(() => floaterBox() !== null && floaterBox()!.readOnly === false, 'the floating box');
  await settle(4);
  expect(floaterBox()!.value).toBe('Older words. Newer words.');
  saveAnswer = null;
  const field = floaterBox()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    field.focus();
    setter.call(field, `${field.value} Floated.`);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await until(() => (drafts.get(ONE)?.body ?? '').includes('Floated.'), 'the floating save', 2000);
  expect(drafts.get(ONE)?.body).toBe('Older words. Newer words. Floated.');
  expect(el.querySelector('[data-draft-conflict]') === null).toBe(true);
});

/** Keys typed at the end of the floating window's words. */
function typeInFloater(words: string) {
  const field = floaterBox()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    field.focus();
    setter.call(field, `${field.value}${words}`);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('words that did not land stay when another box of the thread saves other words: their next try is the conflict, never lost or saved over', async () => {
  saveElsewhere(ONE, 'Older words.');
  const el = await open();
  await until(() => box(el)?.value === 'Older words.', 'the draft back in the box');
  // The thread's floating window, open from before: it shows the older draft.
  await openFloater();
  await until(() => floaterBox()?.value === 'Older words.' && floaterBox()!.readOnly === false, 'the floating box');
  saveAnswer = noNetwork;
  typeOn(el, ' Newer words.');
  await until(() => el.querySelector('[data-draft-failed]') !== null, '"Not saved"');
  await closeBox(el);
  saveAnswer = null;
  typeInFloater(' From the corner.');
  await until(() => drafts.get(ONE)?.body === 'Older words. From the corner.', 'the floating save');
  // The words the pane's box typed still wait.
  expect(replyDraftUnsaved()).toBe(true);
  window.dispatchEvent(new Event('online'));
  await settle(6);
  expect(drafts.get(ONE)?.body).toBe('Older words. From the corner.');
  await reply(el);
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  expect(box(el)!.value).toBe('Older words. Newer words.');
  await act(async () => conflictButton(el, 'Keep mine').click());
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'Keep mine saved');
});

/** Another page's entry, as that page keeps it (`at`: when its words last changed). */
function keptByPage(page: string, thread: string, kept: { kind: 'conflict' | 'failed' | 'remote'; words: string; base: string | null }, at = Date.now()) {
  localStorage.setItem(`plannotator-inbox-reply-kept:${page}:${thread}`, JSON.stringify({ ...kept, thread, page, at }));
}
/** The browser's Web Locks, as the pages holding theirs say (`open`: the page ids still open). */
function locksHeldBy(open: () => string[]): () => void {
  const had = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: () => new Promise(() => {}), query: async () => ({ held: open().map((page) => ({ name: `plannotator-inbox-reply-kept-page:${page}` })), pending: [] }) },
  });
  return () => (had ? Object.defineProperty(navigator, 'locks', had) : delete (navigator as unknown as { locks?: unknown }).locks);
}

test.skipIf(!hasDom)("two tabs: another tab still open keeps its words; once it is gone, a new page takes them back", async () => {
  saveElsewhere(ONE, 'Older words.');
  const base = drafts.get(ONE)!.updated_at;
  keptByPage('tab-two', ONE, { kind: 'failed', words: 'Older words. From tab two.', base });
  let tabsOpen = ['tab-two'];
  const restore = locksHeldBy(() => tabsOpen);
  try {
    const el = await open();
    await settle(4);
    expect((box(el)?.value ?? '').includes('From tab two.')).toBe(false);
    expect(saves.length).toBe(0);
    expect(keptInBrowser().length).toBe(1);
    // Tab two is gone (closed, crashed or ended by the browser).
    tabsOpen = [];
    const next = await newPageAfterTabEnded();
    await until(() => drafts.get(ONE)?.body === 'Older words. From tab two.', 'its words saved on the draft they were typed over');
    await until(() => box(next)?.value === 'Older words. From tab two.', 'its words in the box');
  } finally {
    restore();
  }
});

test.skipIf(!hasDom)('kept words older than 14 days go as a page loads; words the draft holds now go without a conflict', async () => {
  saveElsewhere(ONE, 'Older words. And the iPad went on.');
  keptByPage('gone-a', ONE, { kind: 'failed', words: 'Older words.', base: 'x' });
  keptByPage('gone-b', TWO, { kind: 'failed', words: 'Weeks old.', base: null }, Date.now() - 15 * 24 * 60 * 60 * 1000);
  const el = await open();
  await settle(6);
  expect(el.querySelector('[data-draft-conflict]') === null).toBe(true);
  expect(el.querySelector('[data-draft-failed]') === null).toBe(true);
  expect(box(el)?.value).toBe('Older words. And the iPad went on.');
  expect(keptInBrowser()).toEqual([]);
  expect(saves.length).toBe(0);
});

test.skipIf(!hasDom)('kept words with no base come back "Not saved" and are never saved on their own; the next key saves them', async () => {
  keptByPage('gone', ONE, { kind: 'failed', words: 'Typed before the tab ended.', base: null });
  const el = await open();
  await until(() => box(el)?.value === 'Typed before the tab ended.', 'the words back in the box');
  await until(() => el.querySelector('[data-draft-failed]') !== null, '"Not saved"');
  window.dispatchEvent(new Event('online'));
  await settle(6);
  expect(saves.length).toBe(0);
  typeOn(el, ' Then a key.');
  await until(() => drafts.get(ONE)?.body === 'Typed before the tab ended. Then a key.', 'saved by the key');
  await until(() => !replyDraftUnsaved(), 'nothing left unsaved');
});

test.skipIf(!hasDom)('the words kept in the browser are capped: 20 entries and 200 KB at most, the oldest go first', async () => {
  for (let i = 0; i < 25; i += 1) keepWords(`thr_${i}`, { kind: 'failed', words: `Words ${i}.`, base: null });
  expect(keptInBrowser().length).toBe(20);
  expect(keptInBrowser().some((key) => key.endsWith(':thr_0'))).toBe(false);
  expect(keptInBrowser().some((key) => key.endsWith(':thr_24'))).toBe(true);
  for (let i = 0; i < 5; i += 1) keepWords(`big_${i}`, { kind: 'failed', words: 'w'.repeat(60_000), base: null });
  const size = keptInBrowser().reduce((sum, key) => sum + key.length + (localStorage.getItem(key)?.length ?? 0), 0);
  expect(size <= 200_000).toBe(true);
  expect(keptInBrowser().some((key) => key.endsWith(':big_4'))).toBe(true);
  // A full storage keeps nothing more, and says nothing.
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  try {
    expect(() => keepWords('thr_full', { kind: 'failed', words: 'More.', base: null })).not.toThrow();
  } finally {
    Storage.prototype.setItem = setItem;
  }
});

test.skipIf(!hasDom)("another computer's words kept by a gone page, for a thread opened before it is known as that computer's: they come back once it is", async () => {
  const MAC = `ibx_01K${'0'.repeat(22)}M`;
  keptByPage('gone', TWO, { kind: 'remote', words: 'Words for the Mac mini thread.', base: null });
  try {
    const el = await open(TWO);
    await settle(4);
    rememberMachine([TWO], MAC);
    act(() => draw(TWO));
    await settle(4);
    await reply(el);
    expect(box(el)!.value).toBe('Words for the Mac mini thread.');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-reply-discard]')!.click());
    await settle(2);
  } finally {
    resetMachineRoutes();
  }
});

test.skipIf(!hasDom)('the page hidden while a save is on its way: the words typed since go after it, and no false conflict shows', async () => {
  const el = await open();
  await reply(el);
  let letGo!: () => void;
  const held = new Promise<void>((done) => (letGo = done));
  let started = false;
  saveAnswer = async (thread, body) => {
    if (!started) {
      started = true;
      await held;
    }
    return storeSave(thread, body);
  };
  try {
    typeOn(el, 'Words on their way.');
    await until(() => started, 'the first save on its way');
    typeOn(el, ' Then more.');
    // A desktop tab switch with that save still on its way.
    pageVisibility('hidden');
    await settle(2);
    letGo();
    await until(() => drafts.get(ONE)?.body === 'Words on their way. Then more.', 'both saved, in order', 2000);
    pageVisibility('visible');
    await settle(4);
    expect(el.querySelector('[data-draft-conflict]') === null).toBe(true);
    expect(box(el)!.value).toBe('Words on their way. Then more.');
  } finally {
    pageVisibility('visible');
  }
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

test.skipIf(!hasDom)('the page hidden inside the pause with the Inbox out of reach, then the tab ended: a new page has the words back, "Not saved", and saves them', async () => {
  saveElsewhere(ONE, 'Older words.');
  const el = await open();
  await until(() => box(el)?.value === 'Older words.', 'the draft back in the box');
  try {
    // The computer is asleep: the save sent as the phone hides the page (a keepalive) does not land.
    saveAnswer = noNetwork;
    typeOn(el, ' Typed on the phone.');
    pageVisibility('hidden');
    await settle(2);
    expect(drafts.get(ONE)?.body).toBe('Older words.');
    const next = await newPageAfterTabEnded();
    pageVisibility('visible');
    await until(() => box(next)?.value === 'Older words. Typed on the phone.', 'the words back in the box');
    await until(() => next.querySelector('[data-draft-failed]') !== null, '"Not saved"');
    saveAnswer = null;
    window.dispatchEvent(new Event('online'));
    await until(() => drafts.get(ONE)?.body === 'Older words. Typed on the phone.', 'saved');
    await until(() => !replyDraftUnsaved(), 'nothing left unsaved');
    expect(keptInBrowser()).toEqual([]);
  } finally {
    pageVisibility('visible');
  }
});

/**
 * A save on the Inbox whose answer is slow, newer words queued behind it (and, `typing`, more waiting for the pause in
 * typing), then a reload: the page goes. After all of it the Inbox holds the newest words and a new page shows them.
 */
async function goneWithSavesOnTheirWay(typing: boolean) {
  saveElsewhere(ONE, 'Older words.');
  const el = await open();
  await until(() => box(el)?.value === 'Older words.', 'the draft back in the box');
  let answer!: () => void;
  const slow = new Promise<void>((done) => (answer = done));
  let first = true;
  saveAnswer = async (thread, body) => {
    // Each save lands on the Inbox as it comes; the first one's answer is slow.
    const landed = storeSave(thread, body);
    if (first) {
      first = false;
      await slow;
    }
    return landed;
  };
  typeOn(el, ' One.');
  await until(() => drafts.get(ONE)?.body === 'Older words. One.', 'the first save on the Inbox');
  typeOn(el, ' Two.');
  // Past the pause in typing: its save waits behind the first.
  await settle(4, 200);
  if (typing) typeOn(el, ' Three.');
  const newest = typing ? 'Older words. One. Two. Three.' : 'Older words. One. Two.';
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await settle(2);
  const next = await newPageAfterTabEnded();
  await until(() => box(next)?.value === newest, 'the newest words in the box');
  // The gone page's slow answer comes (a real browser runs nothing after it): what that page still sends reaches no Inbox.
  saveAnswer = () => Response.json({ draft: null });
  answer();
  await until(() => !replyDraftUnsaved(), 'nothing left on its way');
  expect(drafts.get(ONE)?.body).toBe(newest);
  expect(keptInBrowser()).toEqual([]);
}

test.skipIf(!hasDom)('a reload with a save on its way, newer words queued behind it and more typed: the newest words are never lost', async () => {
  await goneWithSavesOnTheirWay(true);
});

test.skipIf(!hasDom)('a reload with a save on its way and newer words queued behind it: the newest words are never lost', async () => {
  await goneWithSavesOnTheirWay(false);
});

/** The browser's Web Locks, slow to say which pages are open (`letGo`): words a gone page kept come back late. */
function slowLocks(): { letGo: () => void; restore: () => void } {
  let letGo!: () => void;
  const answered = new Promise<void>((done) => (letGo = done));
  const restore = locksHeldBy(() => []);
  const value = { request: () => new Promise(() => {}), query: async () => (await answered, { held: [], pending: [] }) };
  Object.defineProperty(navigator, 'locks', { configurable: true, value });
  return { letGo, restore };
}

/**
 * Words a gone page kept (`kind`), a slow first read, and the person types in the box before it answers; `late`: they
 * typed even before the kept words were back. The box holds both, the kept words first; returns the pane.
 */
async function keptBackWhileTyping(kind: 'failed' | 'conflict', late: boolean): Promise<HTMLElement> {
  saveElsewhere(ONE, kind === 'failed' ? 'Older words.' : 'The iPad wrote this.');
  keptByPage('gone', ONE, { kind, words: 'Older words. Newer words.', base: drafts.get(ONE)!.updated_at });
  let letGo!: () => void;
  readHeld = new Promise<void>((done) => (letGo = done));
  const locks = late ? slowLocks() : null;
  try {
    const el = await open();
    await reply(el);
    typeOn(el, late ? 'Thanks.' : ' And k.');
    await settle(4, 200);
    locks?.letGo();
    await settle(2);
    letGo();
    readHeld = null;
    await until(() => (box(el)?.value ?? '').includes('Older words. Newer words.'), 'the kept words in the box');
    expect(box(el)!.value.includes(late ? 'Thanks.' : 'And k.')).toBe(true);
    return el;
  } finally {
    locks?.restore();
  }
}

test.skipIf(!hasDom)('words a gone page kept that did not land, a slow first read, and a key typed: both are in the box and saved', async () => {
  const el = await keptBackWhileTyping('failed', false);
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words. And k.', 'both saved');
  expect(box(el)!.value).toBe('Older words. Newer words. And k.');
  await until(() => !replyDraftUnsaved() && keptInBrowser().length === 0, 'nothing left unsaved');
  expect(el.querySelector('[data-draft-failed]') === null).toBe(true);
});

test.skipIf(!hasDom)('words a gone page kept that did not land, back only after the person typed: the box takes them first, then the typed words, and saves both', async () => {
  const el = await keptBackWhileTyping('failed', true);
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.\n\nThanks.', 'both saved');
  expect(box(el)!.value).toBe('Older words. Newer words.\n\nThanks.');
  await until(() => !replyDraftUnsaved() && keptInBrowser().length === 0, 'nothing left unsaved');
});

/** After keptBackWhileTyping('conflict', …): the choice shows, the other draft stays, and the next key and Keep mine keep both. */
async function keptConflictHolds(el: HTMLElement, typed: string) {
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  expect(drafts.get(ONE)?.body).toBe('The iPad wrote this.');
  typeOn(el, ' k');
  await settle(2);
  await act(async () => conflictButton(el, 'Keep mine').click());
  await until(() => (drafts.get(ONE)?.body ?? '').includes('Older words. Newer words.'), 'Keep mine saved');
  expect(drafts.get(ONE)!.body.includes(`${typed} k`)).toBe(true);
  await until(() => !replyDraftUnsaved() && keptInBrowser().length === 0, 'nothing left unsaved');
}

test.skipIf(!hasDom)("a conflict's words a gone page kept, a slow first read, and a key typed: the next keys and Keep mine keep them", async () => {
  await keptConflictHolds(await keptBackWhileTyping('conflict', false), 'And k.');
});

test.skipIf(!hasDom)("a conflict's words a gone page kept, back only after the person typed: the box takes them first, and Keep mine keeps both", async () => {
  const el = await keptBackWhileTyping('conflict', true);
  expect(box(el)!.value).toBe('Older words. Newer words.\n\nThanks.');
  await keptConflictHolds(el, 'Thanks.');
});

test.skipIf(!hasDom)('no Web Locks: another tab whose heartbeat is fresh keeps its words; once it is older than 30 s, a new page takes them back', async () => {
  expect(!!(navigator as unknown as { locks?: unknown }).locks).toBe(false);
  saveElsewhere(ONE, 'Older words.');
  keptByPage('tab-two', ONE, { kind: 'failed', words: 'Older words. From tab two.', base: drafts.get(ONE)!.updated_at });
  localStorage.setItem(`${ALIVE}tab-two`, String(Date.now() - 5_000));
  const el = await open();
  await settle(4);
  expect((box(el)?.value ?? '').includes('From tab two.')).toBe(false);
  expect(saves.length).toBe(0);
  expect(keptInBrowser().length).toBe(1);
  // Tab two stops (ended while it sat hidden): its heartbeat ages past 30 s.
  const next = await newPageAfterTabEnded();
  await until(() => drafts.get(ONE)?.body === 'Older words. From tab two.', 'its words saved on the draft they were typed over');
  await until(() => box(next)?.value === 'Older words. From tab two.', 'its words in the box');
});

test.skipIf(!hasDom)('no Web Locks: a page keeping words says it is open, again as the back/forward cache gives it back, and no more once it goes', async () => {
  await typedThenFailed(noNetwork);
  const page = keptInBrowser()[0]!.split(':')[1]!;
  const fresh = () => Date.now() - Number(localStorage.getItem(`${ALIVE}${page}`) ?? 0) < 30_000;
  expect(fresh()).toBe(true);
  // Frozen in the back/forward cache a while, then shown again.
  localStorage.setItem(`${ALIVE}${page}`, String(Date.now() - 60_000));
  act(() => {
    window.dispatchEvent(Object.defineProperty(new Event('pageshow'), 'persisted', { value: true }));
  });
  expect(fresh()).toBe(true);
  // A reload: the page goes for good, so the next page takes its words at once.
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(localStorage.getItem(`${ALIVE}${page}`)).toBe(null);
  const next = await newPageAfterTabEnded(ONE, false);
  await until(() => box(next)?.value === 'Older words. Newer words.', 'the words back in the box');
  saveAnswer = null;
  window.dispatchEvent(new Event('online'));
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'saved');
  await until(() => !replyDraftUnsaved() && keptInBrowser().length === 0, 'nothing left unsaved');
});

/** A phone with the Inbox out of reach: "Ship it" typed, its save did not land, and "Not saved" shows. */
async function shipItNotSaved(): Promise<HTMLElement> {
  const el = await open();
  await reply(el);
  saveAnswer = noNetwork;
  typeOn(el, 'Ship it');
  await until(() => el.querySelector('[data-draft-failed]') !== null, '"Not saved"');
  return el;
}
/** The words this browser keeps for its threads now. */
const keptWordsHere = () => keptInBrowser().map((key) => (JSON.parse(localStorage.getItem(key)!) as { words: string }).words);
/** The page shown again with no `visibilitychange` (the page that hid is gone). */
const visibleAgain = () => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });

test.skipIf(!hasDom)('words typed on after ones that did not land, the page gone inside the pause, its keepalive lost: a new page has the newer words back, "Not saved"', async () => {
  const el = await shipItNotSaved();
  typeOn(el, ' tomorrow.');
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(keptWordsHere()).toEqual(['Ship it tomorrow.']);
  await settle(2);
  const next = await newPageAfterTabEnded();
  await until(() => box(next)?.value === 'Ship it tomorrow.', 'the newer words back in the box');
  await until(() => next.querySelector('[data-draft-failed]') !== null, '"Not saved"');
  saveAnswer = null;
  typeOn(next, ' OK');
  await until(() => drafts.get(ONE)?.body === 'Ship it tomorrow. OK', 'saved');
  await until(() => !replyDraftUnsaved() && keptInBrowser().length === 0, 'nothing left unsaved');
});

test.skipIf(!hasDom)('words typed on after ones that did not land, the page hidden with a save on its way, and the tab ended: a new page has the newest words back', async () => {
  const el = await shipItNotSaved();
  let answer!: () => void;
  const slow = new Promise<void>((done) => (answer = done));
  // The Inbox takes the next save and never answers it while the page lives.
  saveAnswer = async () => (await slow, Response.json({ draft: null }));
  try {
    typeOn(el, ' tomorrow');
    // Past the pause in typing: its save is on its way.
    await settle(4, 200);
    typeOn(el, '.');
    pageVisibility('hidden');
    expect(keptWordsHere()).toEqual(['Ship it tomorrow.']);
  } finally {
    visibleAgain();
  }
  const next = await newPageAfterTabEnded();
  await until(() => box(next)?.value === 'Ship it tomorrow.', 'the newest words back in the box');
  saveAnswer = null;
  typeOn(next, ' OK');
  await until(() => drafts.get(ONE)?.body === 'Ship it tomorrow. OK', 'saved');
  // The gone page's save answers (a real browser runs nothing after it): what that page still sends reaches no Inbox.
  saveAnswer = () => Response.json({ draft: null });
  answer();
  await until(() => !replyDraftUnsaved(), 'nothing left on its way');
  expect(drafts.get(ONE)?.body).toBe('Ship it tomorrow. OK');
});

test.skipIf(!hasDom)('words typed on after ones that did not land, sent as the page hid and landed: kept in the browser meanwhile, and nothing comes back once read back', async () => {
  const el = await shipItNotSaved();
  saveAnswer = null;
  try {
    typeOn(el, ' tomorrow.');
    pageVisibility('hidden');
    await until(() => drafts.get(ONE)?.body === 'Ship it tomorrow.', 'the keepalive landed', 300);
    expect(keptWordsHere()).toEqual(['Ship it tomorrow.']);
    pageVisibility('visible');
    await until(() => keptInBrowser().length === 0, 'the kept words let go once read back');
    await until(() => !replyDraftUnsaved(), 'nothing left unsaved');
    expect(el.querySelector('[data-draft-failed]') === null).toBe(true);
  } finally {
    visibleAgain();
  }
  const next = await newPageAfterTabEnded();
  await until(() => box(next)?.value === 'Ship it tomorrow.', 'the saved draft in the box');
  await settle(4);
  expect(next.querySelector('[data-draft-failed]') === null).toBe(true);
  expect(keptInBrowser()).toEqual([]);
  expect(drafts.get(ONE)?.body).toBe('Ship it tomorrow.');
});
