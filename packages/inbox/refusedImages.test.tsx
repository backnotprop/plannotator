/**
 * Images the Inbox refuses to serve, drawn quietly. An agent's message may
 * name an image the message image route refuses: one in a hidden folder of
 * the home folder (403 image_hidden), one that is not there (404). The
 * window used to draw a broken-image icon for each. What regresses if this
 * fails: a refused image in the message text, an `<img>` in a raw-HTML block,
 * a question card's `Shows:` picture or its picture choices stays a broken
 * `<img>`, or the image that does load stops looking and opening as before.
 *
 * The message is sent to a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts) and read back through its own route.
 * happy-dom loads no image on its own (the page's URL is that Inbox, so it
 * fires nothing by itself), so each image's URL is asked of the server and
 * the `<img>` gets the `load` or `error` event a browser fires for that
 * answer. tests/e2e/inbox-picture-choices.spec.ts proves it in real browsers.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { inboxImageSrcResolver, inboxMessageImageBase, inboxMessageImageUrl } from './images';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const Viewer = (hasDom ? (await import('@plannotator/ui/components/Viewer')).Viewer : null) as typeof import('@plannotator/ui/components/Viewer')['Viewer'];

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let child: ReturnType<typeof Bun.spawn> | null = null;
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let buffered = '';
let port = 0;
let project = '';
let dir = '';
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedUrl = '';

function loopback(path: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    req.end();
  });
}

async function nextLine(): Promise<string> {
  while (!buffered.includes('\n')) {
    const { value, done } = await reader!.read();
    if (done) throw new Error('the Inbox stopped');
    buffered += new TextDecoder().decode(value);
  }
  const at = buffered.indexOf('\n');
  const line = buffered.slice(0, at);
  buffered = buffered.slice(at + 1);
  return line;
}

async function command<T>(value: unknown): Promise<T> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify(value)}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return JSON.parse(await nextLine()) as T;
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-refused-images-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  // Outside the project: a hidden folder of the home folder (HOME is `dir`) the route refuses, and a plain folder it serves.
  mkdirSync(join(dir, '.secret'), { recursive: true });
  mkdirSync(join(dir, 'pub'));
  for (const name of ['shot.png', 'raw.png', 'both.png', 'a.png']) writeFileSync(join(dir, '.secret', name), PNG);
  writeFileSync(join(dir, 'pub', 'ok.png'), PNG);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await nextLine()) as { port: number; worlds: { project: string }[] };
  port = started.port;
  project = started.worlds[0]!.project;
});

afterAll(async () => {
  if (!hasDom) return;
  reader?.releaseLock();
  child?.kill();
  await child?.exited;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetImageSrcResolver();
  if (savedUrl) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(savedUrl);
  savedUrl = '';
});

/**
 * Each `<img>` gets the event a browser fires for the Inbox's real answer to
 * its URL (`load` for 200, `error` otherwise), until none is left to settle;
 * returns the statuses by src.
 */
async function settleImages(el: HTMLElement): Promise<Map<string, number>> {
  const statuses = new Map<string, number>();
  for (let round = 0; round < 5; round += 1) {
    const pending = [...el.querySelectorAll<HTMLImageElement>('img')].filter((img) => !img.hidden).filter((img) => !statuses.has(img.getAttribute('src')!) || statuses.get(img.getAttribute('src')!) !== 200);
    if (pending.length === 0) break;
    for (const img of pending) {
      const src = img.getAttribute('src')!;
      if (!statuses.has(src)) statuses.set(src, (await loopback(src)).status);
      if (!img.isConnected) continue;
      await act(async () => {
        img.dispatchEvent(new Event(statuses.get(src) === 200 ? 'load' : 'error'));
      });
    }
  }
  return statuses;
}

test.skipIf(!hasDom)('images the Inbox refuses show as their alt text; the card falls back to text rows; the image that loads is as before', async () => {
  setImageSrcResolver(inboxImageSrcResolver);
  const hidden = (name: string) => join(dir, '.secret', name);
  const ok = join(dir, 'pub', 'ok.png');
  const body = [
    'Here is the run.',
    '',
    `![Hidden shot](${hidden('shot.png')})`,
    '',
    `![Fine shot](${ok})`,
    '',
    `![Gone shot](${join(dir, 'gone', 'missing.png')})`,
    '',
    `<p><img src="${hidden('raw.png')}" alt="Raw hidden"></p>`,
    '',
    ':::question',
    'Which drawer should ship?',
    `Shows: ![Both drawers](${hidden('both.png')})`,
    '',
    `- [ ] A · Total on top — ![Drawer A](${hidden('a.png')})`,
    `- [ ] B · Total pinned — ![Drawer B](${join(dir, 'gone', 'b.png')})`,
    ':::',
  ].join('\n');
  const { sent } = await command<{ sent: string }>({ send: { project, session: 'ses_refused', body } });
  const { thread } = JSON.parse((await loopback(`/api/inbox/threads/${sent}`)).text) as { thread: InboxThread };
  const message = thread.messages.find((m) => m.id === sent) as InboxMessageWire;

  savedUrl = window.location.href;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`);
  host = document.createElement('div');
  document.body.appendChild(host);
  const opened: string[] = [];
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={message}
        projectRoot={join(dir, 'projects')}
        onOpenAttachment={() => {}}
        onOpenInlineImage={(image) => opened.push(image.ref)}
        readOnly={false}
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
      />,
    );
  });
  // Every image loads from the message's own route, as before (the URLs are unchanged).
  const okUrl = inboxMessageImageUrl(sent, ok);
  expect(host.querySelector(`img[alt="Fine shot"]`)!.getAttribute('src')).toBe(okUrl);
  // The route really refuses the others: the hidden folder is 403 image_hidden, the missing file 404.
  const refused = await loopback(inboxMessageImageUrl(sent, hidden('shot.png')));
  expect(refused.status).toBe(403);
  expect(JSON.parse(refused.text).code).toBe('image_hidden');
  expect((await loopback(inboxMessageImageUrl(sent, join(dir, 'gone', 'missing.png')))).status).toBe(404);
  expect((await loopback(okUrl)).status).toBe(200);

  const statuses = await settleImages(host);
  expect(statuses.get(okUrl)).toBe(200);
  expect([...statuses.values()].filter((status) => status === 403 || status === 404)).toHaveLength(statuses.size - 1);

  // No <img> stays broken: the only one drawn is the image that loaded (ui keeps a failed
  // markdown <img> in place, hidden and unnamed, so React never inserts before moved text).
  expect([...host.querySelectorAll('img')].filter((img) => !img.hidden).map((img) => img.getAttribute('src'))).toEqual([okUrl]);
  expect([...host.querySelectorAll('img')].filter((img) => img.hidden).every((img) => img.alt === '' && img.getAttribute('aria-hidden') === 'true')).toBe(true);
  const chips = [...host.querySelectorAll('[data-image-unavailable]')].map((chip) => chip.textContent);
  expect(chips).toEqual(expect.arrayContaining(['Hidden shot', 'Gone shot', 'Raw hidden']));
  // A text comment never quotes a chip's alt text.
  expect([...host.querySelectorAll('[data-image-unavailable]')].every((chip) => chip.classList.contains('annotation-exclude'))).toBe(true);
  // The card: Shows is its label, and the choices are text rows with their plain labels.
  const shows = host.querySelector<HTMLElement>('[data-question-shows]')!;
  expect(shows.querySelector('img')).toBeNull();
  expect(shows.textContent).toContain('Both drawers');
  expect(host.querySelector('[data-question-tile]')).toBeNull();
  const rows = [...host.querySelectorAll('label[data-question-option]')].map((r) => r.querySelector('[data-question-part="choice"] > span')!.textContent);
  expect(rows).toEqual(['A · Total on top', 'B · Total pinned']);

  // The image that loads is drawn as a bare Viewer draws it, and still opens.
  const fine = host.querySelector<HTMLImageElement>('img[alt="Fine shot"]')!;
  expect(fine.getAttribute('role')).toBe('button');
  const plain = document.createElement('div');
  document.body.appendChild(plain);
  const plainRoot = createRoot(plain);
  const plainBody = `![Fine shot](${ok})`;
  await act(async () => {
    plainRoot.render(
      <Viewer
        blocks={parseMarkdownToBlocks(plainBody, { frontmatter: false })}
        markdown={plainBody}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        maxWidth={null}
        stickyActions={false}
        disableCodePathValidation
        imageBaseDir={inboxMessageImageBase(sent)}
        answerOnly
        readOnly
      />,
    );
  });
  const bare = plain.querySelector<HTMLImageElement>('img')!;
  for (const attribute of ['src', 'alt', 'class', 'loading', 'data-image-src']) expect(fine.getAttribute(attribute)).toBe(bare.getAttribute(attribute));
  act(() => plainRoot.unmount());
  plain.remove();
  await act(async () => fine.click());
  // Not captured yet (the store captures on a later read): the plain lightbox shows it.
  expect(opened.length > 0 || document.body.querySelector('[data-image-lightbox]') !== null).toBe(true);
  // A refused image's chip opens nothing.
  const lightboxes = document.body.querySelectorAll('[data-image-lightbox]').length;
  await act(async () => host!.querySelector<HTMLElement>('[data-image-unavailable]')!.click());
  expect(document.body.querySelectorAll('[data-image-lightbox]').length).toBe(lightboxes);
});
