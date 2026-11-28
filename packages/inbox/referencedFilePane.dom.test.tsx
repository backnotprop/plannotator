/**
 * The pane a file an agent's message names opens in (ReferencedFilePane.tsx, approval "inbox-file-refs-open-viewer"),
 * drawn from the view route's answer (fetch is stubbed; no Inbox). A log file opens in the code view with its own lines
 * and their numbers, as an attached log does; a markdown file opens as a document whose copy control says "Copy file".
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { ReferencedFilePane } = (hasDom ? await import('./components/ReferencedFilePane') : { ReferencedFilePane: null }) as typeof import('./components/ReferencedFilePane');

let host: HTMLElement | null = null;
let root: Root | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

async function open(path: string, answer: Record<string, unknown> | (() => Promise<Response>), onAttached: (id: string) => void = () => {}) {
  const asked: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    asked.push(String(input));
    if (typeof answer === 'function') return answer();
    return Promise.resolve(new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<ReferencedFilePane threadId="msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ" fileRef={{ path, messageId: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ' }} phone={false} full={false} onOpen={() => {}} onClose={() => {}} onAttached={(id) => onAttached(id)} />);
  });
  for (let i = 0; i < 50 && !host.querySelector('[data-code-view], .ib-docscroll, [data-ref-missing], [data-ref-failed]'); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  return asked;
}

const LOG = '2026-11-07T14:02:11Z retry worker start\n2026-11-07T14:02:12Z charge inv_8841 status=409\n2026-11-07T14:02:12Z charge inv_8842 status=200\n';

test.skipIf(!hasDom)('a .log reference opens in the code view, one row per line with its number, never as markdown', async () => {
  const asked = await open('/var/log/retry-run.log', { found: true, name: 'retry-run.log', path: '/var/log/retry-run.log', kind: 'text', contents: LOG });
  expect(asked[0]).toContain('/api/inbox/open-in/file/view?');
  expect(host!.querySelector('[data-code-view]')).not.toBeNull();
  expect(host!.querySelector('.ib-docscroll')).toBeNull();
  // Pierre draws the rows in its shadow root, some time after mount.
  let rows: string[] = [];
  for (let i = 0; i < 100 && rows.length < 3; i++) {
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    rows = [...(host!.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]') ?? [])].map((row) => row.getAttribute('data-line')!);
  }
  expect(rows.slice(0, 3)).toEqual(['1', '2', '3']);
});

test.skipIf(!hasDom)('a markdown reference opens as a document, and its copy control says Copy file before any comment', async () => {
  await open('docs/plan.md', { found: true, name: 'plan.md', path: 'docs/plan.md', kind: 'markdown', contents: '# Plan\n\nShip it.\n' });
  expect(host!.querySelector('.ib-docscroll')).not.toBeNull();
  expect(host!.querySelector('[data-code-view]')).toBeNull();
  const labels = [...host!.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
  expect(labels).toContain('Copy file');
  expect(labels).not.toContain('Copy plan');
});

test.skipIf(!hasDom)("a pull request's version takes comments only where the file here is that same text", async () => {
  const pull = { label: '#7', platform: 'github', url: 'https://github.com/o/r/pull/7' };
  await open('src/a.ts', { found: true, name: 'a.ts', path: 'src/a.ts', kind: 'code', contents: 'const a = 1;\n', pull, local_matches: false });
  expect(host!.querySelector('[data-code-view]')).not.toBeNull();
  expect(host!.textContent).not.toContain('to comment');
  act(() => root?.unmount());
  host?.remove();
  root = null;
  await open('src/a.ts', { found: true, name: 'a.ts', path: 'src/a.ts', kind: 'code', contents: 'const a = 1;\n', pull, local_matches: true });
  expect(host!.textContent).toContain('to comment');
});

test.skipIf(!hasDom)('a file found nowhere names where it was looked for, never "not on this computer"; a refused one still does not show', async () => {
  await open('decisions.html', { found: false, name: 'decisions.html', path: 'decisions.html', reason: 'missing', looked_in: 'review/build/decisions.html' });
  const note = host!.querySelector('[data-ref-missing="missing"]')!;
  expect(note.textContent).toContain('review/build/decisions.html');
  expect(note.textContent).not.toContain('not on this computer');
  act(() => root?.unmount());
  host?.remove();
  root = null;
  await open('.env', { found: false, name: '.env', path: '.env', reason: 'refused' });
  expect(host!.querySelector('[data-ref-missing="refused"]')).not.toBeNull();
  expect(host!.textContent).not.toContain("isn't at");
});

test.skipIf(!hasDom)("a file at the project's top, or one with no path safe to name, is the short form: never \"plan.md isn't at plan.md\"", async () => {
  for (const answer of [
    { found: false, name: 'plan.md', path: 'plan.md', reason: 'missing', looked_in: 'plan.md' },
    { found: false, name: 'todo.md', path: '~/todo.md', reason: 'missing' },
  ]) {
    await open(answer.path, answer);
    const note = host!.querySelector('[data-ref-missing="missing"]')!;
    expect(note.textContent).toBe(`Couldn't find ${answer.name}.`);
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
});

test.skipIf(!hasDom)('a view that could not be read (a network or server error) says so, never where the file is', async () => {
  await open('docs/plan.md', () => Promise.reject(new TypeError('Failed to fetch')));
  expect(host!.querySelector('[data-ref-missing]')).toBeNull();
  const failed = host!.querySelector('[data-ref-failed]')!;
  expect(failed.getAttribute('role')).toBe('alert');
  // The attachment pane's own words for a file it could not load.
  expect(failed.textContent).toBe('The file could not be opened.');
  expect(failed.textContent).not.toContain("isn't at");
  expect(failed.textContent).not.toContain('not on this computer');
  act(() => root?.unmount());
  host?.remove();
  root = null;
  await open('docs/plan.md', () => Promise.resolve(new Response(JSON.stringify({ error: 'The Inbox is busy.', code: 'internal_error' }), { status: 500, headers: { 'Content-Type': 'application/json' } })));
  expect(host!.querySelector('[data-ref-missing]')).toBeNull();
  // A server's refusal says what the server said.
  expect(host!.querySelector('[data-ref-failed]')!.textContent).toBe('The Inbox is busy.');
});

test.skipIf(!hasDom)('a link the thread holds as an attachment (the view answers its id) opens that attachment', async () => {
  const opened: string[] = [];
  await open('decisions.html', { found: true, name: 'decisions.html', path: 'decisions.html', kind: 'file', attachment_id: 'att_01K7AAAAAAAAAAAAAAAAAAAAAA' }, (id) => opened.push(id));
  for (let i = 0; i < 20 && opened.length === 0; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(opened).toEqual(['att_01K7AAAAAAAAAAAAAAAAAAAAAA']);
  expect(host!.querySelector('[data-ref-missing]')).toBeNull();
});
