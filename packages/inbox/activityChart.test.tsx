/**
 * Settings → Activity's chart in the DOM (components/ActivityChart.tsx), over a
 * stubbed `GET /api/inbox/activity`. What regresses: the read asks for the wrong
 * span or project; the preview or Expand no longer opens the full screen, or
 * Escape, × or the backdrop no longer close it; hovering a mark there shows no
 * tooltip or the wrong thread's facts; a click (or a second tap on a touch
 * screen) opens nothing or the wrong thread; the chart takes a key (the owner:
 * mouse and touch only).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * The server half is packages/shared/inbox/activity.test.ts; the layout and keys'
 * model is packages/inbox/activityChart.test.ts.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxActivityModel } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ActivityChart } = (hasDom ? await import('./components/ActivityChart') : {}) as typeof import('./components/ActivityChart');
const chart = (hasDom ? await import('./activityChart') : {}) as typeof import('./activityChart');

const NOW = new Date(2026, 10, 12, 15, 0);
const FROM = new Date(2026, 10, 6);
const TO = new Date(2026, 10, 13);
const WIDTH = 812;
const HEIGHT = 600;

const MODEL: InboxActivityModel = {
  from: FROM.toISOString(),
  to: TO.toISOString(),
  hour_count: Math.round((TO.getTime() - FROM.getTime()) / 3_600_000),
  project_id: 'prj_a',
  threads: [
    { thread_id: 'msg_retry', name: 'Retry queue', project_id: 'prj_a', started_at: FROM.toISOString(), last_at: TO.toISOString(), total: 9, hours: [10, 3, 11, 1, 40, 5] },
    { thread_id: 'msg_ledger', name: 'Ledger export', project_id: 'prj_a', started_at: FROM.toISOString(), last_at: TO.toISOString(), total: 2, hours: [12, 2] },
  ],
};

let root: Root | null = null;
let savedFetch: typeof fetch;
let savedWidth: PropertyDescriptor | undefined;
let savedHeight: PropertyDescriptor | undefined;
let asked: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  asked = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(JSON.stringify(MODEL), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  // happy-dom lays nothing out: give the chart its width.
  savedWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH });
  savedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => HEIGHT });
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
  if (savedWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', savedWidth);
  else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  if (savedHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', savedHeight);
  else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

async function mount(opened: [string, string | null][] = []) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ActivityChart
        projects={[]}
        names={new Map([['prj_a', 'billing']])}
        project="prj_a"
        phone={false}
        now={() => NOW}
        look="blend"
        onOpenThread={(thread, project) => opened.push([thread, project])}
      />,
    );
  });
  for (let i = 0; i < 20 && !host.querySelector('[data-activity-preview] .ib-activity-svg'); i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  const preview = host.querySelector<HTMLElement>('[data-activity-preview]');
  if (!preview) throw new Error('the preview did not draw');
  return { host, preview };
}

const dialog = (host: HTMLElement) => host.querySelector<HTMLDialogElement>('dialog[data-dialog="activity"]');

/** Open the full screen with Expand; its chart. */
async function expand(host: HTMLElement) {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-activity-expand]')!.click());
  const svg = dialog(host)?.querySelector<SVGSVGElement>('.ib-activity-plot[data-size="full"] .ib-activity-svg');
  if (!svg) throw new Error('the full screen did not open');
  return svg;
}

/** Where a mark is in the full screen, in the page (happy-dom puts the SVG at 0,0). */
function at(row: number, hour: number) {
  const layout = chart.activityLayout(WIDTH, MODEL.hour_count, MODEL.threads.length, 'blend', 'full', HEIGHT);
  return { clientX: chart.activityX(layout, hour), clientY: chart.activityY(layout, row) };
}

const tip = (host: HTMLElement) => host.querySelector('[data-activity-tip]')?.textContent ?? null;

test.skipIf(!hasDom)("reads the week up to the coming midnight for the list's project", async () => {
  await mount();
  const url = new URL(asked[0]!, 'http://x');
  expect(url.pathname).toBe('/api/inbox/activity');
  expect(url.searchParams.get('project')).toBe('prj_a');
  expect(Date.parse(url.searchParams.get('from')!)).toBe(FROM.getTime());
  expect(Date.parse(url.searchParams.get('to')!)).toBe(TO.getTime());
});

test.skipIf(!hasDom)('a click on the preview or Expand opens the full screen; Escape, × and the backdrop close it', async () => {
  const { host, preview } = await mount();
  expect(dialog(host)).toBeNull();
  await act(async () => preview.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(dialog(host)?.open).toBe(true);
  await act(async () => {
    dialog(host)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  expect(dialog(host)).toBeNull();
  await expand(host);
  await act(async () => dialog(host)!.querySelector<HTMLButtonElement>('[data-activity-close]')!.click());
  expect(dialog(host)).toBeNull();
  await expand(host);
  await act(async () => dialog(host)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(dialog(host)).toBeNull();
});

test.skipIf(!hasDom)("in the full screen, hovering a mark shows that thread's name and counts; a click opens it and closes the full screen", async () => {
  const opened: [string, string | null][] = [];
  const { host } = await mount(opened);
  const svg = await expand(host);
  await act(async () => {
    svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', ...at(0, 40) }));
  });
  expect(tip(host)).toContain('Retry queue');
  expect(tip(host)).toContain('5 messages');
  // Between marks: no tooltip.
  await act(async () => {
    svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', ...at(0, 25) }));
  });
  expect(tip(host)).toBeNull();
  await act(async () => {
    svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', ...at(1, 12) }));
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, ...at(1, 12) }));
  });
  expect(opened).toEqual([['msg_ledger', 'prj_a']]);
  expect(dialog(host)).toBeNull();
});

test.skipIf(!hasDom)('on a touch screen the first tap on a mark shows its tooltip and a second tap opens it', async () => {
  const opened: [string, string | null][] = [];
  const { host } = await mount(opened);
  const svg = await expand(host);
  const tap = async (row: number, hour: number) => {
    await act(async () => {
      svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', ...at(row, hour) }));
      svg.dispatchEvent(new MouseEvent('click', { bubbles: true, ...at(row, hour) }));
    });
  };
  await tap(0, 40);
  expect(tip(host)).toContain('Retry queue');
  expect(opened).toEqual([]);
  // A tap on another mark moves the tooltip there; it does not open the first.
  await tap(1, 12);
  expect(tip(host)).toContain('Ledger export');
  expect(opened).toEqual([]);
  await tap(1, 12);
  expect(opened).toEqual([['msg_ledger', 'prj_a']]);
});

test.skipIf(!hasDom)('the chart takes no keys: nothing in it is focusable but its buttons, and keys pass through untouched', async () => {
  const opened: [string, string | null][] = [];
  const { host, preview } = await mount(opened);
  const svg = await expand(host);
  expect(host.querySelectorAll('.ib-activity [tabindex]')).toHaveLength(0);
  const passed: string[] = [];
  const onWindow = (event: KeyboardEvent) => passed.push(`${event.key}${event.defaultPrevented ? ':used' : ''}`);
  window.addEventListener('keydown', onWindow);
  try {
    for (const target of [svg, preview]) {
      for (const key of ['ArrowLeft', 'ArrowUp', 'Home', 'End', 'Enter', ' ']) {
        await act(async () => {
          target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
      }
    }
  } finally {
    window.removeEventListener('keydown', onWindow);
  }
  expect(passed).toEqual(['ArrowLeft', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'Enter', ' ']);
  expect(opened).toEqual([]);
});
