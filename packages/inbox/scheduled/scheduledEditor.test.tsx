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
  refused: { code: 'schedule_too_frequent', error: 'Scheduled threads run at least 15 minutes apart. This one runs every 5 minutes.', every_minutes: 5 },
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

async function open(row: InboxScheduledRow): Promise<HTMLElement> {
  serve(row);
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const noop = () => {};
  act(() =>
    root!.render(
      <ScheduledEditor id={row.id} row={row} version={0} block={null} defaults={{ agent: null, projectId: null }} phone={false} narrow={false} threadTitle={() => null} onClose={noop} onCreated={noop} onOpenThread={noop} />,
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
