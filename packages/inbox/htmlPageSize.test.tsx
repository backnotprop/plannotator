/**
 * The size control on an HTML page on a phone (approval
 * "inbox-html-attachments-phone", part B "Fit the page"; pageSize.ts).
 *
 * What is proved here, on the pane as a phone draws it: the control is one
 * icon with no words (the owner's pick, "Just the icon no words") in the page's
 * corner, outside the scaled page, and gathers with the other tools; its icon
 * shows the size the page is at and its name and tooltip say what a press
 * does; a page that fits opens on Phone size (a phone icon, "Desktop size"); a
 * page the bridge reports clearly wider than the phone (1.5 times) opens on Desktop size by itself,
 * while one long line poking out a little does not;
 * scaled to the phone's width (a laptop icon, "Phone size"); a press switches and
 * is remembered for that file, so a remount (a reload) opens the way it was
 * left even when the page is wide; the remembered choice is per file; the
 * scale reaches the viewer, so the pen's coordinates convert (the math is
 * HtmlViewer.frameScale.test.tsx's); a desktop draws no control and no scale.
 * The real layout and a real tap are tests/e2e/inbox-html-fit.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { PAGE_SIZE_KEY } from './pageSize';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const clientWidth = hasDom ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth') : undefined;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  unmount();
  globalThis.fetch = realFetch;
  if (hasDom) {
    window.localStorage.removeItem(PAGE_SIZE_KEY);
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
    for (const stray of document.querySelectorAll('.pn-inbox')) stray.remove();
  }
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, dir = '/work/shop'): InboxAttachmentState {
  return {
    id,
    name,
    path: `${dir}/${name}`,
    kind: 'html',
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: M1,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
  };
}

const dashboard = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'dashboard.html');
const sameNameElsewhere = file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'dashboard.html', '/work/other');

function stubViews() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const att = [dashboard, sameNameElsewhere].find((a) => url.includes(a.id));
    if (att && url.includes('/view')) {
      return new Response(JSON.stringify({ attachment: att, version: 'current', text: '<h1>Fleet</h1>', html: '<h1>Fleet</h1>' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

/** The phone's width for the page's box (happy-dom lays nothing out). */
function phoneWidth(width = 390) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('ib-htmlframe') ? width : 0;
    },
  });
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(attachment: InboxAttachmentState, phone = true) {
  stubViews();
  phoneWidth();
  const noop = () => {};
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AttachmentPane
        attachment={attachment}
        attachments={[attachment]}
        records={[]}
        agent="Claude Code"
        projectName="shop"
        projectRoot="/work/shop"
        version="current"
        onVersion={noop}
        full={phone}
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

const frameBox = () => host!.querySelector<HTMLElement>('.ib-htmlframe')!;
const toggle = () => host!.querySelector<HTMLButtonElement>('[data-page-size-toggle]');
const corner = () => host!.querySelector<HTMLElement>('[data-page-size-corner]');
const icon = () => toggle()!.querySelector('svg')!.getAttribute('data-icon');
const name = () => toggle()!.getAttribute('aria-label');

/** The page's bridge reporting how wide the page lays out against its frame. */
async function reportWidth(width: number, viewport = 390) {
  const iframe = frameBox().querySelector('iframe')!;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'plannotator-bridge-content-width', width, viewport } }));
  });
}

async function press() {
  await act(async () => toggle()!.click());
}

test.if(hasDom)('a page that fits opens on Phone size; the control is one icon with no words, outside the scaled page', async () => {
  await render(dashboard);
  await reportWidth(390);
  expect(frameBox().dataset.pageSize).toBe('phone');
  expect(frameBox().classList.contains('ib-fitdesk')).toBe(false);
  expect(corner()).not.toBeNull();
  // Not inside the page's box, so the scale never shrinks it.
  expect(frameBox().contains(toggle())).toBe(false);
  expect(toggle()!.textContent).toBe('');
  expect(icon()).toBe('phone');
  expect(name()).toBe('Desktop size');
  expect(toggle()!.title).toBe('Desktop size');
  // It floats like the other tools, so » and a pinch gather it with them.
  const { GATHERED } = await import('./components/FullViewBar');
  expect(corner()!.matches(GATHERED)).toBe(true);
});

test.if(hasDom)('a page wider than the phone opens on Desktop size by itself, laid out at 1280 and scaled to fit', async () => {
  await render(dashboard);
  await reportWidth(1180);
  expect(frameBox().dataset.pageSize).toBe('desktop');
  expect(frameBox().classList.contains('ib-fitdesk')).toBe(true);
  expect(frameBox().style.getPropertyValue('--ib-fit-width')).toBe('1280px');
  expect(Number(frameBox().style.getPropertyValue('--ib-fit-scale'))).toBeCloseTo(390 / 1280, 6);
  expect(icon()).toBe('laptop');
  expect(name()).toBe('Phone size');
  expect(toggle()!.title).toBe('Phone size');
  // Nothing was pressed: no choice is stored, so the page's width decides again next time.
  expect(window.localStorage.getItem(PAGE_SIZE_KEY)).toBeNull();
  // Once fitted, the page reports against the laptop width: that does not undo it.
  await reportWidth(1280, 1280);
  expect(frameBox().dataset.pageSize).toBe('desktop');
});

test.if(hasDom)('a phone-friendly page with one long line poking out a little stays on Phone size', async () => {
  await render(dashboard);
  // One unbroken hash or URL: about 500 px on a 390 px phone, under the 1.5 line.
  await reportWidth(500);
  expect(frameBox().dataset.pageSize).toBe('phone');
  expect(frameBox().classList.contains('ib-fitdesk')).toBe(false);
});

test.if(hasDom)('a squeezed page takes one press, and the press is remembered after a reload', async () => {
  await render(dashboard);
  await reportWidth(390);
  await press();
  expect(frameBox().dataset.pageSize).toBe('desktop');
  expect(icon()).toBe('laptop');
  expect(name()).toBe('Phone size');
  // The icon and its name changed; the pane's live region says what happened.
  await settle();
  expect(host!.querySelector('[data-step-live]')!.textContent).toContain('Desktop size');

  unmount();
  await render(dashboard);
  expect(frameBox().dataset.pageSize).toBe('desktop');
});

test.if(hasDom)('Phone size on a wide page is remembered too: the page width does not override it', async () => {
  await render(dashboard);
  await reportWidth(1180);
  await press();
  expect(frameBox().dataset.pageSize).toBe('phone');
  expect(name()).toBe('Desktop size');

  unmount();
  await render(dashboard);
  await reportWidth(1180);
  expect(frameBox().dataset.pageSize).toBe('phone');
});

test.if(hasDom)('the choice is per file: another file with the same name keeps its own', async () => {
  await render(dashboard);
  await reportWidth(390);
  await press();
  unmount();
  await render(sameNameElsewhere);
  await reportWidth(390);
  expect(frameBox().dataset.pageSize).toBe('phone');
});

test.if(hasDom)('a desktop draws no size control and no scale, whatever the page width', async () => {
  await render(dashboard, false);
  await reportWidth(1600, 900);
  expect(corner()).toBeNull();
  expect(toggle()).toBeNull();
  expect(frameBox().dataset.pageSize).toBeUndefined();
  expect(frameBox().classList.contains('ib-fitdesk')).toBe(false);
});
