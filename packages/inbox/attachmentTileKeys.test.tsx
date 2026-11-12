/**
 * The keys on a message's attachment tiles (DOM_TESTS=1). What would regress: the O keycap staying on the newest
 * tile while a file is open (O does nothing from the file, and from the thread it would replace the open one), or
 * not coming back once the file closes; the tile losing its `aria-keyshortcuts` with the keycap.
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

const PROJECT: InboxProject = { id: 'prj_01M4H6G73M9H3Z32T859E72DPZ', root: '/work/launch-site', name: 'launch-site', repo: null } as InboxProject;
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

function thread(): InboxThread {
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
    attachments: FILES,
  };
  return { thread_id: MESSAGE_ID, project: PROJECT, subject: 'Launch notes', thread_name: null, resolved_at: null, messages: [message] };
}

function stubFetch() {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments') && !path.includes('/attachments/')) return Response.json({ serverSession: 's', attachments: FILES, annotations: [] });
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

async function mountThread(open: OpenFile) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  const render = (at: OpenFile) =>
    act(() => root!.render(<ThreadPane thread={thread()} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={at} onOpenFile={() => {}} onOpenGuide={() => {}} />));
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
