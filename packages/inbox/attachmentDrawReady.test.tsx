import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxThread } from '@plannotator/core/inbox-types';
import { __resetCodeHighlightCacheForTests, __setCodeHighlightModuleForTests, onCodeHighlightSwap } from '@plannotator/ui/utils/codeHighlight';
import { resetMathRenderer, setMathRendererLoader, type MathRenderer } from '@plannotator/ui/utils/math';
import { resolveFenceTheme } from '@plannotator/ui/utils/syntaxTheme';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { lazyParts, drawReady } = (hasDom
  ? { lazyParts: await import('./lazyParts'), drawReady: await import('./threadDrawReady') }
  : {}) as { lazyParts: typeof import('./lazyParts'); drawReady: typeof import('./threadDrawReady') };

const FENCE = resolveFenceTheme('plannotator', 'dark');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

function heldPierre() {
  const held: Array<() => void> = [];
  const asked: string[] = [];
  const mod = {
    getSharedHighlighter: ({ langs, themes }: { langs: string[]; themes: string[] }) => {
      for (const lang of langs) for (const theme of themes) asked.push(`${lang} ${theme}`);
      return new Promise((resolve) => held.push(() => resolve(undefined)));
    },
    getHighlighterIfLoaded: () => ({
      codeToTokens: (code: string) => ({ tokens: code.split('\n').map((line) => [{ content: line, color: '#d73a49' }]) }),
    }),
  };
  __setCodeHighlightModuleForTests(mod as unknown as typeof import('@pierre/diffs'));
  return { asked, release: () => held.splice(0).forEach((resolve) => resolve()) };
}

async function ticks(n = 10) {
  for (let i = 0; i < n; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => {
  if (!hasDom) return;
  drawReady.setThreadFenceTheme(FENCE);
  resetMathRenderer();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  __setCodeHighlightModuleForTests(undefined);
  __resetCodeHighlightCacheForTests();
  setMathRendererLoader(null);
  resetMathRenderer();
});

function file(name: string, kind: string, text: string): InboxAttachmentState {
  return {
    id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    path: `/work/api/${name}`,
    named_path: null,
    name,
    kind,
    sent_sha256: 'a'.repeat(64),
    size: text.length,
    sent_at: '2026-10-10T10:00:00.000Z',
    sent_mtime: '2026-10-10T10:00:00.000Z',
    message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    current: { sha256: 'a'.repeat(64), size: text.length, mtime: '2026-10-10T10:00:00.000Z' },
    changed_since_sent: false,
    unavailable: null,
  } as InboxAttachmentState;
}

async function openPane(shown: InboxAttachmentState, text: string) {
  globalThis.fetch = (async () =>
    Response.json({ serverSession: 's', attachment: shown, version: 'current', text, html: null })) as unknown as typeof fetch;
  const noop = () => {};
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AttachmentPane
        attachment={shown}
        attachments={[shown]}
        records={[]}
        agent="Claude Code"
        projectName="api"
        projectRoot="/work/api"
        version="current"
        onVersion={noop}
        full={false}
        onToggleFull={noop}
        focusId={null}
        readOnly={false}
        onSaved={noop}
        onRemoved={noop}
        onOpenAt={noop}
        onClose={noop}
        strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      />,
    );
  });
  await ticks();
}

test.skipIf(!hasDom)('a Markdown file with a fence draws once its grammar is in: the fence paints highlighted on its first write', async () => {
  const pierre = heldPierre();
  const writes: string[] = [];
  const off = onCodeHighlightSwap((el) => writes.push(el.innerHTML));
  try {
    await openPane(file('notes.md', 'markdown', '# Notes\n\n```lua\nlocal x = 1\n```\n'), '# Notes\n\n```lua\nlocal x = 1\n```\n');
    expect(pierre.asked).toContain(`lua ${FENCE}`);
    expect(host!.querySelector('.ib-docscroll') !== null).toBe(false);
    expect(writes).toEqual([]);
    await act(async () => pierre.release());
    await ticks();
    expect(host!.querySelector('.ib-docscroll pre code') !== null).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toContain('<span style="color:#d73a49">');
  } finally {
    off();
  }
});

test.skipIf(!hasDom)('a Markdown file with math draws once KaTeX is in, never as TeX first', async () => {
  heldPierre();
  let land: (r: MathRenderer) => void = () => {};
  setMathRendererLoader(() => new Promise<MathRenderer>((resolve) => (land = resolve)));
  const text = '# Bound\n\nThe delay is $d_0 \\cdot 2^n$ at most.\n';
  await openPane(file('bound.md', 'markdown', text), text);
  expect(host!.querySelector('.ib-docscroll') !== null).toBe(false);
  await act(async () => land({ renderToString: (tex) => `<span class="katex">${tex}</span>` }));
  await ticks();
  expect(host!.querySelector('.ib-docscroll .katex') !== null).toBe(true);
});

test.skipIf(!hasDom)("a code file draws once its grammar is in, in Pierre's themes", async () => {
  const pierre = heldPierre();
  const text = 'local x = 1\nprint(x)\n';
  await openPane(file('init.lua', 'code', text), text);
  expect(pierre.asked).toEqual(expect.arrayContaining(['lua pierre-dark', 'lua pierre-light']));
  expect(host!.querySelector('[data-code-view]') !== null).toBe(false);
  await act(async () => pierre.release());
  await ticks();
  expect(host!.querySelector('[data-code-view]') !== null).toBe(true);
});

test.skipIf(!hasDom)("a review's diff draws once its files' grammars are in, in the diff themes", async () => {
  const pierre = heldPierre();
  await lazyParts.GuideReaderPart.preload().catch(() => undefined);
  const patch = 'diff --git a/src/main.go b/src/main.go\n--- a/src/main.go\n+++ b/src/main.go\n@@ -1 +1 @@\n-old\n+new\n';
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <lazyParts.ReaderPart diff={patch}>
        <p data-reader="">the reader</p>
      </lazyParts.ReaderPart>,
    );
  });
  await ticks();
  expect(pierre.asked).toEqual(expect.arrayContaining(['go pierre-dark', 'go pierre-light']));
  expect(host!.querySelector('[data-reader]') !== null).toBe(false);
  await act(async () => pierre.release());
  await ticks();
  expect(host!.querySelector('[data-reader]') !== null).toBe(true);
});

test.skipIf(!hasDom)('a grammar chunk the Inbox answers 404 for is not fetched again on the next open; one a dropped link lost is', async () => {
  const happy = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
  const was = window.location.href;
  happy.setURL('http://localhost:4000/');
  try {
    await grammarGone();
  } finally {
    happy.setURL(was);
  }
});

async function grammarGone() {
  const asked: string[] = [];
  const chunk = (lang: string) => new URL(`/assets/lang-${lang}-x1.js`, window.location.href).href;
  __setCodeHighlightModuleForTests({
    getSharedHighlighter: ({ langs }: { langs: string[] }) => {
      asked.push(...langs);
      return Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${chunk(langs[0]!)}`));
    },
    getHighlighterIfLoaded: () => undefined,
  } as unknown as typeof import('@pierre/diffs'));
  const heads: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    heads.push(`${init?.method} ${url}`);
    return new Response(null, { status: url.includes('elixir') ? 404 : 200 });
  }) as unknown as typeof fetch;
  const open = async (lang: string) => {
    await drawReady.threadDrawReady({ thread_id: 'msg_0', messages: [{ id: 'msg_0', body: '```' + lang + '\nx\n```' }] } as InboxThread);
    await ticks(3);
  };
  await open('elixir');
  await open('elixir');
  expect(asked).toEqual(['elixir']);
  expect(heads).toEqual([`HEAD ${chunk('elixir')}`]);
  await open('haskell');
  await open('haskell');
  expect(asked).toEqual(['elixir', 'haskell', 'haskell']);
}
