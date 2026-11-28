/**
 * A picture an agent names before it writes the file (`![chart](media/late.png)`, then the file) shows in the open
 * thread once it is there, without a reload (parts/MessageBody/PictureRetry.tsx over ui's `ImageRetryContext`).
 * What regresses if this fails: the picture stays the dashed chip until the thread is opened again, when its
 * message's record gains the captured picture, when the thread gains a message, or with no new message at all; or
 * a picture that keeps failing is asked for without end, or one that loaded is asked for again; or an old thread full
 * of missing pictures is asked for again on a timer or on each new message, more than four at a time, or a body with
 * only a remote failed picture keeps watching the thread.
 *
 * The page's URL is a loopback stand-in for the Inbox's image route that answers 404 until a picture is "written",
 * then a 1×1 GIF; happy-dom loads images for real here (its `enableImageFileLoading`, restored after).
 * The browser proof is tests/e2e/inbox-inline-media.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { act, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { InboxInlineImage, InboxMessageWire } from '@plannotator/core/inbox-types';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { inboxImageSrcResolver } from './images';
import { createInboxQueryClient } from './data/client';
import { inboxKeys } from './data/keys';
import { setPictureRetryDelaysForTests } from './parts/MessageBody/PictureRetry';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (c) => c.charCodeAt(0));
const written = new Set<string>();
const asked: string[] = [];
/** How long the stand-in waits before it answers, and the most requests it had open at once. */
let answerAfterMs = 0;
let open = 0;
let mostOpen = 0;
let server: Server | null = null;
let savedUrl = '';
type HappyDom = { setURL: (url: string) => void; settings: { enableImageFileLoading: boolean } };
const happy = () => (window as unknown as { happyDOM: HappyDom }).happyDOM;
let savedLoading = false;

beforeAll(async () => {
  if (!hasDom) return;
  // node:http, not Bun.serve: happy-dom's fetch (node:http under Bun) cannot parse Bun.serve's answers.
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.searchParams.get('path') ?? url.pathname;
    asked.push(path);
    open += 1;
    mostOpen = Math.max(mostOpen, open);
    setTimeout(() => {
      open -= 1;
      if (written.has(path)) res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': GIF.length }).end(GIF);
      else res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"image_missing"}');
    }, answerAfterMs);
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  savedUrl = window.location.href;
  happy().setURL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  savedLoading = happy().settings.enableImageFileLoading;
  happy().settings.enableImageFileLoading = true;
});
afterAll(() => {
  if (!hasDom) return;
  happy().settings.enableImageFileLoading = savedLoading;
  if (savedUrl) happy().setURL(savedUrl);
  server?.close();
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient | null = null;
beforeEach(() => {
  written.clear();
  asked.length = 0;
  answerAfterMs = 0;
  mostOpen = 0;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  client = null;
  resetImageSrcResolver();
  setPictureRetryDelaysForTests(null);
  delete (document as unknown as { visibilityState?: string }).visibilityState;
  happy().settings.enableImageFileLoading = true;
});

const ID = 'msg_01K7LLLLLLLLLLLLLLLLLLLLLL';
const THREAD = 'msg_01K7TTTTTTTTTTTTTTTTTTTTTT';
const REF = 'media/late.png';

/** Sent just now unless said: only a recent message's pictures are tried on a timer or a new message. */
function message(id: string, body: string, inline: InboxInlineImage[] = [], createdAt = new Date().toISOString()): InboxMessageWire {
  return {
    id,
    project_id: 'prj_01K7PPPPPPPPPPPPPPPPPPPPPP',
    thread_id: THREAD,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' },
    subject: 'Export',
    body,
    created_at: createdAt,
    resolved_at: null,
    idempotency_key: null,
    inline_images: inline,
    questions: [],
  } as unknown as InboxMessageWire;
}

const captured: InboxInlineImage = {
  id: 'att_01K7CCCCCCCCCCCCCCCCCCCCCC',
  ref: REF,
  path: `/work/shop/${REF}`,
  named_path: null,
  name: 'late.png',
  kind: 'image',
  sent_sha256: 'a'.repeat(64),
  size: 10,
  sent_at: '2026-11-22T02:00:01.000Z',
  sent_mtime: '2026-11-22T02:00:01.000Z',
  media_type: 'image/png',
  width: 1,
  height: 1,
} as InboxInlineImage;

const BODY = `The export chart:\n\n![Export chart](${REF})`;

async function draw(inline: InboxInlineImage[] = [], { body = BODY, createdAt, after }: { body?: string; createdAt?: string; after?: ReactNode } = {}) {
  setImageSrcResolver(inboxImageSrcResolver);
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    client ??= createInboxQueryClient();
    await act(async () => {
      root = createRoot(host!);
    });
  }
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MessageBody message={message(ID, body, inline, createdAt)} projectRoot="/work/shop" onOpenAttachment={() => {}} readOnly={false} answers={new Map()} onPick={() => {}} footerFor={() => null} />
        {after}
      </QueryClientProvider>,
    );
  });
}

const chip = () => host!.querySelector('[data-image-unavailable]');
const picture = () => host!.querySelector<HTMLImageElement>('img[data-image-src]')!;
const shown = () => !chip() && !picture().hidden && picture().complete && picture().naturalWidth === 1;

async function until(what: string, ok: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 10));
    });
  }
}
/** Time passing, in short steps: an `act` flushes its updates only when it ends, as a browser would on each task. */
async function settle(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) await act(async () => void (await new Promise((done) => setTimeout(done, 10))));
}

async function failedOnce() {
  await until('the chip for the missing picture', () => chip()?.textContent === 'Export chart');
  expect(picture().hidden).toBe(true);
}

test.skipIf(!hasDom)('a picture that failed shows once its message gains the captured record, and opens again as a button', async () => {
  setPictureRetryDelaysForTests([]);
  await draw();
  await failedOnce();
  written.add(REF);
  await settle(100);
  // Nothing changed for the window yet: still the chip.
  expect(chip()).not.toBeNull();
  // The Inbox captured it (a later read of the thread): the record arrives with the thread.
  await draw([captured]);
  await until('the picture drawn', shown);
  expect(picture().getAttribute('role')).toBe('button');
  expect(picture().getAttribute('aria-label')).toBe('Open late.png, Export chart');
  expect(picture().getAttribute('data-inline-image')).toBe(captured.id);
});

test.skipIf(!hasDom)('a picture that failed is tried again when its thread gains a message', async () => {
  setPictureRetryDelaysForTests([60_000]);
  client = createInboxQueryClient();
  const first = message(ID, BODY);
  client.setQueryData(inboxKeys.thread(THREAD), { serverSession: 's', cursor: 1, thread: { messages: [first] } });
  await draw();
  await failedOnce();
  written.add(REF);
  // The same thread again (a read that changed nothing): no new message, no new try.
  await act(async () => void client!.setQueryData(inboxKeys.thread(THREAD), { serverSession: 's', cursor: 2, thread: { messages: [first] } }));
  await settle(100);
  expect(chip()).not.toBeNull();
  await act(async () => void client!.setQueryData(inboxKeys.thread(THREAD), { serverSession: 's', cursor: 3, thread: { messages: [first, message('msg_01K7NNNNNNNNNNNNNNNNNNNNNN', 'Written now.')] } }));
  await until('the picture drawn', shown);
});

test.skipIf(!hasDom)('with no new message, a failed picture is tried again on its own a bounded number of times, then no more', async () => {
  setPictureRetryDelaysForTests([150, 150]);
  await draw();
  await failedOnce();
  await settle(50);
  const before = asked.length;
  // Two tries, both still missing.
  await settle(600);
  expect(asked.length - before).toBe(2);
  expect(chip()).not.toBeNull();
  // Then no more on the timer: written now, it waits for the thread to change.
  written.add(REF);
  await settle(400);
  expect(chip()).not.toBeNull();
  expect(asked.length - before).toBe(2);
});

test.skipIf(!hasDom)('a picture written after its message shows on the timer; a hidden window waits until it is seen', async () => {
  setPictureRetryDelaysForTests([40, 40, 40]);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  await draw();
  await failedOnce();
  await settle(50);
  const before = asked.length;
  written.add(REF);
  await settle(300);
  expect(chip()).not.toBeNull();
  expect(asked.length).toBe(before);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
  await until('the picture drawn', shown);
  expect(picture().getAttribute('role')).toBe('button');
});

test.skipIf(!hasDom)('a picture that loaded is not asked for again', async () => {
  setPictureRetryDelaysForTests([20, 20, 20]);
  written.add(REF);
  await draw();
  await until('the picture drawn', shown);
  await settle(50);
  const before = asked.length;
  await settle(200);
  expect(asked.length).toBe(before);
});

/** The thread's held copy with the first message and `more` after it (ids by index, or as given). */
function holdThread(more: (string | number)[]) {
  const messages = [message(ID, BODY), ...more.map((n) => message(typeof n === 'string' ? n : `msg_01K7NNNNNNNNNNNNNNNNNNNN${String(n).padStart(2, '0')}`, 'More.'))];
  act(() => void client!.setQueryData(inboxKeys.thread(THREAD), { serverSession: 's', cursor: messages.length, thread: { messages } }));
}
const hidden = (yes: boolean) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (yes ? 'hidden' : 'visible') });

test.skipIf(!hasDom)('an old message is never asked again on a timer or a new message; its captured record still shows it', async () => {
  setPictureRetryDelaysForTests([40, 40, 40]);
  client = createInboxQueryClient();
  holdThread([]);
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  await draw([], { createdAt: old });
  await failedOnce();
  await settle(50);
  const before = asked.length;
  written.add(REF);
  await settle(250);
  holdThread([1]);
  holdThread([1, 2]);
  await settle(150);
  expect(asked.length).toBe(before);
  expect(chip()).not.toBeNull();
  // The Inbox captured it: that redraws a message of any age.
  await draw([captured], { createdAt: old });
  await until('the picture drawn', shown);
});

test.skipIf(!hasDom)('a new message is a try of the same budget as the timer, a held reply replaced by its saved copy is no new message', async () => {
  setPictureRetryDelaysForTests([60_000, 60_000]);
  client = createInboxQueryClient();
  holdThread([]);
  await draw();
  await failedOnce();
  await settle(50);
  const before = asked.length;
  // A reply held as sent, then its saved copy under its real id: one message gained, one try.
  holdThread(['msg_01K7HELDHELDHELDHELDHELDHE']);
  await settle(100);
  holdThread(['msg_01K7SAVEDSAVEDSAVEDSAVEDSA']);
  await settle(100);
  expect(asked.length - before).toBe(1);
  holdThread(['msg_01K7SAVEDSAVEDSAVEDSAVEDSA', 2]);
  await settle(100);
  expect(asked.length - before).toBe(2);
  // Both tries spent: no more on a new message.
  holdThread(['msg_01K7SAVEDSAVEDSAVEDSAVEDSA', 2, 3]);
  await settle(150);
  expect(asked.length - before).toBe(2);
  expect(chip()).not.toBeNull();
});

test.skipIf(!hasDom)('new messages while the window is hidden make one try when it is shown', async () => {
  setPictureRetryDelaysForTests([60_000, 60_000, 60_000]);
  client = createInboxQueryClient();
  holdThread([]);
  await draw();
  await failedOnce();
  await settle(50);
  const before = asked.length;
  hidden(true);
  holdThread([1]);
  holdThread([1, 2]);
  await settle(150);
  expect(asked.length).toBe(before);
  hidden(false);
  await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
  await settle(150);
  expect(asked.length - before).toBe(1);
  expect(chip()).not.toBeNull();
});

test.skipIf(!hasDom)('a body whose only failed picture is a remote one keeps no watch on its thread', async () => {
  setPictureRetryDelaysForTests([40, 40, 40]);
  client = createInboxQueryClient();
  holdThread([]);
  const remote = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/remote.png`;
  await draw([], { body: `A remote chart:\n\n![Remote chart](${remote})` });
  await until('the chip for the remote picture', () => chip()?.textContent === 'Remote chart');
  await settle(200);
  expect(client.getQueryCache().hasListeners()).toBe(false);
});

test.skipIf(!hasDom)('a picture that failed before the body listened is still tried again', async () => {
  setPictureRetryDelaysForTests([40]);
  // Its error comes before the window's own effects run (a long render): stood in for by a later sibling's layout effect.
  happy().settings.enableImageFileLoading = false;
  client = createInboxQueryClient();
  function FailsFirst() {
    useLayoutEffect(() => void host!.querySelector('img[data-image-src]')?.dispatchEvent(new Event('error')), []);
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
  });
  await draw([], { after: <FailsFirst /> });
  await failedOnce();
  happy().settings.enableImageFileLoading = true;
  written.add(REF);
  await until('the picture drawn', shown);
});

test.skipIf(!hasDom)('a try over many failed pictures asks for at most four at a time', async () => {
  // One try, after every picture has failed.
  setPictureRetryDelaysForTests([300]);
  const refs = Array.from({ length: 10 }, (_, i) => `media/late-${i}.png`);
  await draw([], { body: refs.map((ref, i) => `![Chart ${i}](${ref})`).join('\n\n') });
  await until('every chip', () => host!.querySelectorAll('[data-image-unavailable]').length === 10);
  await settle(50);
  answerAfterMs = 60;
  mostOpen = 0;
  const before = asked.length;
  await until('the try asked for every picture', () => asked.length - before === 10, 3000);
  await settle(150);
  expect(mostOpen).toBeLessThanOrEqual(4);
  expect(mostOpen).toBeGreaterThan(1);
});
