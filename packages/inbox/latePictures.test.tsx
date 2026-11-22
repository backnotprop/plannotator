/**
 * A picture an agent names before it writes the file (`![chart](media/late.png)`, then the file) shows in the open
 * thread once it is there, without a reload (parts/MessageBody/PictureRetry.tsx over ui's `ImageRetryContext`).
 * What regresses if this fails: the picture stays the dashed chip until the thread is opened again, when its
 * message's record gains the captured picture, when the thread gains a message, or with no new message at all; or
 * a picture that keeps failing is asked for without end, or one that loaded is asked for again.
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
import { act } from 'react';
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
let server: Server | null = null;
let savedUrl = '';
type HappyDom = { setURL: (url: string) => void; settings: { enableImageFileLoading: boolean } };
const happy = () => (window as unknown as { happyDOM: HappyDom }).happyDOM;
let savedLoading = false;

beforeAll(async () => {
  if (!hasDom) return;
  // node:http, not Bun.serve: happy-dom's fetch (node:http under Bun) cannot parse Bun.serve's answers.
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('path') ?? '';
    asked.push(path);
    if (written.has(path)) res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': GIF.length }).end(GIF);
    else res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"image_missing"}');
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
});

const ID = 'msg_01K7LLLLLLLLLLLLLLLLLLLLLL';
const THREAD = 'msg_01K7TTTTTTTTTTTTTTTTTTTTTT';
const REF = 'media/late.png';

function message(id: string, body: string, inline: InboxInlineImage[] = []): InboxMessageWire {
  return {
    id,
    project_id: 'prj_01K7PPPPPPPPPPPPPPPPPPPPPP',
    thread_id: THREAD,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' },
    subject: 'Export',
    body,
    created_at: '2026-11-22T02:00:00.000Z',
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

async function draw(inline: InboxInlineImage[] = []) {
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
        <MessageBody message={message(ID, BODY, inline)} projectRoot="/work/shop" onOpenAttachment={() => {}} readOnly={false} answers={new Map()} onPick={() => {}} footerFor={() => null} />
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
  setPictureRetryDelaysForTests([]);
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
