/**
 * The editor's Schedule row: the next run as the preview route answers it, and the 15-minute refusal under the row,
 * with nothing saved while the schedule is refused. What regresses: no next run while editing, a refusal that does
 * not show, or a refused schedule saved anyway.
 *
 * The Inbox here is a stand-in `fetch` answering the contract's routes (CONTRACT.md section 2).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxScheduledPreview, InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { scheduledRow } from './testRows';

const hasDom = typeof document !== 'undefined';
const { ScheduledEditor } = (hasDom ? await import('./ScheduledEditor') : {}) as typeof import('./ScheduledEditor');
const { FolderPick } = (hasDom ? await import('./EditorParts') : {}) as typeof import('./EditorParts');

const realFetch = globalThis.fetch;
let calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
let preview: (schedule: unknown) => InboxScheduledPreview;
let root: Root | null = null;

const OK: InboxScheduledPreview = { ok: true, schedule_words: 'Every weekday at 9:00 AM', tz_short: 'EST', next_run: '2026-11-16T14:00:00.000Z' };
const REFUSED: InboxScheduledPreview = {
  ok: false,
  schedule_words: 'Every 5 minutes',
  tz_short: 'EST',
  next_run: null,
  refused: { code: 'schedule_too_frequent', error: 'Scheduled times are at least 15 minutes apart. This one runs every 5 minutes.', every_minutes: 5 },
};

function serve(row: InboxScheduledRow) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/inbox/scheduled/preview') return json(preview(body?.schedule));
    if (method === 'GET' && path === `/api/inbox/scheduled/${row.id}`) return json({ scheduled: row, runs: [] });
    if (method === 'POST' && path === `/api/inbox/scheduled/${row.id}`) return json({ scheduled: { ...row, ...body } });
    return new Response(JSON.stringify({ code: 'not_found', error: 'No route.' }), { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  preview = () => OK;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

async function open(row: InboxScheduledRow, known: InboxScheduledRow | null = row): Promise<HTMLElement> {
  serve(row);
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const noop = () => {};
  act(() =>
    root!.render(
      <ScheduledEditor id={row.id} row={known} version={0} block={null} defaults={{ agent: null, projectId: null }} phone={false} narrow={false} onClose={noop} onCreated={noop} onDelete={async () => {}} onOpenThread={noop} />,
    ),
  );
  await settle();
  return host;
}

test.skipIf(!hasDom)('the next run shows as the preview answers it, in the schedule zone', async () => {
  const host = await open(scheduledRow('sch_weekday'));
  const asked = calls.find((c) => c.path === '/api/inbox/scheduled/preview');
  expect(asked?.body?.schedule).toEqual({ cron: '0 9 * * 1-5', tz: 'America/New_York' });
  const next = host.querySelector('[data-schedule-next]');
  expect(next?.textContent).toMatch(/^Next run Mon, Nov 16 at 9:00\sAM EST$/);
  expect(host.querySelector('[data-schedule-refused]')).toBeNull();
});

test.skipIf(!hasDom)('a cron under 15 minutes apart: the refusal under the row, no next run, and nothing saved', async () => {
  const host = await open(scheduledRow('sch_custom', { schedule: { cron: '0 9 1 * *', tz: 'America/New_York' } }));
  expect(host.querySelector('[data-schedule-kind]')?.getAttribute('data-schedule-kind')).toBe('custom');
  preview = (schedule) => ((schedule as { cron?: string }).cron === '*/5 * * * *' ? REFUSED : OK);
  const cron = host.querySelector<HTMLInputElement>('input[aria-label="Cron"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    cron.focus();
    setValue.call(cron, '*/5 * * * *');
    cron.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => cron.blur());
  await settle();
  const refused = host.querySelector('[data-schedule-refused]');
  expect(refused?.getAttribute('data-schedule-refused')).toBe('schedule_too_frequent');
  expect(refused?.getAttribute('role')).toBe('alert');
  expect(refused?.textContent).toBe(REFUSED.refused!.error);
  expect(host.querySelector('[data-schedule-row]')?.getAttribute('aria-describedby')).toBe(refused?.id);
  expect(host.querySelector('[data-schedule-next]')).toBeNull();
  expect(calls.some((c) => c.method === 'POST' && c.path === '/api/inbox/scheduled/sch_custom')).toBe(false);

  // A schedule the preview takes is saved.
  await act(async () => {
    cron.focus();
    setValue.call(cron, '0 */2 * * *');
    cron.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => cron.blur());
  await settle();
  expect(host.querySelector('[data-schedule-refused]')).toBeNull();
  const saved = calls.find((c) => c.method === 'POST' && c.path === '/api/inbox/scheduled/sch_custom');
  expect(saved?.body?.schedule).toEqual({ cron: '0 */2 * * *', tz: 'America/New_York' });
});

test.skipIf(!hasDom)('Custom picked after an edit starts from the schedule as it is now, so nothing older is saved', async () => {
  const host = await open(scheduledRow('sch_weekday'));
  const time = host.querySelector<HTMLInputElement>('input[aria-label="Time"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(time, '07:30');
    time.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-schedule-kind]')!.click());
  await settle();
  await act(async () => document.querySelector<HTMLElement>('[data-schedule-option="custom"]')!.click());
  await settle();
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Cron"]')?.value).toBe('30 7 * * 1-5');
  const saves = calls.filter((c) => c.method === 'POST' && c.path === '/api/inbox/scheduled/sch_weekday').map((c) => c.body?.schedule);
  expect(saves.at(-1)).toEqual({ cron: '30 7 * * 1-5', tz: 'America/New_York' });
});

test.skipIf(!hasDom)('opened by a link before the list is read: the next run is the saved schedule\'s, not a new one\'s default', async () => {
  preview = (schedule) => ({ ...OK, next_run: (schedule as { cron?: string }).cron === '16 2 * * *' ? '2026-11-16T07:16:00.000Z' : OK.next_run });
  const host = await open(scheduledRow('sch_digest', { schedule: { cron: '16 2 * * *', tz: 'America/New_York' } }), null);
  expect(calls.filter((c) => c.path === '/api/inbox/scheduled/preview').at(-1)?.body?.schedule).toEqual({ cron: '16 2 * * *', tz: 'America/New_York' });
  expect(host.querySelector('[data-schedule-next]')?.textContent).toMatch(/at 2:16\sAM EST$/);
});

test.skipIf(!hasDom)('a folder picked by its path shows that path on the chip while the saved record still names another', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<FolderPick block={null} folder={{ path: '/Users/maya/code/acme-web' }} shown={null} agentName="Claude Code" phone onChange={() => {}} />));
  expect(host.querySelector('[data-scheduled-folder]')?.textContent).toBe('/Users/maya/code/acme-web');
});

test.skipIf(!hasDom)('the editor reads Schedule, If a run is missed, Repo or folder, Files, then the Prompt, in the page and in Tab order', async () => {
  const host = await open(scheduledRow('sch_order'));
  const order = ['.st-sched', '.st-miss', '[data-scheduled-folder]', '.st-chips', 'textarea.st-prompt'].map((selector) => host.querySelector(selector));
  expect(order.every(Boolean)).toBe(true);
  for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect([...host.querySelectorAll('[tabindex]')].filter((el) => Number(el.getAttribute('tabindex')) > 0)).toEqual([]);
});
