/**
 * A comment on a linked computer's message that its Inbox has not confirmed yet (linked machines, rule 12): the
 * write waits in this Inbox's outbox (`202`), and the thread's foot says "Sending to Laptop: this applies once Laptop
 * confirms." That is a status, not a failure: the owner saw it in red above Send and read it as broken.
 *
 * Failures to catch: the held sentence drawn as an error (the red `.ib-error`, `role="alert"`), on the foot or under
 * full screen's composer (`.ib-fcomp-err`); a real failure no longer drawn as one, or cleared by another write's
 * frame; the status still there after the outbox says the other computer took it (also when the outbox's whole
 * re-read already dropped it before the pane looked), or gone while a later held write still waits; a refusal said
 * twice (the foot's red line beside the thread's own "Not delivered … · Dismiss") or not said at all where the thread
 * shows nothing for that write; a held answer of one thread showing on the next thread the pane opens; the status not
 * announced (its polite region not kept mounted), or a refusal taking its place not announced as a new alert.
 *
 * Driven through the real ThreadPane, ui Viewer and web-highlighter; fetch is stubbed, no Inbox server. DOM-gated
 * (DOM_TESTS=1), listed in tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-attachments';
import type { InboxAuthor, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { MachineView, OutboxView } from './api';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';
import { outboxRead, threadOutbox } from './machines';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { resetComposerState } = (hasDom ? await import('./fullScreenComposer') : {}) as typeof import('./fullScreenComposer');

const LAPTOP_ID = `ibx_01K${'0'.repeat(22)}P`;
const PROJECT: InboxProject = { id: 'prj_far', key: 'fern-api-abcdef', name: 'fern-api', root: '/work/fern-api', created_at: '2026-11-20T09:00:00.000Z' };
const AGENT: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const M1 = 'msg_01KHELDFOOTLINE00000000001';
const M2 = 'msg_01KHELDFOOTLINE00000000002';
const WORDS = 'move the retry into the harbor client';
const OTHER = 'keep the rest as it is';
const BODY = `I would ${WORDS} and ${OTHER}.`;
const SENDING = 'Sending to Laptop: this applies once Laptop confirms.';
const WAITING = 'Waiting for Laptop: this applies when Laptop is back.';
const REFUSED = 'Not delivered: That message was archived.';
const IMAGE: InboxAttachmentState = {
  id: 'att_01KHELDFOOTLINE000000000IM',
  message_id: M1,
  path: '/work/fern-api/shot.png',
  named_path: null,
  name: 'shot.png',
  kind: 'image',
  sent_sha256: 'a'.repeat(64),
  size: 68,
  sent_at: '2026-11-20T10:15:00.000Z',
  sent_mtime: '2026-11-20T10:15:00.000Z',
  media_type: 'image/png',
  width: 1,
  height: 1,
  current: { sha256: 'a'.repeat(64), size: 68, mtime: '2026-11-20T10:15:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

const laptop = (state: MachineView['state'] = 'online'): MachineView => ({
  id: LAPTOP_ID,
  name: 'Laptop',
  self: false,
  state,
  since: '2026-11-20T10:00:00.000Z',
  reason: null,
  version: '0.29.7',
  address: null,
  both_ways: true,
  waiting: 0,
  message_deletions: true,
});

const threadOf = (id: string, subject: string, image = false): InboxThread => ({
  thread_id: id,
  project: PROJECT,
  subject,
  thread_name: null,
  resolved_at: null,
  messages: [
    {
      id,
      project_id: PROJECT.id,
      thread_id: id,
      reply_to: null,
      author: AGENT,
      subject,
      body: BODY,
      created_at: '2026-11-20T10:15:00.000Z',
      resolved_at: null,
      idempotency_key: null,
      seq: 1,
      questions: [],
      ...(image ? { attachments: [IMAGE] } : {}),
    },
  ],
});
const model = threadOf(M1, 'Retry');

/** An outbox entry; `route` defaults to a comment on M1's words (the thread shows that write when it does not land). */
const entry = (key: string, state: OutboxView['state'], route = `messages/${M1}/annotations`, thread: string | null = M1): OutboxView => ({
  key,
  machine: LAPTOP_ID,
  route,
  thread,
  state,
  queued_at: '2026-11-20T10:50:00.000Z',
  settled_at: state === 'queued' ? null : '2026-11-20T11:00:00.000Z',
  status: state === 'refused' ? 409 : state === 'delivered' ? 200 : null,
  answer: state === 'refused' ? { error: 'That message was archived.' } : null,
  notice: state === 'refused' ? { kind: 'refused', at: '2026-11-20T11:00:00.000Z' } : null,
  dismissed: false,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts = 0;
/** How the next save is answered: held for Laptop (as it is, or asleep), refused here, or held once `release` runs. */
let answer: 'held' | 'held-asleep' | 'refused' | 'later' = 'held';
let release: (() => void) | null = null;
let image = false;

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  posts = 0;
  answer = 'held';
  release = null;
  image = false;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/annotations') && init?.method === 'POST') {
      posts += 1;
      const held = () => Response.json({ outbox: entry(`k${posts}`, 'queued'), machine: laptop(answer === 'held-asleep' ? 'offline' : 'online') }, { status: 202 });
      if (answer === 'refused') return Response.json({ error: 'That message was archived.', code: 'message_closed' }, { status: 409 });
      if (answer === 'later') return new Promise<Response>((resolve) => (release = () => resolve(held())));
      return held();
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: image ? [IMAGE] : [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  resetComposerState();
  globalThis.fetch = savedFetch;
  resetMachineRoutes();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

type Shown = { thread?: InboxThread; machine?: MachineView; file?: { id: string; version: 'current'; focus: null; view: 'full' } | null };
let shown: Shown = {};
/** The window's outbox, every entry by key; the pane's own list is the slice the window gives it (ThreadSlot). */
function draw(outbox: ReadonlyMap<string, OutboxView>, next: Shown = shown) {
  shown = next;
  const thread = next.thread ?? model;
  root!.render(
    <ThreadPane thread={thread} machine={next.machine ?? laptop()} outbox={threadOutbox(outbox, thread)} outboxAll={outbox} onDismissOutbox={() => draw(new Map())} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={next.file ?? null} onOpenFile={() => {}} onOpenGuide={() => {}} />,
  );
}
const frame = async (outbox: ReadonlyMap<string, OutboxView>, next?: Shown) => {
  act(() => draw(outbox, next));
  await settle();
};

async function render(next: Shown = {}) {
  rememberMachine([M1, M2], LAPTOP_ID);
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    draw(new Map(), next);
  });
  await settle();
  return host;
}

/** Select `phrase` in the message the way a drag does, and press the toolbar's Delete (it saves at once). */
async function deleteWords(scope: HTMLElement, phrase: string, id = M1) {
  const body = scope.querySelector<HTMLElement>(`[data-message-id="${id}"][data-text-comments]`)!;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  const at = node!.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node!, at);
  range.setEnd(node!, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node!.parentElement!.closest('article') ?? body).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
  await act(async () => document.querySelector<HTMLButtonElement>('.annotation-toolbar button[aria-label="Delete"], .annotation-toolbar button[title="Delete"]')!.click());
  await settle();
  await settle();
}

const having = (selector: string, words: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.textContent?.includes(words));
/** Red: the foot's error line, full screen's error line, or any alert. */
const errorWith = (words: string) => having('.ib-error, .ib-fcomp-err, [role="alert"]', words).length;
/** The calm held line where the foot's line goes (the thread's own held-write look), and what the polite region says. */
const heldLine = (words: string) => having('.ib-delivered[data-foot-held]', words).filter((el) => !el.closest('.ib-error, [role="alert"]'));
const announced = () => document.querySelector<HTMLElement>('[role="status"][data-foot-held-live]');
/** Everywhere the words are drawn as their own line (the foot's, the thread's held writes, full screen's). */
const linesWith = (words: string) => having('.ib-error, .ib-fcomp-err, .ib-delivered', words).length;

test.skipIf(!hasDom)('a comment held for Laptop reads as a status, is announced, and goes once Laptop confirms it', async () => {
  const el = await render();
  expect(announced()?.textContent).toBe('');
  await deleteWords(el, WORDS);
  expect(posts).toBe(1);
  expect(heldLine(SENDING).length).toBe(1);
  expect(errorWith(SENDING)).toBe(0);
  // The thread's own held writes' look: on its way while Laptop is online (the send mark, as the thread draws it).
  expect(heldLine(SENDING)[0]!.querySelector('svg')?.getAttribute('data-icon')).toBe('send');
  expect(announced()?.textContent).toBe(SENDING);

  await frame(new Map([['k1', entry('k1', 'queued')]]));
  expect(heldLine(SENDING).length).toBe(1);
  await frame(new Map([['k1', entry('k1', 'delivered')]]));
  expect(linesWith(SENDING)).toBe(0);
  expect(announced()?.textContent).toBe('');
});

test.skipIf(!hasDom)('refused on Laptop: said once, by the thread\'s own "Not delivered … · Dismiss", and Dismiss takes it all', async () => {
  answer = 'held-asleep';
  const el = await render({ machine: laptop('offline') });
  await deleteWords(el, WORDS);
  expect(heldLine(WAITING).length).toBe(1);
  expect(heldLine(WAITING)[0]!.querySelector('svg')?.getAttribute('data-icon')).toBe('clock');
  expect(errorWith(WAITING)).toBe(0);

  await frame(new Map([['k1', entry('k1', 'refused')]]));
  expect(linesWith(WAITING)).toBe(0);
  expect(linesWith(REFUSED)).toBe(1);
  expect(errorWith(REFUSED)).toBe(0);
  const dismiss = document.querySelector<HTMLButtonElement>('[data-outbox="k1"] [data-outbox-dismiss]')!;
  await act(async () => dismiss.click());
  await settle();
  expect(linesWith(REFUSED)).toBe(0);
});

test.skipIf(!hasDom)('refused where the thread shows nothing for it (a file\'s comment): the foot says it, as a new alert', async () => {
  const el = await render();
  await deleteWords(el, WORDS);
  const status = heldLine(SENDING)[0]!;
  // A file's comment is written on `annotations/…`, with no thread named: the thread draws no line for it.
  await frame(new Map([['k1', entry('k1', 'refused', 'annotations/ann_1/remove', null)]]));
  expect(linesWith(SENDING)).toBe(0);
  const alert = document.querySelector<HTMLElement>('.ib-error[role="alert"]');
  expect(alert?.textContent).toBe(REFUSED);
  expect(linesWith(REFUSED)).toBe(1);
  // Not the status's node turned red: a new alert, which a screen reader announces.
  expect(status.isConnected).toBe(false);
  expect(announced()?.textContent).toBe('');
});

test.skipIf(!hasDom)("a real failure on Laptop's message is an error, and a held write's frame after it leaves it", async () => {
  const el = await render();
  await deleteWords(el, WORDS);
  expect(heldLine(SENDING).length).toBe(1);
  answer = 'refused';
  await deleteWords(el, OTHER);
  expect(document.querySelector('.ib-error[role="alert"]')?.textContent).toBe('That message was archived.');
  expect(linesWith(SENDING)).toBe(0);
  await frame(new Map([['k1', entry('k1', 'delivered')]]));
  expect(document.querySelector('.ib-error[role="alert"]')?.textContent).toBe('That message was archived.');
});

test.skipIf(!hasDom)('two comments held: the status stays until the last one settles', async () => {
  const el = await render();
  await deleteWords(el, WORDS);
  await frame(new Map([['k1', entry('k1', 'queued')]]));
  await deleteWords(el, OTHER);
  expect(posts).toBe(2);
  await frame(new Map([['k1', entry('k1', 'queued')], ['k2', entry('k2', 'queued')]]));
  await frame(new Map([['k1', entry('k1', 'delivered')], ['k2', entry('k2', 'queued')]]));
  expect(heldLine(SENDING).length).toBe(1);
  await frame(new Map([['k1', entry('k1', 'delivered')], ['k2', entry('k2', 'delivered')]]));
  expect(linesWith(SENDING)).toBe(0);
});

test.skipIf(!hasDom)('settled before the pane first saw it: gone once a whole read asked after the write leaves it out', async () => {
  const el = await render();
  await deleteWords(el, WORDS);
  // A frame about another write: the held one may not have reached this window yet. It stays.
  await frame(new Map([['k9', entry('k9', 'queued')]]));
  expect(heldLine(SENDING).length).toBe(1);
  // A whole read asked before the write cannot know it either.
  await frame(outboxRead(new Map([['k9', entry('k9', 'queued')]]), performance.now() - 60_000));
  expect(heldLine(SENDING).length).toBe(1);
  // Asked after it: everything still waiting or refused is in it, so this one landed.
  await frame(outboxRead(new Map([['k9', entry('k9', 'queued')]]), performance.now()));
  expect(linesWith(SENDING)).toBe(0);
});

test.skipIf(!hasDom)('another thread in the same pane: nothing of the last thread\'s held comment acts there', async () => {
  answer = 'later';
  const el = await render();
  await deleteWords(el, WORDS);
  expect(release).not.toBeNull();
  const other = threadOf(M2, 'Harbor');
  await frame(new Map(), { thread: other });
  // The first thread's write is answered "held" only now, while the other thread shows.
  await act(async () => release!());
  await settle();
  expect(linesWith(SENDING)).toBe(0);
  expect(announced()?.textContent).toBe('');
  await frame(new Map([['k1', entry('k1', 'refused')]]), { thread: other });
  expect(linesWith(REFUSED)).toBe(0);
});

test.skipIf(!hasDom)("full screen's composer shows the held comment as the same status, never in red", async () => {
  image = true;
  const withImage = threadOf(M1, 'Retry', true);
  const el = await render({ thread: withImage });
  await deleteWords(el, WORDS);
  expect(heldLine(SENDING).length).toBe(1);
  await frame(new Map(), { thread: withImage, file: { id: IMAGE.id, version: 'current', focus: null, view: 'full' } });
  const card = document.querySelector<HTMLElement>('[data-fcomp]');
  expect(card).not.toBeNull();
  const reply = card!.querySelector<HTMLButtonElement>('[data-fcomp-mode="reply"]');
  if (reply && reply.getAttribute('aria-checked') !== 'true') await act(async () => reply.click());
  await settle();
  expect(card!.querySelector('.ib-fcomp-err')).toBeNull();
  expect(errorWith(SENDING)).toBe(0);
  expect(card!.querySelector('.ib-delivered[data-foot-held="card"]')?.textContent).toBe(SENDING);
});
