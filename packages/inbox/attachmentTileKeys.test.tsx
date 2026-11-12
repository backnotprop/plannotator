/**
 * The keys on a message's attachment tiles (DOM_TESTS=1). What would regress: the O keycap staying on the newest
 * tile while a file is open (O does nothing from the file, and from the thread it would replace the open one), or
 * not coming back once the file closes; the tile losing its `aria-keyshortcuts` with the keycap. The arrow keys
 * between a message's tiles (the owner, 2026-11-12) moving focus the wrong way, past an end, from outside a tile, with
 * a modifier, from a tile under a file in full screen (there ← → step the file), or on a message with one tile (there
 * ↑ ↓ still scroll the thread); and Enter no longer being the tile's own.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: (() => void)[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const restore of restores.splice(0).reverse()) restore();
});

const PROJECT: InboxProject = { id: 'prj_01M4H6G73M9H3Z32T859E72DPZ', key: 'launch-site-abcdef', name: 'launch-site', root: '/work/launch-site', created_at: '2026-11-12T10:00:00.000Z' };
const MESSAGE_ID = 'msg_01M4H6G73M9H3Z32T859E72DPY';

function file(n: number, name: string): InboxAttachmentState {
  return {
    id: `att_01M4H6G73M9H3Z32T859E72D${'ABCDEF'[n]}${n}`,
    name,
    path: `/work/launch-site/${name}`,
    named_path: null,
    kind: 'markdown',
    media_type: 'text/markdown',
    sent_sha256: String(n).repeat(64),
    size: 120 + n,
    sent_at: '2026-11-12T10:41:00.000Z',
    sent_mtime: '2026-11-12T10:41:00.000Z',
    message_id: MESSAGE_ID,
    current: { sha256: String(n).repeat(64), size: 120 + n, mtime: '2026-11-12T10:41:00.000Z' },
    changed_since_sent: false,
    unavailable: null,
  } as InboxAttachmentState;
}

const FILES = [file(1, 'notes.md'), file(2, 'plan.md'), file(3, 'risks.md')];

function thread(files: InboxAttachmentState[] = FILES): InboxThread {
  const message: InboxMessageWire = {
    id: MESSAGE_ID,
    project_id: PROJECT.id,
    thread_id: MESSAGE_ID,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    subject: 'Launch notes',
    body: 'Three files for the launch.',
    created_at: '2026-11-12T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    attachments: files,
  };
  return { thread_id: MESSAGE_ID, project: PROJECT, subject: 'Launch notes', thread_name: null, resolved_at: null, messages: [message] };
}

function stubFetch(files: InboxAttachmentState[] = FILES) {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments') && !path.includes('/attachments/')) return Response.json({ serverSession: 's', attachments: files, annotations: [] });
    if (path.includes('/artifact-pins')) return Response.json({ pins: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    if (path.includes('/content') || path.includes('/text')) return new Response('# Notes\n', { headers: { 'Content-Type': 'text/markdown' } });
    return Response.json({});
  }) as typeof fetch;
  restores.push(() => {
    globalThis.fetch = saved;
  });
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
};

type OpenFile = { id: string; version: 'current' | 'sent'; focus: string | null; view?: 'full' | 'side' | null } | null;

async function mountThread(open: OpenFile, files: InboxAttachmentState[] = FILES) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  const render = (at: OpenFile) =>
    act(() => root!.render(<ThreadPane thread={thread(files)} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={at} onOpenFile={() => {}} onOpenGuide={() => {}} />));
  render(open);
  await settle();
  return {
    rerender: async (at: OpenFile) => {
      render(at);
      await settle();
    },
  };
}

/** The message's tiles at its foot (not the header band's copy), in order. */
const tiles = () => [...host!.querySelectorAll<HTMLElement>('.ib-attachments:not(.ib-hatts-tiles) [data-attachment-id]')];
const keycaps = () => host!.querySelectorAll('.ib-attachments .ib-att-kbd').length;

test.skipIf(!hasDom)('the O keycap: on the newest tile with no file open, gone while one is open beside or full screen, back once it closes', async () => {
  stubFetch();
  const view = await mountThread(null);
  expect(tiles().map((t) => t.getAttribute('data-attachment-name'))).toEqual(['notes.md', 'plan.md', 'risks.md']);
  expect(keycaps()).toBe(1);
  expect(tiles()[0]!.querySelector('.ib-att-kbd')).not.toBeNull();

  await view.rerender({ id: FILES[1]!.id, version: 'current', focus: null, view: 'side' });
  expect(tiles()[1]!.getAttribute('aria-current')).toBe('true');
  expect(keycaps()).toBe(0);
  // The tile still names the key for a screen reader: O works from the thread.
  expect(tiles()[0]!.getAttribute('aria-keyshortcuts')).toBe('O');

  await view.rerender({ id: FILES[0]!.id, version: 'current', focus: null, view: 'full' });
  expect(keycaps()).toBe(0);

  await view.rerender(null);
  expect(keycaps()).toBe(1);
  expect(tiles()[0]!.querySelector('.ib-att-kbd')).not.toBeNull();
});

/** happy-dom lays nothing out: two tiles to a row, as the window draws them with no file open. */
function layOut(list: HTMLElement[]) {
  list.forEach((tile, i) => {
    const box = { left: (i % 2) * 260, top: Math.floor(i / 2) * 60, width: 250, height: 50 };
    const rect = { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box };
    Object.defineProperty(tile, 'getBoundingClientRect', { configurable: true, value: () => rect });
  });
}

const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
};

test.skipIf(!hasDom)('arrow keys move focus between a message’s tiles, stop at the ends, and Enter is left to the tile, which opens it', async () => {
  stubFetch();
  const opened: string[] = [];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(<ThreadPane thread={thread()} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={(at) => at && opened.push(at.id)} onOpenGuide={() => {}} />),
  );
  await settle();
  const [notes, plan, risks] = tiles();
  layOut(tiles());
  act(() => notes!.focus());
  press(notes!, 'ArrowRight');
  expect(document.activeElement).toBe(plan!);
  press(plan!, 'ArrowDown');
  // Below plan.md (second column) the nearest tile of the next row is risks.md.
  expect(document.activeElement).toBe(risks!);
  press(risks!, 'ArrowUp');
  expect(document.activeElement).toBe(notes!);
  press(notes!, 'ArrowRight');
  press(plan!, 'ArrowRight');
  expect(document.activeElement).toBe(risks!);
  // The ends: nothing past the last or the first, and the key does not scroll the thread either.
  expect(press(risks!, 'ArrowRight').defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(risks!);
  press(risks!, 'ArrowLeft');
  press(plan!, 'ArrowLeft');
  press(notes!, 'ArrowLeft');
  expect(document.activeElement).toBe(notes!);
  // With a modifier, or from anywhere but a tile, the arrows are the page's.
  expect(press(notes!, 'ArrowRight', { shiftKey: true }).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(notes!);
  act(() => notes!.blur());
  expect(press(document.body, 'ArrowDown').defaultPrevented).toBe(false);
  // Enter is the tile's own (a button): no shortcut takes it, and the tile opens its file.
  act(() => plan!.focus());
  expect(press(plan!, 'Enter').defaultPrevented).toBe(false);
  expect(plan!.tagName).toBe('BUTTON');
  act(() => plan!.click());
  expect(opened).toEqual([FILES[1]!.id]);
});

test.skipIf(!hasDom)('a file in full screen keeps ← → for its own steps; a message with one tile leaves the arrows to the page', async () => {
  stubFetch();
  await mountThread({ id: FILES[0]!.id, version: 'current', focus: null, view: 'full' });
  const [notes] = tiles();
  act(() => notes!.focus());
  // Under a file in full screen a tile behind it can still hold focus (Tab): the arrows are not the tiles' there.
  expect(press(notes!, 'ArrowDown').defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(notes!);
  act(() => root?.unmount());
  host?.remove();
  for (const restore of restores.splice(0).reverse()) restore();

  // One tile: nothing to move to, so ↑ ↓ still scroll the thread.
  stubFetch([FILES[0]!]);
  await mountThread(null, [FILES[0]!]);
  const [only] = tiles();
  expect(tiles().length).toBe(1);
  act(() => only!.focus());
  expect(press(only!, 'ArrowDown').defaultPrevented).toBe(false);
  expect(press(only!, 'ArrowRight').defaultPrevented).toBe(false);
});
