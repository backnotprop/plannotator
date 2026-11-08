/**
 * Artifact pins in the window (approval "inbox-artifact-stars"; the word is Pin). DOM-gated (DOM_TESTS=1).
 * What would regress: the thread grid's Pinned group (its order, the newest pin first; "Everything else" after it;
 * the grid as it always was with nothing pinned in this thread), a card's pin and the viewer's pin not saving on the
 * server or not showing at once, a refused pin staying shown, and the Wall's filters not reaching its read.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxArtifactPin, InboxArtifactRow, InboxArtifactsPage } from '@plannotator/core/inbox-artifact-pins';
import type { GuideArtifact } from './artifacts';

const hasDom = typeof document !== 'undefined';
const { ArtifactsView } = (hasDom ? await import('./components/ArtifactsView') : {}) as typeof import('./components/ArtifactsView');
const { ArtifactPinButton } = (hasDom ? await import('./components/ArtifactPinButton') : {}) as typeof import('./components/ArtifactPinButton');
const { FullScreenMore } = (hasDom ? await import('./components/OpenIn') : {}) as typeof import('./components/OpenIn');
const { ArtifactsWall } = (hasDom ? await import('./components/ArtifactsWall') : {}) as typeof import('./components/ArtifactsWall');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { resetArtifactPinsForTest } = (hasDom ? await import('./artifactPins') : {}) as typeof import('./artifactPins');

const THREAD = 'msg_01M6XV5A40WH334FPF7KQQH5S5';
const OTHER = 'msg_01M6XV5A3QFRSQX5MXKS88YFED';

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** The server's pins, and what each POST asked. */
let serverPins: InboxArtifactPin[] = [];
let posts: { thread_id: string; key: string; pinned: boolean }[] = [];
let refuse = false;

beforeEach(() => {
  if (!hasDom) return;
  serverPins = [];
  posts = [];
  refuse = false;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('/api/inbox/artifact-pins')) return new Response('{}', { status: 404 });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { thread_id: string; key: string; pinned: boolean };
      posts.push({ thread_id: body.thread_id, key: body.key, pinned: body.pinned });
      if (refuse) return new Response(JSON.stringify({ error: 'No.', code: 'artifact_not_found' }), { status: 404 });
      serverPins = body.pinned ? [...serverPins.filter((p) => p.key !== body.key), { key: body.key, thread_id: body.thread_id, pinned_at: '2026-11-08T12:00:00.000Z' }] : serverPins.filter((p) => p.key !== body.key);
    }
    return new Response(JSON.stringify({ pins: serverPins }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  resetArtifactPinsForTest();
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 20)));

function guide(i: number): GuideArtifact {
  return {
    type: 'guide',
    messageId: `msg_${i}`,
    sender: 'Claude Code',
    sentAt: '11:05 AM',
    at: `2026-11-07T11:0${i}:00.000Z`,
    fromPerson: false,
    host: 'claude-code',
    guide: { sha256: String(i).repeat(64).slice(0, 64), input_sha256: 'a'.repeat(64), bytes: 10, title: `Guide ${i}`, sections: 1, files: 1, additions: 1, deletions: 0 } as GuideArtifact['guide'],
  };
}
const pin = (i: number, thread = THREAD, at = i): InboxArtifactPin => ({ key: `guide:msg_${i}`, thread_id: thread, pinned_at: `2026-11-08T10:0${at}:00.000Z` });

function grid() {
  return mount(<ArtifactsView threadId={THREAD} artifacts={[0, 1, 2, 3, 4].map(guide)} annotationCounts={new Map()} openId={null} onOpen={() => {}} onOpenGuide={() => {}} />);
}
const tilesIn = (el: Element, selector: string) => [...el.querySelectorAll<HTMLElement>(`${selector} [data-artifact-tile]`)].map((t) => t.getAttribute('data-artifact-tile'));

test.skipIf(!hasDom)('the Pinned group comes first, the newest pin first; Everything else keeps the grid order', () => {
  // Pinned guide 1, then guide 3 (pin order); this thread's only.
  resetArtifactPinsForTest([pin(1), pin(3), pin(2, OTHER)]);
  const el = grid();
  expect(el.querySelector('[data-artifacts-group="pinned"] h3')?.textContent).toBe('Pinned2');
  expect(tilesIn(el, '[data-artifacts-group="pinned"]')).toEqual(['guide:msg_3', 'guide:msg_1']);
  expect(el.querySelector('[data-artifacts-group="rest"] h3')?.textContent).toBe('Everything else');
  expect(tilesIn(el, '[data-artifacts-group="rest"]')).toEqual(['guide:msg_4', 'guide:msg_2', 'guide:msg_0']);
  expect(el.querySelector('.ib-art-pinned')?.getAttribute('aria-label')).toBe('2 pinned artifacts');
});

test.skipIf(!hasDom)('with nothing pinned in this thread the grid is one list, as before', () => {
  resetArtifactPinsForTest([pin(1, OTHER)]);
  const el = grid();
  expect(el.querySelector('[data-artifacts-group]')).toBeNull();
  expect(el.querySelectorAll('ul.ib-art-grid').length).toBe(1);
  expect(tilesIn(el, 'ul.ib-art-grid')).toEqual(['guide:msg_4', 'guide:msg_3', 'guide:msg_2', 'guide:msg_1', 'guide:msg_0']);
  // The tour's grid (no thread) has no pins at all.
  act(() => root!.render(<ArtifactsView artifacts={[0, 1].map(guide)} annotationCounts={new Map()} openId={null} onOpen={() => {}} onOpenGuide={() => {}} />));
  expect(el.querySelector('[data-artifact-pin]')).toBeNull();
});

test.skipIf(!hasDom)('a card’s pin saves on the server and moves the card at once; Unpin moves it back', async () => {
  resetArtifactPinsForTest([]);
  const el = grid();
  let opened = 0;
  act(() => root!.render(<ArtifactsView threadId={THREAD} artifacts={[0, 1, 2].map(guide)} annotationCounts={new Map()} openId={null} onOpen={() => {}} onOpenGuide={() => (opened += 1)} />));
  const button = el.querySelector<HTMLButtonElement>('[data-artifact-pin="guide:msg_1"]')!;
  expect(button.getAttribute('aria-label')).toBe('Pin Guide 1');
  expect(button.getAttribute('aria-pressed')).toBe('false');
  act(() => button.click());
  // Shown at once, before the server answers; the tile under the pin did not open.
  expect(tilesIn(el, '[data-artifacts-group="pinned"]')).toEqual(['guide:msg_1']);
  expect(opened).toBe(0);
  await settle();
  expect(posts).toEqual([{ thread_id: THREAD, key: 'guide:msg_1', pinned: true }]);
  const unpin = el.querySelector<HTMLButtonElement>('[data-artifacts-group="pinned"] [data-artifact-pin="guide:msg_1"]')!;
  expect(unpin.getAttribute('aria-label')).toBe('Unpin Guide 1');
  expect(unpin.getAttribute('aria-pressed')).toBe('true');
  act(() => unpin.click());
  await settle();
  expect(posts.at(-1)).toEqual({ thread_id: THREAD, key: 'guide:msg_1', pinned: false });
  expect(el.querySelector('[data-artifacts-group]')).toBeNull();
});

test.skipIf(!hasDom)('a pin the server refuses is taken back', async () => {
  resetArtifactPinsForTest([]);
  refuse = true;
  const el = grid();
  act(() => el.querySelector<HTMLButtonElement>('[data-artifact-pin="guide:msg_2"]')!.click());
  expect(el.querySelector('[data-artifacts-group="pinned"]')).not.toBeNull();
  await settle();
  expect(el.querySelector('[data-artifacts-group]')).toBeNull();
});

test.skipIf(!hasDom)('the viewer bar’s pin reads and saves the same pins as the grid', async () => {
  resetArtifactPinsForTest([{ key: 'att_shot', thread_id: THREAD, pinned_at: '2026-11-08T10:00:00.000Z' }]);
  const el = mount(<ArtifactPinButton threadId={THREAD} artifactKey="att_shot" name="shot.png" surface="bar" />);
  const button = el.querySelector<HTMLButtonElement>('[data-artifact-pin]')!;
  expect(button.getAttribute('aria-label')).toBe('Unpin shot.png');
  act(() => button.click());
  await settle();
  expect(posts).toEqual([{ thread_id: THREAD, key: 'att_shot', pinned: false }]);
  expect(button.getAttribute('aria-label')).toBe('Pin shot.png');
});

// A phone's HTML page has no room in its bar for the pin (320 px, the reply's pill or card on the row): Pin /
// Unpin is the first item of full screen's ⋯ there, saving the same pins as the bar's button.
test.skipIf(!hasDom)('full screen’s ⋯ holds Pin / Unpin when the pane hands it the pin, and saves it', async () => {
  resetArtifactPinsForTest([]);
  const attachment = { id: 'att_page', name: 'report.html', kind: 'html', sent_sha256: 'a'.repeat(64), current: null } as unknown as import('@plannotator/core/inbox-types').InboxAttachmentState;
  const menu = (pinned: { threadId: string; key: string; name: string } | null) => (
    <FullScreenMore attachment={attachment} version="sent" phone open onOpenChange={() => {}} versionAction={null} pin={pinned} />
  );
  mount(menu({ threadId: THREAD, key: 'att_page', name: 'report.html' }));
  await settle();
  const item = () => document.querySelector<HTMLElement>('[data-artifact-pin-item="att_page"]');
  expect(item()?.textContent).toBe('Pin');
  expect(item()?.getAttribute('aria-label')).toBe('Pin report.html');
  act(() => item()!.click());
  await settle();
  expect(posts).toEqual([{ thread_id: THREAD, key: 'att_page', pinned: true }]);
  // Without the pin (the bar draws it): no item.
  act(() => root!.render(menu(null)));
  await settle();
  expect(item()).toBeNull();
  expect(document.querySelector('[data-attachment-download]')).not.toBeNull();
});

function wallRow(i: number, pinned: boolean): InboxArtifactRow {
  return {
    key: `guide:msg_${i}`,
    thread_id: THREAD,
    thread_title: 'Checkout',
    project: { id: 'prj_1', name: 'web-app' },
    message_id: `msg_${i}`,
    at: new Date().toISOString(),
    author: { kind: 'agent', host: 'claude-code', session: 's', name: 'Claude Code' } as InboxArtifactRow['author'],
    type: 'documents',
    attachment: null,
    inline: false,
    guide: guide(i).guide,
    archived: false,
    pinned_at: pinned ? '2026-11-08T10:00:00.000Z' : null,
  };
}

test.skipIf(!hasDom)('the Wall: Pinned, a type chip and Show more reach its read; the empty Pinned page says so', async () => {
  resetArtifactPinsForTest([]);
  const reads: Record<string, unknown>[] = [];
  const read = (async (query: Record<string, unknown>) => {
    reads.push(query);
    const rows = query.pinned ? [] : query.cursor ? [wallRow(3, false)] : [wallRow(1, false), wallRow(2, false)];
    const page: InboxArtifactsPage & { serverSession: string } = { serverSession: 's', artifacts: rows, next_cursor: query.pinned || query.cursor ? null : '2', total: 3, counts: { all: 3, pinned: 0, types: { images: 0, pages: 0, documents: 3, other: 0 } } };
    return page;
  }) as unknown as typeof import('./api').inboxApi.artifacts;
  let pinnedNow = false;
  const draw = () => (
    <SidebarProvider>
      <ArtifactsWall pinned={pinnedNow} onPinned={(next) => (pinnedNow = next)} onOpen={() => {}} phone={false} read={read} />
    </SidebarProvider>
  );
  const el = mount(draw());
  await settle();
  expect(reads[0]).toMatchObject({ pinned: false, type: null, archived: false });
  expect(el.querySelectorAll('[data-wall-artifact]').length).toBe(2);
  act(() => el.querySelector<HTMLButtonElement>('.ib-wall-more button')!.click());
  await settle();
  expect(reads.at(-1)).toMatchObject({ cursor: '2' });
  expect(el.querySelectorAll('[data-wall-artifact]').length).toBe(3);
  act(() => el.querySelector<HTMLButtonElement>('[data-wall-type="documents"]')!.click());
  await settle();
  expect(reads.at(-1)).toMatchObject({ type: 'documents', pinned: false });
  act(() => el.querySelector<HTMLButtonElement>('[data-wall-show="pinned"]')!.click());
  expect(pinnedNow).toBe(true);
  act(() => root!.render(draw()));
  await settle();
  expect(reads.at(-1)).toMatchObject({ pinned: true, type: 'documents' });
  expect(el.querySelector('[data-wall-empty] b')?.textContent).toBe('No pinned artifacts yet');
});
