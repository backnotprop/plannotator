/**
 * "Open in" for a file a reference names (`OpenInFile`, approval
 * "code-review-launch-build" item 7). The window's own control with the Inbox's
 * routes answered here: what is proved is what it asks, when it draws nothing,
 * and that a pick sends the scope, the path and the line (and never a root).
 * The server's half is packages/server/inbox-open-in.test.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { OpenInFile } = (hasDom ? await import('./components/OpenIn') : {}) as typeof import('./components/OpenIn');
const { InboxFileSourceProvider, INBOX_FILE_SOURCE } = (hasDom ? await import('./fileSource') : {}) as typeof import('./fileSource');

type Asked = { method: string; url: string; body: Record<string, unknown> | null };

const APPS = { available: true, platform: 'mac', apps: [{ id: 'reveal', label: 'Finder', kind: 'file-manager', icon: 'finder' }, { id: 'vscode', label: 'VS Code', kind: 'editor', icon: 'vscode' }] };
const REAL = '/work/app/src/a.ts';

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedMatch: typeof window.matchMedia;
let asked: Asked[] = [];
let answers: { apps: { status: number; body: unknown }; file: { status: number; body: unknown } };

beforeEach(() => {
  if (!hasDom) return;
  asked = [];
  answers = { apps: { status: 200, body: APPS }, file: { status: 200, body: { found: true, path: REAL, kind: 'code' } } };
  savedFetch = globalThis.fetch;
  savedMatch = window.matchMedia;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    asked.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const answer = url.includes('/open-in/apps') ? answers.apps : method === 'POST' ? { status: 200, body: { ok: true } } : answers.file;
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => root?.unmount());
  host?.remove();
  globalThis.fetch = savedFetch;
  window.matchMedia = savedMatch;
  root = null;
  host = null;
});

async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
}

const caret = () => host!.querySelector('[data-open-in-caret]');
const fileReads = () => asked.filter((a) => a.url.includes('/open-in/file') && a.method === 'GET');

// First: a page keeps the apps route's first real answer, and a refusal is not one.
test.skipIf(!hasDom)('through the tailnet: the apps route refuses, so nothing draws and no file is asked about', async () => {
  answers.apps = { status: 403, body: { code: 'local_only' } };
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_tailnet' }} path="src/a.ts" />));
  await settle();
  expect(host!.innerHTML).toBe('');
  expect(fileReads()).toHaveLength(0);
});

test.skipIf(!hasDom)('a file on disk: the split button; its primary launches with the scope, the path and the line, and no root', async () => {
  await act(async () => root!.render(<OpenInFile scope={{ shape: 'shp_one' }} path="src/a.ts" line={12} />));
  await settle();
  expect(caret()).not.toBeNull();
  const read = new URL(fileReads()[0]!.url, 'http://x').searchParams;
  expect(Object.fromEntries(read)).toEqual({ shape: 'shp_one', path: 'src/a.ts' });
  const primary = host!.querySelector<HTMLButtonElement>('[data-open-in-primary]')!;
  expect(primary.getAttribute('data-open-in-primary')).toBe('vscode');
  await act(async () => primary.click());
  await settle();
  const post = asked.find((a) => a.method === 'POST')!;
  const { serverSession: _session, ...body } = post.body!;
  expect(body).toEqual({ shape: 'shp_one', path: 'src/a.ts', app_id: 'vscode', line: 12 });
});

test.skipIf(!hasDom)('a file that is not here: nothing at all', async () => {
  answers.file = { status: 200, body: { found: false } };
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_a' }} path="src/gone.ts" />));
  await settle();
  expect(fileReads()).toHaveLength(1);
  expect(host!.innerHTML).toBe('');
});

test.skipIf(!hasDom)('a file the last read found and this one does not: the control goes away', async () => {
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_b' }} path="src/moved.ts" />));
  await settle();
  expect(caret()).not.toBeNull();
  answers.file = { status: 200, body: { found: false } };
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_b' }} path="src/other.ts" />));
  await settle();
  expect(host!.innerHTML).toBe('');
});

test.skipIf(!hasDom)('on a phone: nothing, and nothing is asked', async () => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_p' }} path="src/a.ts" />));
  await settle();
  expect(host!.innerHTML).toBe('');
  expect(fileReads()).toHaveLength(0);
});

test.skipIf(!hasDom)('a source that writes nothing (the tour): nothing', async () => {
  await act(async () =>
    root!.render(
      <InboxFileSourceProvider source={{ ...INBOX_FILE_SOURCE, writes: false }}>
        <OpenInFile scope={{ thread: 'msg_t' }} path="src/a.ts" />
      </InboxFileSourceProvider>,
    ),
  );
  await settle();
  expect(host!.innerHTML).toBe('');
  expect(fileReads()).toHaveLength(0);
});
