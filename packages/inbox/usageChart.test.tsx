/**
 * Settings → Usage's chart in the DOM (components/UsageChart.tsx), over a
 * stubbed `GET /api/inbox/usage`. What regresses: the read asks for the wrong
 * span or project; hovering a mark shows no tooltip or the wrong thread's
 * facts; a click opens nothing or the wrong thread; the arrow keys do not move
 * between marks, leak to the window's own keys, or Enter does not open; Escape
 * on a chosen mark leaves Settings instead of letting go of the mark.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * The server half is packages/shared/inbox/usage.test.ts; the layout and keys'
 * model is packages/inbox/usageChart.test.ts.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxUsageModel } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { UsageChart } = (hasDom ? await import('./components/UsageChart') : {}) as typeof import('./components/UsageChart');
const chart = (hasDom ? await import('./usageChart') : {}) as typeof import('./usageChart');

const NOW = new Date(2026, 10, 12, 15, 0);
const FROM = new Date(2026, 10, 6);
const TO = new Date(2026, 10, 13);
const WIDTH = 812;

const MODEL: InboxUsageModel = {
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
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
  if (savedWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', savedWidth);
  else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

async function mount(opened: [string, string | null][] = []) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <UsageChart
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
  for (let i = 0; i < 20 && !host.querySelector('.ib-usage-svg'); i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  const svg = host.querySelector<SVGSVGElement>('.ib-usage-svg');
  if (!svg) throw new Error('the chart did not draw');
  return { host, svg };
}

/** Where a mark is, in the page (happy-dom puts the SVG at 0,0). */
function at(row: number, hour: number) {
  const layout = chart.usageLayout(WIDTH, MODEL.hour_count, MODEL.threads.length, 'blend');
  return { clientX: chart.usageX(layout, hour), clientY: chart.usageY(layout, row) };
}

const tip = (host: HTMLElement) => host.querySelector('[data-usage-tip]')?.textContent ?? null;

test.skipIf(!hasDom)("reads the week up to the coming midnight for the list's project", async () => {
  await mount();
  const url = new URL(asked[0]!, 'http://x');
  expect(url.pathname).toBe('/api/inbox/usage');
  expect(url.searchParams.get('project')).toBe('prj_a');
  expect(Date.parse(url.searchParams.get('from')!)).toBe(FROM.getTime());
  expect(Date.parse(url.searchParams.get('to')!)).toBe(TO.getTime());
});

test.skipIf(!hasDom)("hovering a mark shows that thread's name and counts; a click opens it", async () => {
  const opened: [string, string | null][] = [];
  const { host, svg } = await mount(opened);
  await act(async () => {
    svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', ...at(0, 40) }));
  });
  expect(tip(host)).toContain('Retry queue');
  expect(tip(host)).toContain('5 messages');
  await act(async () => {
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, ...at(1, 12) }));
  });
  expect(opened).toEqual([['msg_ledger', 'prj_a']]);
  // Between marks: no tooltip.
  await act(async () => {
    svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', ...at(0, 25) }));
  });
  expect(tip(host)).toBeNull();
});

test.skipIf(!hasDom)('with the chart focused, arrows move between marks without reaching the window, Enter opens, Escape lets go first', async () => {
  const opened: [string, string | null][] = [];
  const { host } = await mount(opened);
  const focusable = host.querySelector<HTMLElement>('.ib-usage-scroll')!;
  const windowKeys: string[] = [];
  const onWindow = (event: KeyboardEvent) => windowKeys.push(`${event.key}${event.defaultPrevented ? ':used' : ''}`);
  window.addEventListener('keydown', onWindow);
  const live = () => host.querySelector('[data-usage-live]')?.textContent ?? '';
  const press = async (key: string) => {
    await act(async () => {
      focusable.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  };
  try {
    focusable.focus();
    // The first arrow lands on the newest thread's latest hour.
    await press('ArrowLeft');
    expect(live()).toContain('Ledger export');
    await press('ArrowUp');
    expect(live()).toContain('Retry queue');
    expect(live()).toContain('1 message,'); // hour 11, nearest to hour 12
    await press('ArrowRight');
    expect(live()).toContain('5 messages');
    expect(windowKeys).toEqual([]);
    await press('Enter');
    expect(opened).toEqual([['msg_retry', 'prj_a']]);
    await press('Escape');
    expect(windowKeys).toEqual(['Escape:used']);
    expect(live()).toBe('');
    await press('Escape');
    expect(windowKeys).toEqual(['Escape:used', 'Escape']);
  } finally {
    window.removeEventListener('keydown', onWindow);
  }
});
