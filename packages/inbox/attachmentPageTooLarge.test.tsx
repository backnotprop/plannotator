/**
 * An attached HTML page the Inbox refuses to frame as too large (`page_too_large` from the page route, past
 * `INBOX_PAGE_MAX_BYTES`) shows the file's download card, as a file too large to read does, never an empty frame.
 *
 * What regresses if this fails: the person opens a large page and sees a blank pane with no word of why.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. fetch is stubbed; no Inbox.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

const page: InboxAttachmentState = {
  id: 'att_01K7BBBBBBBBBBBBBBBBBBBBBB',
  name: 'notes.html',
  path: '/work/harbor/notes.html',
  kind: 'html',
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  size: 9_000_000,
  sent_at: '2026-10-10T10:42:00.000Z',
  sent_mtime: '2026-10-10T10:42:00.000Z',
  message_id: 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM',
  changed_since_sent: false,
  unavailable: null,
  current: { sha256: 'a'.repeat(64), size: 9_000_000, mtime: '2026-10-10T10:42:00.000Z' },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const noop = () => {};

async function openPage(pageAnswer: () => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/open-in/apps')) return Response.json({ available: true, platform: 'mac', apps: [] });
    if (url.includes(page.id) && url.includes('/view')) return Response.json({ serverSession: 's', attachment: page, version: 'current', text: '<h1>Notes</h1>', html: '<h1>Notes</h1>' });
    if (url.includes('/api/inbox/pages')) return pageAnswer();
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AttachmentPane
        attachment={page}
        attachments={[page]}
        records={[]}
        agent="Claude Code"
        projectName="harbor"
        projectRoot="/work/harbor"
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
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  return check();
}

test.skipIf(!hasDom)('a page refused as too large to frame shows its download card in place of an empty frame', async () => {
  await openPage(() => Response.json({ error: 'html: at most 8388608 bytes.', code: 'page_too_large' }, { status: 413 }));
  expect(await until(() => host!.querySelector('[data-download-card]') !== null)).toBe(true);
  expect(host!.querySelector('.ib-htmlframe')).toBeNull();
  expect(host!.querySelector('[data-download-card] a[download]')?.getAttribute('download')).toBe('notes.html');
});

test.skipIf(!hasDom)('a page the route keeps stays framed, with no download card', async () => {
  await openPage(() => Response.json({ id: 'p1', url: '/api/inbox/pages/0123456789abcdef0123456789abcdef' }));
  expect(await until(() => host!.querySelector('.ib-htmlframe') !== null)).toBe(true);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(host!.querySelector('[data-download-card]')).toBeNull();
});
