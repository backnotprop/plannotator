/**
 * The Inbox's text size (owner's request, 2026-10-18: "a setting where I can
 * just set it, it's default 14, but I could also go to 13 or 15 or even 12").
 * Settings → General → Appearance → Text size, 12 / 13 / 14 / 15, scales the
 * window's whole type ramp from the body size at once, and is kept in
 * config.json `inboxTextSize`.
 *
 * The whole window (InboxApp) over a REAL Inbox server in a temp data dir
 * (tests/helpers/inbox-dom-server.ts). What a size draws is worked out from
 * inbox.css by cssCascade.testing.ts (happy-dom computes no custom-property
 * arithmetic), then the resolved `max()` / `calc()` evaluated here. The two
 * things measured are a list row's subject and a message body's paragraph
 * (ui's Viewer, `text-[15px]`, which follows the Inbox through inbox.css's
 * `ib-type` layer).
 *
 * The failure this catches: a pick that does not reach the type (the
 * property not set, a rule that does not read it), a pick that is not kept,
 * 14 drawing anything but today's sizes, and config.json's size not adopted
 * on load.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadCascade } from './cssCascade.testing';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { resetInboxTextSizeForTests, TEXT_SIZE_PROPERTY } = (hasDom ? await import('./textSize') : {}) as typeof import('./textSize');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const CSS = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let thread = '';
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

const configPath = () => join(dir!, 'data', 'config.json');
function sizeOnDisk(): unknown {
  if (!existsSync(configPath())) return undefined;
  return (JSON.parse(readFileSync(configPath(), 'utf8')) as { inboxTextSize?: unknown }).inboxTextSize;
}
function writeSizeOnDisk(size: number | undefined) {
  const current = existsSync(configPath()) ? (JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>) : {};
  if (size === undefined) delete current.inboxTextSize;
  else current.inboxTextSize = size;
  writeFileSync(configPath(), JSON.stringify(current, null, 2));
}

/** A resolved CSS length (px, rem at 16 px, plain numbers, calc / max / min with + - * /) in px. */
function px(value: string): number {
  let i = 0;
  const src = value.trim();
  const space = () => {
    while (src[i] === ' ') i++;
  };
  const expr = (): number => {
    let left = term();
    for (space(); src[i] === '+' || src[i] === '-'; space()) {
      const op = src[i++]!;
      const right = term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const term = (): number => {
    let left = factor();
    for (space(); src[i] === '*' || src[i] === '/'; space()) {
      const op = src[i++]!;
      const right = factor();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };
  const args = (): number[] => {
    const out = [expr()];
    for (space(); src[i] === ','; space()) {
      i++;
      out.push(expr());
    }
    space();
    if (src[i++] !== ')') throw new Error(`unclosed in ${value}`);
    return out;
  };
  const factor = (): number => {
    space();
    for (const [name, fn] of [
      ['calc(', (xs: number[]) => xs[0]!],
      ['max(', (xs: number[]) => Math.max(...xs)],
      ['min(', (xs: number[]) => Math.min(...xs)],
    ] as const) {
      if (src.startsWith(name, i)) {
        i += name.length;
        return fn(args());
      }
    }
    if (src[i] === '(') {
      i++;
      return args()[0]!;
    }
    const m = /^-?\d+(?:\.\d+)?(px|rem)?/.exec(src.slice(i));
    if (!m) throw new Error(`cannot read ${src.slice(i)} in ${value}`);
    i += m[0].length;
    const n = parseFloat(m[0]);
    return m[1] === 'rem' ? n * 16 : n;
  };
  const out = expr();
  space();
  if (i !== src.length) throw new Error(`left over: ${src.slice(i)} in ${value}`);
  return out;
}

/** What the window draws now: a list row's subject and a message body's paragraph, in px. */
function drawn(el: HTMLElement) {
  const cascade = loadCascade(CSS);
  const subject = el.querySelector<HTMLElement>(`[data-thread-id="${thread}"] .ib-title`);
  const body = el.querySelector<HTMLElement>('.ib-body p[data-block-id]');
  if (!subject || !body) throw new Error('the list row or the message body is not drawn');
  // The cascade leaves a property the stylesheet never declares as written; the page sets this one on the
  // document element, and inbox.css's own fallback is 14, as a browser would read it.
  const size = (el: HTMLElement) => px(cascade.resolved(el, 'font-size')!.replaceAll(`var(${TEXT_SIZE_PROPERTY})`, property() || '14'));
  return { subject: size(subject), body: size(body) };
}

beforeAll(async () => {
  if (!hasDom) return;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-text-size-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const first = JSON.parse(line.trim()) as { port: number; worlds: { stopped: string }[] };
  port = first.port;
  thread = first.worlds[0]!.stopped;
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  resetInboxTextSizeForTests();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  resetInboxTextSizeForTests();
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function go(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  return host;
}

const threadShown = (el: HTMLElement) => () =>
  el.querySelector(`[data-thread-id="${thread}"] .ib-title`) !== null && el.querySelector('.ib-body p[data-block-id]') !== null;
const property = () => document.documentElement.style.getPropertyValue(TEXT_SIZE_PROPERTY);

async function pick(el: HTMLElement, size: number) {
  await go('#settings');
  await until(() => el.querySelector('[data-settings-text-size]') !== null, 'the Text size row');
  const radio = [...el.querySelectorAll<HTMLInputElement>('[data-settings-text-size] input[type="radio"]')].find((r) => r.value === String(size));
  if (!radio) throw new Error(`no ${size} option`);
  act(() => radio.click());
  expect(el.querySelector('[data-settings-text-size]')?.getAttribute('data-settings-text-size')).toBe(String(size));
  await until(() => sizeOnDisk() === (size === 14 ? 14 : size), `config.json to say ${size}`);
  await go(`#thread=${thread}`);
  await until(threadShown(el), 'the thread beside the list');
}

test.skipIf(!hasDom)('picking 12 and 15 scales a row subject and a message body; 14 draws the default sizes', async () => {
  writeSizeOnDisk(undefined);
  const el = await renderApp(`#thread=${thread}`);
  await until(threadShown(el), 'the thread beside the list');
  // The default: nothing set on the document, today's sizes.
  expect(property()).toBe('');
  const today = drawn(el);
  expect(today.body).toBe(15);
  expect(today.subject).toBeGreaterThanOrEqual(11);

  await pick(el, 12);
  expect(property()).toBe('12');
  const small = drawn(el);
  expect(small.body).toBeCloseTo((15 * 12) / 14, 3);
  expect(small.subject).toBeCloseTo(Math.max(11, (today.subject * 12) / 14), 3);
  expect(small.subject).toBeLessThan(today.subject);

  await pick(el, 15);
  expect(property()).toBe('15');
  const big = drawn(el);
  expect(big.body).toBeCloseTo((15 * 15) / 14, 3);
  expect(big.subject).toBeCloseTo((today.subject * 15) / 14, 3);

  // Back to 14: the property is gone and every size is today's again.
  await pick(el, 14);
  expect(property()).toBe('');
  expect(drawn(el)).toEqual(today);
});

test.skipIf(!hasDom)("config.json's size is the one the window opens on", async () => {
  writeSizeOnDisk(13);
  const el = await renderApp(`#thread=${thread}`);
  await until(() => property() === '13', 'the size from config.json');
  await until(threadShown(el), 'the thread beside the list');
  expect(drawn(el).body).toBeCloseTo((15 * 13) / 14, 3);
});
