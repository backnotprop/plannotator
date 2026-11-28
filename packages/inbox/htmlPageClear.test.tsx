/**
 * How far an HTML page in full screen stops above the window's foot (`--ib-pageclear`, htmlPageFrame.ts; inbox.css
 * gives it to `.ib-htmlframe` as its `bottom`).
 *
 * A desktop with the tools gathered: the page runs to the window's foot and the 32 px corner control floats over it.
 * It used to stop above that control, which left a strip the width of the window under the page in the window's
 * own colour (the owner, 2026-11-25: a dark page over a light strip, "seems to be a bug rendering html in full
 * screen, notice bottom bar"). A phone still stops above its toolbar, which sits in the corner in both states.
 *
 * happy-dom lays nothing out: the dock's height and the corner controls' tops are given, as a 1033 px window draws
 * them (the corner control 48 px above the foot, the phone's bar 70 px).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const proto = hasDom ? HTMLElement.prototype : null;
const realClientHeight = proto ? Object.getOwnPropertyDescriptor(proto, 'clientHeight') : undefined;
const realOffsetTop = proto ? Object.getOwnPropertyDescriptor(proto, 'offsetTop') : undefined;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (proto && realClientHeight) Object.defineProperty(proto, 'clientHeight', realClientHeight);
  if (proto && realOffsetTop) Object.defineProperty(proto, 'offsetTop', realOffsetTop);
});

const page: InboxAttachmentState = {
  id: 'att_01K7SSSSSSSSSSSSSSSSSSSSSS',
  name: 'storyboard.html',
  path: '/work/swarm/storyboard.html',
  kind: 'html',
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  size: 1000,
  sent_at: '2026-11-25T10:42:00.000Z',
  sent_mtime: '2026-11-25T10:42:00.000Z',
  message_id: 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM',
  changed_since_sent: false,
  unavailable: null,
  current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-11-25T10:42:00.000Z' },
};

/** A 1033 px window: the dock fills it; the corner control's top is 48 px above its foot, a phone's bar's 70 px. */
function layOut() {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-full-view-dock') ? 1033 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-full-view-handle')) return 1033 - 48;
      if (this.hasAttribute('data-full-view-bar')) return 1033 - 70;
      return 0;
    },
  });
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(phone: boolean) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(page.id) && url.includes('/view')) {
      return new Response(JSON.stringify({ attachment: page, version: 'current', text: '<h1>Swarm</h1>', html: '<h1>Swarm</h1>' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  layOut();
  const noop = () => {};
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
        projectName="swarm"
        projectRoot="/work/swarm"
        version="current"
        onVersion={noop}
        full
        fullLocked={phone}
        onToggleFull={noop}
        focusId={null}
        readOnly={false}
        onSaved={noop}
        onRemoved={noop}
        onOpenAt={noop}
        onClose={noop}
        strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
        phone={phone}
      />,
    );
  });
  await settle();
}

/** The room the page leaves at the window's foot, in px (none set: 0, as inbox.css's fallback). */
const pageClear = () => {
  const value = host!.querySelector<HTMLElement>('section.ib-view')!.style.getPropertyValue('--ib-pageclear');
  return value === '' ? 0 : Number.parseFloat(value);
};

async function gather() {
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-full-view-hide]')!.click());
  await settle();
}

test.skipIf(!hasDom)('a desktop: the page runs to the foot with the tools showing and gathered (the corner control floats over it)', async () => {
  await render(false);
  expect(host!.querySelector('.ib-htmlframe iframe')).not.toBeNull();
  expect(pageClear()).toBe(0);
  await gather();
  expect(host!.querySelector('[data-full-view-handle]')).not.toBeNull();
  expect(pageClear()).toBe(0);
});

test.skipIf(!hasDom)('a phone: the page still stops above its toolbar in the corner', async () => {
  await render(true);
  expect(host!.querySelector('[data-full-view-bar]')).not.toBeNull();
  expect(pageClear()).toBe(70 + 8);
});
