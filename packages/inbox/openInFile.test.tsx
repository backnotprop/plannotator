/**
 * "Open in" for a file a reference names (`OpenInFile`, approval
 * "code-review-launch-build" item 7). The window's own control with the Inbox's
 * routes answered here: what is proved is what it asks, when it draws nothing,
 * and that a pick sends the scope, the path and the line (and never a root).
 * The server's half is packages/server/inbox-open-in.test.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { GuideCodeSpanContext, renderInlineMarkdown } from '@plannotator/guide-viewer/renderInlineMarkdown';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { OpenInCodeSpan, OpenInCodeSpans, OpenInFile } = (hasDom ? await import('./components/OpenIn') : {}) as typeof import('./components/OpenIn');
const { ShapeInline } = (hasDom ? await import('@plannotator/ui/components/shape/inline') : {}) as typeof import('@plannotator/ui/components/shape/inline');
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

describe('a code span that names a file', () => {
  const scope = { thread: 'msg_span', message: 'msg_span2' };
  const span = () => host!.querySelector('[data-open-in-span]') as HTMLElement | null;
  const menu = () => document.querySelector('[data-open-in-menu]');
  const draw = (text = 'src/a.ts:12') =>
    act(async () => root!.render(<OpenInCodeSpan scope={scope} text={text}><code>{text}</code></OpenInCodeSpan>));
  const press = async (key = 'Enter') => {
    await act(async () => {
      span()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await new Promise((done) => setTimeout(done, 20));
    });
  };

  test.skipIf(!hasDom)('asks nothing until it is used, and then opens the list', async () => {
    await draw();
    await settle();
    expect(span()!.querySelector('code')!.textContent).toBe('src/a.ts:12');
    expect(asked.filter((a) => a.url.includes('/open-in/'))).toHaveLength(0);
    await press();
    await settle();
    expect(fileReads()[0]!.url).toContain('path=src%2Fa.ts');
    expect(menu()).not.toBeNull();
  });

  test.skipIf(!hasDom)('a click waits out a double click, which only selects the words', async () => {
    await draw('src/b.ts');
    await act(async () => {
      span()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      span()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      await new Promise((done) => setTimeout(done, 260));
    });
    expect(fileReads()).toHaveLength(0);
    await act(async () => {
      span()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      await new Promise((done) => setTimeout(done, 260));
    });
    await settle();
    expect(menu()).not.toBeNull();
  });

  test.skipIf(!hasDom)('a span that is not a file stays a plain span: no menu, no error', async () => {
    answers.file = { status: 200, body: { found: false } };
    await draw('react.js');
    await press();
    await settle();
    expect(menu()).toBeNull();
    expect(span()).toBeNull();
    expect(host!.innerHTML).toBe('<code>react.js</code>');
  });

  test.skipIf(!hasDom)('on a phone it is only the span', async () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    await draw();
    await settle();
    expect(span()).toBeNull();
    expect(host!.querySelector('code')).not.toBeNull();
  });
});

describe('code spans in a guide and a board', () => {
  const scope = { shape: 'shp_x' };
  const spans = () => [...host!.querySelectorAll('[data-open-in-span]')].map((el) => el.getAttribute('data-open-in-span'));

  test.skipIf(!hasDom)('a guide: a span naming a file is the control, others and a link label are not', async () => {
    const renderLink = (href: string, label: ReactNode, key: number) => <button key={key} data-link={href}>{label}</button>;
    await act(async () =>
      root!.render(
        <GuideCodeSpanContext.Provider value={(text, code) => <OpenInCodeSpan scope={scope} text={text}>{code}</OpenInCodeSpan>}>
          <p>{renderInlineMarkdown('See `src/a.ts:3`, `not code` and [`src/label.ts`](code:src/label.ts).', { renderLink })}</p>
        </GuideCodeSpanContext.Provider>,
      ),
    );
    expect(spans()).toEqual(['src/a.ts']);
    expect(host!.querySelector('[data-link]')!.querySelector('code')!.textContent).toBe('src/label.ts');
  });

  test.skipIf(!hasDom)('a board: a span naming a file is the control, a number stays a number', async () => {
    await act(async () =>
      root!.render(
        <OpenInCodeSpans scope={scope} on>
          <p><ShapeInline text="See **`src/b.ts`**, `not code`." /></p>
        </OpenInCodeSpans>,
      ),
    );
    expect(spans()).toEqual(['src/b.ts']);
  });

  test.skipIf(!hasDom)('with Code review off, and with no host, both draw the same plain span', async () => {
    const drawn = async (node: ReactNode) => {
      await act(async () => root!.render(<div>{node}</div>));
      return host!.innerHTML;
    };
    const guide = () => <p>{renderInlineMarkdown('See `src/a.ts`.')}</p>;
    const board = () => <p><ShapeInline text="See `src/a.ts`." /></p>;
    const plainGuide = await drawn(guide());
    const plainBoard = await drawn(board());
    expect(await drawn(<GuideCodeSpanContext.Provider value={null}>{guide()}</GuideCodeSpanContext.Provider>)).toBe(plainGuide);
    expect(await drawn(<OpenInCodeSpans scope={scope} on={false}>{board()}</OpenInCodeSpans>)).toBe(plainBoard);
    expect(spans()).toEqual([]);
    expect(asked.filter((a) => a.url.includes('/open-in/'))).toHaveLength(0);
  });
});
