/**
 * An html block's still picture on the Artifacts wall and in the thread's grid (the owner, 2026-11-25, of the Wall's
 * html tiles: "I'm sorry what's with the empty titles?"). DOM-gated (DOM_TESTS=1). What would regress: the Wall's
 * html tile back to a blank card; its source read before the tile is near, read again on every scroll back, read
 * from this Inbox for a linked computer's thread, or read for a block too large to draw small; the picture drawn
 * with scripts or without the no-prefetch line; and a page only a script draws shown as an empty box instead of
 * the quiet HTML mark (on the Wall and in the grid).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxArtifactRow } from '@plannotator/core/inbox-artifact-pins';
import { inboxHtmlArtifactKey, inboxHtmlBlockHash } from '@plannotator/core/inbox-html-blocks';

const hasDom = typeof document !== 'undefined';
const { WallFace } = (hasDom ? await import('./components/WallFace') : {}) as typeof import('./components/WallFace');
const { HtmlBlockFace } = (hasDom ? await import('./components/ArtifactsView') : {}) as typeof import('./components/ArtifactsView');
const { resetHtmlBlockSourcesForTest, WALL_HTML_SOURCE_MAX } = (hasDom ? await import('./htmlBlockSource') : {}) as typeof import('./htmlBlockSource');

const MESSAGE = 'msg_01M6XV5A40WH334FPF7KQQH5S5';
const FAR = 'ibx_01M6XV5A40WH334FPF7KQQH5S9';
const TIDES = '<h2>Harbor · tide table</h2><table><tr><td>06:12</td></tr></table>';
const CHART = '<svg id="tides" viewBox="0 0 360 120"></svg><script>draw()</script>';

function row(source: string, extra: Partial<InboxArtifactRow> = {}): InboxArtifactRow {
  return {
    key: inboxHtmlArtifactKey(MESSAGE, inboxHtmlBlockHash(source)),
    thread_id: MESSAGE,
    thread_title: 'Harbor: Thursday berths',
    project: { id: 'prj_01M6XV5A40WH334FPF7KQQH5S6', name: 'harbor' },
    message_id: MESSAGE,
    at: '2026-11-25T09:00:00.000Z',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_harbor', name: 'Claude Code' },
    type: 'pages',
    attachment: null,
    inline: true,
    guide: null,
    html: { title: null, size: new TextEncoder().encode(source).length },
    archived: false,
    pinned_at: null,
    ...extra,
  } as InboxArtifactRow;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let asked: string[] = [];
/** What the Inbox answers for a key. */
let sources = new Map<string, string>();

beforeEach(() => {
  if (!hasDom) return;
  asked = [];
  sources = new Map();
  resetHtmlBlockSourcesForTest();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const key = new URL(url, 'http://inbox.local').searchParams.get('key') ?? '';
    const html = sources.get(key);
    return html === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ html }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = savedFetch;
  document.body.innerHTML = '';
});

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

async function draw(face: React.ReactNode): Promise<void> {
  await act(async () => root!.render(face));
  await settle();
}

const frame = () => host!.querySelector<HTMLIFrameElement>('[data-face="html-block"] iframe');

test("a Wall tile reads its block only once near, draws the grid's still picture, and keeps the read for the way back", async () => {
  if (!hasDom) return;
  const tides = row(TIDES);
  sources.set(tides.key, TIDES);
  await draw(<WallFace row={tides} near={false} guide={null} pages={null} />);
  expect(asked).toEqual([]);
  expect(frame()).toBeNull();
  expect(host!.querySelector('[data-face="html-block"]')!.textContent).toBe('HTML');

  await draw(<WallFace row={tides} near guide={null} pages={null} />);
  expect(asked).toEqual([`/api/inbox/artifacts/html?key=${encodeURIComponent(tides.key)}`]);
  // The grid's picture: a frame that runs no script, told not to prefetch, of the block's own markup.
  expect(frame()!.getAttribute('sandbox')).toBe('');
  expect(frame()!.getAttribute('srcdoc')).toBe(`<meta http-equiv="x-dns-prefetch-control" content="off">${TIDES}`);
  expect(host!.querySelector('[data-html-picture]')).not.toBeNull();

  // Far away, the picture goes; near again (or another tile of the same block), it is drawn with no second read.
  await draw(<WallFace row={tides} near={false} guide={null} pages={null} />);
  expect(frame()).toBeNull();
  await draw(<></>);
  await draw(<WallFace row={tides} near guide={null} pages={null} />);
  expect(frame()).not.toBeNull();
  expect(asked.length).toBe(1);
});

test('a page only its script draws keeps the quiet HTML mark, on the Wall and in the grid', async () => {
  if (!hasDom) return;
  const chart = row(CHART);
  sources.set(chart.key, CHART);
  await draw(<WallFace row={chart} near guide={null} pages={null} />);
  expect(asked.length).toBe(1);
  expect(frame()).toBeNull();
  expect(host!.querySelector('[data-face="html-block"]')!.textContent).toBe('HTML');

  await draw(<HtmlBlockFace source={CHART} near />);
  expect(frame()).toBeNull();
  expect(host!.querySelector('[data-face="html-block"] .ib-art-typed')).not.toBeNull();
  await draw(<HtmlBlockFace source={TIDES} near />);
  expect(frame()!.getAttribute('sandbox')).toBe('');
});

test("a linked computer's block is read there, through the forward; a block too large to draw small, and one that cannot be read, keep the mark", async () => {
  if (!hasDom) return;
  const far = row(TIDES, { machine: FAR });
  sources.set(far.key, TIDES);
  await draw(<WallFace row={far} near guide={null} pages={null} />);
  expect(asked).toEqual([`/api/inbox/m/${FAR}/artifacts/html?key=${encodeURIComponent(far.key)}`]);
  expect(frame()).not.toBeNull();

  const huge = row('<p>x</p>', { html: { title: null, size: WALL_HTML_SOURCE_MAX + 1 } });
  sources.set(huge.key, '<p>x</p>');
  await draw(<WallFace row={huge} near guide={null} pages={null} />);
  expect(asked.length).toBe(1);
  expect(frame()).toBeNull();

  // An older Inbox (no such route) or a block gone: the mark, and the next time near it asks again.
  const gone = row('<p>gone</p>');
  await draw(<WallFace row={gone} near guide={null} pages={null} />);
  expect(frame()).toBeNull();
  await draw(<></>);
  await draw(<WallFace row={gone} near guide={null} pages={null} />);
  expect(asked.filter((url) => url.includes(encodeURIComponent(gone.key))).length).toBe(2);
});
