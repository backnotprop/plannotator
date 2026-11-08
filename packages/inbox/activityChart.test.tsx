/**
 * Settings → Activity's chart in the DOM (components/ActivityChart.tsx), over a
 * stubbed `GET /api/inbox/activity`. What regresses: the read asks for the wrong
 * span or project; the preview or Expand no longer opens the full screen, or
 * Escape, × or the backdrop no longer close it; hovering a mark there shows no
 * tooltip or the wrong thread's facts; a click (or a second tap on a touch
 * screen) opens nothing or the wrong thread; the chart takes a key (the owner:
 * mouse and touch only); an empty or failed read leaves no way to another
 * range or project; a linked machine's project as the list's filter is read
 * (a lasting 404); Escape in the project menu closes the full screen too.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * The server half is packages/shared/inbox/activity.test.ts; the layout and keys'
 * model is packages/inbox/activityChart.test.ts.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxActivityModel } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from './api';

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
const ok = (model: InboxActivityModel) => new Response(JSON.stringify(model), { status: 200, headers: { 'Content-Type': 'application/json' } });
/** The stubbed server: every read answers MODEL unless a test says otherwise. */
let respond: (url: URL) => Response = () => ok(MODEL);
const EMPTY: InboxActivityModel = { ...MODEL, threads: [] };
const PROJECTS = [
  { id: 'prj_a', key: 'billing-aaaaaa', name: 'billing', threads: 3, unread: 0 },
  { id: 'prj_b', key: 'docs-bbbbbb', name: 'docs', threads: 2, unread: 0 },
] as unknown as ProjectFolder[];

beforeEach(() => {
  if (!hasDom) return;
  asked = [];
  respond = () => ok(MODEL);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return respond(new URL(String(input), 'http://x'));
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

const NAMES = new Map([
  ['prj_a', 'billing'],
  ['prj_b', 'docs'],
]);

function chartWith(opened: [string, string | null][], projects: ProjectFolder[], project: string | null) {
  return <ActivityChart projects={projects} names={NAMES} project={project} phone={false} now={() => NOW} look="blend" onOpenThread={(thread, p) => opened.push([thread, p])} />;
}

async function until(host: ParentNode, selector: string) {
  for (let i = 0; i < 40 && !host.querySelector(selector); i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  const el = host.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`never drew ${selector}`);
  return el;
}

async function mount(opened: [string, string | null][] = [], { projects = [] as ProjectFolder[], project = 'prj_a' as string | null, wait = '[data-activity-preview] .ib-activity-svg' } = {}) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(chartWith(opened, projects, project));
  });
  await until(host, wait);
  return { host, preview: host.querySelector<HTMLElement>('[data-activity-preview]')! };
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

const spanDays = (url: URL) => Math.round((Date.parse(url.searchParams.get('to')!) - Date.parse(url.searchParams.get('from')!)) / 86_400_000);
const lastAsked = () => new URL(asked[asked.length - 1]!, 'http://x');

test.skipIf(!hasDom)('an empty week still opens the full screen, where a wider range finds the threads', async () => {
  respond = (url) => ok(spanDays(url) <= 7 ? EMPTY : MODEL);
  const { host } = await mount([], { wait: '[data-activity-empty]' });
  const expandButton = host.querySelector<HTMLButtonElement>('[data-activity-expand]')!;
  expect(expandButton.disabled).toBe(false);
  await act(async () => expandButton.click());
  const dlg = dialog(host)!;
  // The note names the way out the full screen has.
  expect(dlg.querySelector('[data-activity-empty]')?.textContent).toContain('a longer range');
  await act(async () => dlg.querySelector<HTMLInputElement>('input[name="ib-activity-range"][value="30"]')!.click());
  await until(dlg, '.ib-activity-plot[data-size="full"] .ib-activity-svg');
  expect(spanDays(lastAsked())).toBe(30);
  expect(dlg.querySelector('[data-activity-empty]')).toBeNull();
});

test.skipIf(!hasDom)('a failed read still opens the full screen, where another project reads again', async () => {
  respond = (url) =>
    url.searchParams.get('project')
      ? new Response(JSON.stringify({ error: { code: 'project_not_found', message: 'No project prj_a' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      : ok(MODEL);
  const { host } = await mount([], { projects: PROJECTS, wait: '[role="alert"]' });
  const expandButton = host.querySelector<HTMLButtonElement>('[data-activity-expand]')!;
  expect(expandButton.disabled).toBe(false);
  await act(async () => expandButton.click());
  const dlg = dialog(host)!;
  expect(dlg.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => dlg.querySelector<HTMLButtonElement>('[data-board-project-clear]')!.click());
  await until(dlg, '.ib-activity-plot[data-size="full"] .ib-activity-svg');
  expect(lastAsked().searchParams.get('project')).toBeNull();
  expect(dlg.querySelector('[role="alert"]')).toBeNull();
});

test.skipIf(!hasDom)("a linked machine's project as the list's filter starts on every project, also when the projects arrive later", async () => {
  await mount([], { projects: PROJECTS, project: 'prj_remote' });
  expect(asked.map((u) => new URL(u, 'http://x').searchParams.get('project'))).toEqual([null]);
  // The projects not loaded yet at first: the filter goes once they arrive.
  act(() => root?.unmount());
  document.body.innerHTML = '';
  asked = [];
  const { host } = await mount([], { projects: [], project: 'prj_remote', wait: '.ib-activity-box' });
  await act(async () => root!.render(chartWith([], PROJECTS, 'prj_remote')));
  await until(host, '[data-activity-preview] .ib-activity-svg');
  expect(lastAsked().searchParams.get('project')).toBeNull();
});

test.skipIf(!hasDom)('Escape in the project menu inside the full screen closes the menu, not the full screen', async () => {
  const { host } = await mount([], { projects: PROJECTS });
  await expand(host);
  const dlg = dialog(host)!;
  await act(async () => dlg.querySelector<HTMLElement>('[data-board-project-chip]')!.click());
  const menu = await until(document.body, '[data-board-project-menu]');
  // Drawn inside the modal (outside, the top layer would cover it).
  expect(dlg.contains(menu)).toBe(true);
  await act(async () => {
    (document.activeElement ?? menu).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 20 && document.querySelector('[data-board-project-menu]'); i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  expect(document.querySelector('[data-board-project-menu]')).toBeNull();
  expect(dialog(host)?.open).toBe(true);
});
