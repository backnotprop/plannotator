/**
 * Assertions compare strings, never elements: a failed `expect(element)` makes bun print a happy-dom node, which can
 * take the test process down instead of failing the test.
 *
 * The reply box's markup holds still while it moves: out of Thread.tsx into its own view (components/reply/ReplyBox.tsx),
 * and later into @plannotator/ui for a second host. The failure this catches: a move that drops, adds or reorders an
 * element, a class, a data attribute, an aria name or a test id the window, its CSS or its tests rely on. For each state
 * the thread's foot (`.ib-pfoot`) is reached by the same steps over a scripted Inbox, and its outerHTML must equal, byte
 * for byte, what the window drew before the move (replyBoxParity/<state>.html, captured on main at 8c44d1050). Two
 * things are normalized first: React's useId numbers (a page-wide counter) and a clock time ("Saved 4:51 PM"), which
 * follows the machine's time zone.
 *
 * A change to the reply box made on purpose writes them again: REPLYBOX_PARITY_WRITE=1 with DOM_TESTS=1.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableSession } from '../../api';
import type { Signal } from '../../signal';
import type { VoiceAnswer, VoiceDeps } from '../../voiceSession';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('../Thread') : {}) as typeof import('../Thread');
const { replyDraftUnsaved, resetReplyDraftPageForTests } = (hasDom ? await import('../../replyDraft') : {}) as typeof import('../../replyDraft');
const { createSignal } = (hasDom ? await import('../../signal') : {}) as typeof import('../../signal');
const { adoptVoiceSettings, browserDeps } = (hasDom ? await import('../../voice') : {}) as typeof import('../../voice');

const FIXTURES = join(import.meta.dir, 'replyBoxParity');
const WRITE = process.env.REPLYBOX_PARITY_WRITE === '1';

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T09:00:00.000Z' };
const CLAUDE: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_claude', name: null };
const PI: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'pi', session: 'ses_pi', name: null };
const ONE = 'msg_01M6RF0000000000000000001';
const TWO = 'msg_01M6RF0000000000000000002';
const STAMP = '2026-11-02T10:10:00.000Z';

function message(id: string, author: InboxAuthor, minute: number): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: ONE,
    reply_to: id === ONE ? null : ONE,
    author,
    subject: id === ONE ? 'Retry worker' : null,
    body: id === ONE ? 'The retry loop backs off two, four and eight seconds.' : 'Pi checked the totals.',
    created_at: `2026-11-02T10:0${minute}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
  } as InboxMessageWire;
}

/** One agent wrote (the usual thread), or (`two`) a second agent wrote after it: the box names who gets the reply. */
const threadOf = (two = false): InboxThread => ({
  thread_id: ONE,
  project: PROJECT,
  subject: 'Retry worker',
  thread_name: null,
  resolved_at: null,
  messages: two ? [message(ONE, CLAUDE, 1), message(TWO, PI, 2)] : [message(ONE, CLAUDE, 1)],
});

function tagged(session: string, host: string): TaggableSession {
  return { session, host, kind: 'live', name: null, project: PROJECT, started_at: null, last_at: '2026-11-02T10:50:00.000Z', busy: false, idle_since: null, taggable: true, owner: false, wrote_thread: true };
}

/** The scripted Inbox's drafts, by thread, with the server's compare-and-set (as replyDraftNeverLost.test.tsx). */
let drafts = new Map<string, InboxReplyDraft>();
/** How a draft save is answered instead of the store's own (null: the store's). */
let saveAnswer: (() => Response) | null = null;
let taggable: TaggableSession[] = [];
let clock = 0;
let root: Root | null = null;
let host: HTMLElement | null = null;
let signal: Signal;
let restore: (() => void)[] = [];
/** The scripted recorder's clock tick and transcription answer (voiceKeptWords.test.tsx). */
let tick: (() => void) | null = null;
let voiceClock = 1000;
let answer: ((value: VoiceAnswer) => void) | null = null;

function saveElsewhere(thread: string, body: string, files?: InboxReplyDraft['files']) {
  clock += 1;
  const kept = files ?? drafts.get(thread)?.files;
  drafts.set(thread, { v: 1, thread_id: thread, body, created_at: STAMP, updated_at: new Date(Date.UTC(2026, 10, 2, 11, 0, clock)).toISOString(), ...(kept ? { files: kept } : {}) });
}

function storeSave(thread: string, input: Record<string, unknown>): Response {
  const current = drafts.get(thread) ?? null;
  const base = (input.base as string | null | undefined) ?? null;
  if ((current?.updated_at ?? null) !== base && !(current && typeof input.base_body === 'string' && current.body === input.base_body)) {
    return Response.json({ error: 'The draft changed.', code: 'draft_conflict', draft: current }, { status: 409 });
  }
  const body = String(input.body ?? '');
  if (body === '' && !current?.files?.length) {
    drafts.delete(thread);
    return Response.json({ draft: null });
  }
  saveElsewhere(thread, body);
  return Response.json({ draft: drafts.get(thread) });
}

const noNetwork = (): Response => {
  throw new TypeError('Failed to fetch');
};

beforeEach(() => {
  if (!hasDom) return;
  drafts = new Map();
  saveAnswer = null;
  taggable = [];
  clock = 0;
  signal = createSignal();
  tick = null;
  answer = null;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const draftPath = /\/threads\/([^/]+)\/draft$/.exec(path.split('?')[0]!);
    if (draftPath) {
      const thread = decodeURIComponent(draftPath[1]!);
      if (init?.method === 'POST') return saveAnswer ? saveAnswer() : storeSave(thread, JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ serverSession: 's', draft: drafts.get(thread) ?? null });
    }
    if (/\/draft\/delete$/.test(path)) {
      drafts.delete(ONE);
      return Response.json({ ok: true, deleted: true });
    }
    if (path.includes('/voice/status')) return Response.json({ state: 'ready', plan: null });
    if (path.includes('/taggable')) return Response.json({ serverSession: 's', owner: null, sessions: taggable });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const sessions = taggable.map((t) => ({ session: t.session, host: t.host, started_at: t.last_at, last_seen_at: t.last_at, busy: false, idle_since: null, wrote_thread: true }));
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions });
    }
    return Response.json({});
  }) as typeof fetch;
  // Voice on, with a scripted recorder: the mic is in every state's row, and one state records.
  const deps: Partial<VoiceDeps> = {
    open: async () => ({ rate: 24_000, db: () => -20, stop: async () => [new Float32Array(2400).fill(0.2)], abort: () => {}, onEnded: () => {} }),
    prompts: async () => false,
    transcribe: () => new Promise<VoiceAnswer>((resolve) => (answer = resolve)),
    now: () => voiceClock,
    every: (_ms, run) => {
      tick = run;
      return () => (tick = null);
    },
    after: () => () => {},
  };
  const had = { ...browserDeps };
  Object.assign(browserDeps, deps);
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({}) } });
  const hadWorklet = (globalThis as Record<string, unknown>).AudioWorkletNode;
  (globalThis as Record<string, unknown>).AudioWorkletNode = class {};
  adoptVoiceSettings({ on: true, phones_only: false, engine: 'codex', key: { source: null, last4: null }, computer: null, intro_due: false });
  restore = [
    () => {
      Object.assign(browserDeps, had);
      globalThis.fetch = savedFetch;
      (globalThis as Record<string, unknown>).AudioWorkletNode = hadWorklet;
      for (const [owner, name] of [[window, 'isSecureContext'], [navigator, 'mediaDevices']] as const) delete (owner as unknown as Record<string, unknown>)[name];
      adoptVoiceSettings(null);
    },
  ];
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  saveAnswer = null;
  for (let i = 0; i < 100 && replyDraftUnsaved(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const left = replyDraftUnsaved();
  while (restore.length > 0) restore.pop()!();
  // Each test starts on a page of its own: nothing one leaves can change what the next one draws.
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

function draw(id: string, { two = false, phone = false } = {}) {
  const thread = id === ONE ? threadOf(two) : { ...threadOf(), thread_id: id, messages: threadOf().messages.map((m) => ({ ...m, id, thread_id: id })) };
  root!.render(
    <div className="pn-inbox">
      <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} draftSignal={signal} phone={phone} />
    </div>,
  );
}

async function open(options: { two?: boolean; phone?: boolean } = {}): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(ONE, options);
  });
  await settle();
  return host;
}

const box = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea');

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
    text.dispatchEvent(new KeyboardEvent('keyup', { key: next.slice(-1) || 'a', bubbles: true }));
  });
}

async function press(el: HTMLElement, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await settle(2, 10);
}

/** React's useId numbers (`_r_1f_`) in order of first appearance, and clock times, made the same on every run. */
function normalized(html: string): string {
  const ids = new Map<string, string>();
  return html
    .replace(/_r_[0-9a-v]+_/g, (id) => {
      if (!ids.has(id)) ids.set(id, `_r_${ids.size}_`);
      return ids.get(id)!;
    })
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?[\s ]?[AaPp][Mm]\b/g, '<time>');
}

/** The thread's foot as drawn now, against what main drew in the same state (or written, under REPLYBOX_PARITY_WRITE). */
async function same(el: HTMLElement, state: string) {
  await settle(3);
  const foot = el.querySelector('.ib-pfoot');
  expect(!!foot).toBe(true);
  const html = `${normalized(foot!.outerHTML)}\n`;
  const file = join(FIXTURES, `${state}.html`);
  if (WRITE) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, html);
    return;
  }
  expect(existsSync(file)).toBe(true);
  expect(html).toBe(readFileSync(file, 'utf8'));
}

test('normalized: useId numbers follow their first appearance, and a clock time is one token', () => {
  expect(normalized('<a id="_r_1f_" aria-labelledby="_r_1f_ _r_2_">Saved 4:51 PM</a><b id="_r_2_">10:03 am</b>')).toBe('<a id="_r_0_" aria-labelledby="_r_0_ _r_1_">Saved <time></a><b id="_r_1_"><time></b>');
});

test.skipIf(!hasDom)('the foot with the box closed and nothing kept', async () => {
  const el = await open();
  await same(el, 'closed-empty');
});

test.skipIf(!hasDom)('the box open and empty', async () => {
  const el = await open();
  await reply(el);
  await same(el, 'open-empty');
});

test.skipIf(!hasDom)('the box holding words, saved', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Ship it on Friday.');
  await until(() => drafts.get(ONE)?.body === 'Ship it on Friday.', 'the save');
  await same(el, 'open-words');
});

test.skipIf(!hasDom)('the box closed with words kept: Send and Edit draft', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Ship it on Friday.');
  await until(() => drafts.get(ONE)?.body === 'Ship it on Friday.', 'the save');
  await press(box(el)!, 'Escape');
  await until(() => box(el) === null, 'the box closed');
  await same(el, 'closed-kept');
});

test.skipIf(!hasDom)('a saved draft waiting: Restore draft above the box', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Started on the Mac.');
  await until(() => drafts.get(ONE)?.body === 'Started on the Mac.', 'the first save');
  saveElsewhere(ONE, 'Started on the Mac. Added on the iPad.');
  await act(async () => signal.emit());
  await until(() => el.querySelector('[data-draft-restore]') !== null, 'the offer');
  await same(el, 'offer');
  // Its next key takes the offer in and saves both: nothing is left waiting.
  typeOn(el, ' More.');
  await until(() => drafts.get(ONE)?.body === 'Started on the Mac. Added on the iPad. More.', 'both saved');
});

test.skipIf(!hasDom)('a save that did not land: "Not saved" over the row', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Older words.');
  await until(() => drafts.get(ONE)?.body === 'Older words.', 'the first save');
  saveAnswer = noNetwork;
  typeOn(el, ' Newer words.');
  await until(() => el.querySelector('[data-draft-failed]') !== null, '"Not saved"');
  await same(el, 'not-saved');
  saveAnswer = null;
  window.dispatchEvent(new Event('online'));
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'saved once the page is online');
});

test.skipIf(!hasDom)('a conflict: its line, Keep mine and Discard mine, and the bin says "Discard my words"', async () => {
  const el = await open();
  await reply(el);
  typeOn(el, 'Older words.');
  await until(() => drafts.get(ONE)?.body === 'Older words.', 'the first save');
  saveAnswer = noNetwork;
  typeOn(el, ' Newer words.');
  await until(() => el.querySelector('[data-draft-failed]') !== null, '"Not saved"');
  act(() => draw(TWO));
  await settle();
  saveAnswer = null;
  saveElsewhere(ONE, 'The iPad wrote this.');
  act(() => draw(ONE));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  await same(el, 'conflict');
  act(() => [...el.querySelectorAll<HTMLButtonElement>('[data-draft-conflict] button')].find((b) => b.textContent === 'Keep mine')!.click());
  await until(() => drafts.get(ONE)?.body === 'Older words. Newer words.', 'Keep mine saved');
});

test.skipIf(!hasDom)('a file in the box: its tile under the words', async () => {
  saveElsewhere(ONE, 'The export is attached.', [{ upload_id: 'upl_01', name: 'export.csv', size: 2048, kind: 'file', sha256: 'a'.repeat(64), created_at: STAMP }]);
  const el = await open();
  await until(() => box(el)?.value === 'The export is attached.', 'the draft back in the box');
  await until(() => el.querySelector('[data-reply-files]') !== null, 'the file tile');
  await same(el, 'file-tile');
});

test.skipIf(!hasDom)('two agents: the recipient chip, a second agent ticked ("2 agents"), and an @tag in the words', async () => {
  taggable = [tagged('ses_claude', 'claude-code'), tagged('ses_pi', 'pi')];
  const el = await open({ two: true });
  await reply(el);
  await settle(3, 30);
  typeOn(el, 'Both of you, please.');
  await settle();
  const pill = () => el.querySelector<HTMLButtonElement>('[data-recipient]');
  await until(() => pill() !== null, 'the recipient chip');
  act(() => pill()!.click());
  await settle();
  act(() => el.querySelector<HTMLButtonElement>('[data-recipient-tick="ses_claude"]')!.click());
  await settle();
  expect(pill()!.querySelector('.ib-rto-full')?.textContent ?? '').toBe('2 agents');
  await press(box(el)!, 'Escape');
  await settle();
  typeOn(el, ' @pi');
  await settle(2, 20);
  await press(box(el)!, 'ArrowDown');
  await press(box(el)!, 'Enter');
  await settle(3, 30);
  await same(el, 'recipient-tag');
  await until(() => !replyDraftUnsaved(), 'the words saved');
});

test.skipIf(!hasDom)('recording a voice note: the mic and its status line', async () => {
  const el = await open();
  await reply(el);
  const mic = el.querySelector('.ib-rbox [data-voice-mic]');
  expect(!!mic).toBe(true);
  const pointer = (type: 'pointerdown' | 'pointerup') => act(() => void mic!.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1 })));
  pointer('pointerdown');
  await settle();
  expect(tick !== null).toBe(true);
  for (let i = 0; i < 12; i += 1) {
    voiceClock += 40;
    act(() => tick?.());
  }
  await same(el, 'voice-recording');
  pointer('pointerup');
  await settle();
  await until(() => answer !== null, 'the take sent to be transcribed');
  await act(async () => answer!({ text: 'Said into the mic.' }));
  await until(() => (drafts.get(ONE)?.body ?? '').includes('Said into the mic.'), 'the words saved');
});

test.skipIf(!hasDom)('a phone: the Draft line above the box, the summary line and the row', async () => {
  const el = await open({ phone: true });
  await reply(el);
  typeOn(el, 'Ship it on Friday.');
  await until(() => drafts.get(ONE)?.body === 'Ship it on Friday.', 'the save');
  await until(() => el.querySelector('[data-draft-stamp]') !== null, 'the Draft line');
  await same(el, 'phone-words');
});

test.skipIf(!hasDom)('a phone with two agents: who gets the reply in the row', async () => {
  taggable = [tagged('ses_claude', 'claude-code'), tagged('ses_pi', 'pi')];
  const el = await open({ two: true, phone: true });
  await reply(el);
  await settle(3, 30);
  await same(el, 'phone-recipient');
});
