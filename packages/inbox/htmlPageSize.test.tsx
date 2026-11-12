import { afterEach, beforeAll, expect, jest, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { PAGE_SIZE_KEY } from './pageSize';
import { SIZE_ICON_SHOW_MS } from './sizeIconFade';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const clientWidth = hasDom ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth') : undefined;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

let fakeTimers = false;

afterEach(() => {
  unmount();
  if (fakeTimers) jest.useRealTimers();
  fakeTimers = false;
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
    if (!fakeTimers) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

function elapse(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
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

async function reportWidth(width: number, viewport = 390) {
  const iframe = frameBox().querySelector('iframe')!;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'plannotator-bridge-content-width', width, viewport } }));
  });
}

async function press() {
  await act(async () => toggle()!.click());
}

async function fromPage(data: Record<string, unknown>) {
  const iframe = frameBox().querySelector('iframe')!;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data }));
  });
}

const faded = () => corner()!.hasAttribute('data-faded');

function sizeIconCss() {
  const css = readFileSync(new URL('./inbox.css', import.meta.url), 'utf8');
  const rules = css.split('\n').filter((line) => /^\.ib-size(corner|btn)\b/.test(line));
  const style = document.createElement('style');
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
  return style;
}

const takesTaps = () => getComputedStyle(toggle()!).pointerEvents !== 'none';

test.if(hasDom)('the icon shows when the page opens, fades after about 3 seconds without catching taps, and a scroll up brings it back', async () => {
  const style = sizeIconCss();
  try {
    jest.useFakeTimers();
    fakeTimers = true;
    await render(dashboard);
    await reportWidth(1180);
    expect(faded()).toBe(false);
    expect(takesTaps()).toBe(true);
    expect(getComputedStyle(corner()!).pointerEvents).toBe('none');

    elapse(SIZE_ICON_SHOW_MS - 200);
    expect(faded()).toBe(false);
    elapse(200);
    expect(faded()).toBe(true);
    expect(takesTaps()).toBe(false);
    expect(name()).toBe('Phone size');

    await fromPage({ type: 'plannotator-bridge-page-scroll-up' });
    expect(faded()).toBe(false);
    expect(takesTaps()).toBe(true);
    elapse(SIZE_ICON_SHOW_MS);
    expect(faded()).toBe(true);
  } finally {
    style.remove();
  }
});

test.if(hasDom)('a tap near the top of the page brings the icon back, a tap lower down does not, and a press starts the 3 seconds over', async () => {
  jest.useFakeTimers();
  fakeTimers = true;
  await render(dashboard);
  await reportWidth(390);
  elapse(SIZE_ICON_SHOW_MS);
  expect(faded()).toBe(true);

  await fromPage({ type: 'plannotator-bridge-page-tap', y: 400 });
  expect(faded()).toBe(true);
  await fromPage({ type: 'plannotator-bridge-page-tap', y: 20 });
  expect(faded()).toBe(false);

  elapse(SIZE_ICON_SHOW_MS - 500);
  await press();
  expect(frameBox().dataset.pageSize).toBe('desktop');
  elapse(SIZE_ICON_SHOW_MS - 200);
  expect(faded()).toBe(false);
  elapse(200);
  expect(faded()).toBe(true);
});

test.if(hasDom)('keyboard focus on the icon holds it shown; leaving lets it fade', async () => {
  jest.useFakeTimers();
  fakeTimers = true;
  await render(dashboard);
  await reportWidth(390);
  act(() => toggle()!.focus());
  elapse(SIZE_ICON_SHOW_MS * 3);
  expect(faded()).toBe(false);
  act(() => toggle()!.blur());
  elapse(SIZE_ICON_SHOW_MS);
  expect(faded()).toBe(true);
});

test.if(hasDom)('a blur after a finger press does not bring a faded icon back', async () => {
  jest.useFakeTimers();
  fakeTimers = true;
  await render(dashboard);
  await reportWidth(390);
  const realMatches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':focus-visible' ? false : realMatches.call(this, selector);
  } as typeof realMatches;
  try {
    act(() => toggle()!.focus());
    elapse(SIZE_ICON_SHOW_MS);
    expect(faded()).toBe(true);
    act(() => toggle()!.blur());
    expect(faded()).toBe(true);
  } finally {
    Element.prototype.matches = realMatches;
  }
});

test.if(hasDom)('the tools coming back bring a faded icon back with them', async () => {
  jest.useFakeTimers();
  fakeTimers = true;
  await render(dashboard);
  await reportWidth(390);
  elapse(SIZE_ICON_SHOW_MS);
  expect(faded()).toBe(true);
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-full-view-hide]')!.click());
  expect(host!.querySelector('[data-tools]')!.getAttribute('data-tools')).toBe('tucked');
  expect(faded()).toBe(true);
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-full-view-handle]')!.click());
  expect(host!.querySelector('[data-tools]')!.getAttribute('data-tools')).toBe('pinned');
  expect(faded()).toBe(false);
  elapse(SIZE_ICON_SHOW_MS);
  expect(faded()).toBe(true);
});

test.if(hasDom)('a page that fits opens on Phone size; the control is one icon with no words, outside the scaled page', async () => {
  await render(dashboard);
  await reportWidth(390);
  expect(frameBox().dataset.pageSize).toBe('phone');
  expect(frameBox().classList.contains('ib-fitdesk')).toBe(false);
  expect(corner()).not.toBeNull();
  expect(frameBox().contains(toggle())).toBe(false);
  expect(toggle()!.textContent).toBe('');
  expect(icon()).toBe('phone');
  expect(name()).toBe('Desktop size');
  expect(toggle()!.title).toBe('Desktop size');
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
  expect(window.localStorage.getItem(PAGE_SIZE_KEY)).toBeNull();
  await reportWidth(1280, 1280);
  expect(frameBox().dataset.pageSize).toBe('desktop');
});

test.if(hasDom)('a phone-friendly page with one long line poking out a little stays on Phone size', async () => {
  await render(dashboard);
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
  await settle();
  expect(host!.querySelector('[data-step-live]')!.textContent).toBe('Desktop size');
  await press();
  await settle();
  expect(host!.querySelector('[data-step-live]')!.textContent).toBe('Phone size');
  await press();

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
