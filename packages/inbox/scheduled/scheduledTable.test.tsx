/**
 * The Routines page's table: newest last run first (a running one at the top, by when it started), the
 * turned-off ones apart in their own Off table, where Next run reads "Off" and Run still runs once; beside an open
 * one the list narrows to Routine, Runs and Last run. What regresses: the route's next-run order shown as
 * is, off rows mixed into the main table, or the split view keeping every column.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { lastRun, scheduledRow } from './testRows';
import { PHONE_QUERY } from '../phone';

const hasDom = typeof document !== 'undefined';
const { ScheduledTable } = (hasDom ? await import('./ScheduledTable') : {}) as typeof import('./ScheduledTable');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// In the route's order (next run first), which the page does not keep.
const ROWS: InboxScheduledRow[] = [
  scheduledRow('sch_daily', { name: 'Daily summary', runs: 18, last_run: lastRun(18, ago(300)) }),
  scheduledRow('sch_off_new', { name: 'Screenshot check', state: 'off', enabled: false, next_run: null, runs: 22, last_run: lastRun(22, ago(60)) }),
  scheduledRow('sch_weekday', { name: 'Weekday PR summary', runs: 9, last_run: lastRun(9, ago(120)) }),
  scheduledRow('sch_running', { name: 'Nightly dependency check', state: 'running', runs: 13, running_since: ago(1), last_run: lastRun(12, ago(600)) }),
  scheduledRow('sch_once', { name: 'Stripe webhook switch', state: 'done', schedule: { at: '2026-11-12T17:00', tz: 'America/New_York' }, next_run: null, runs: 1, last_run: lastRun(1, ago(1500)) }),
  scheduledRow('sch_off_old', { name: 'Flaky test triage', state: 'off', enabled: false, next_run: null, runs: 6, last_run: lastRun(6, ago(9000)) }),
  scheduledRow('sch_none', { name: 'Release notes draft', schedule: null, next_run: null, runs: 0 }),
];

function draw(short: boolean, selected: string | null = null) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const acts = { open: () => {}, run: () => {}, stop: () => {}, turn: () => {}, remove: () => {} };
  act(() => root!.render(<ScheduledTable rows={ROWS} acts={acts} short={short} selected={selected} />));
  return host;
}

const ids = (scope: Element) => [...scope.querySelectorAll('[data-scheduled-row]')].map((el) => el.getAttribute('data-scheduled-row'));

test.skipIf(!hasDom)('wide: newest last run first, running on top, a never-run one last; the off ones in their own table, in the same grid', () => {
  const host = draw(false);
  const tables = host.querySelectorAll('[role="table"]');
  expect(tables.length).toBe(2);
  expect(ids(tables[0]!)).toEqual(['sch_running', 'sch_weekday', 'sch_daily', 'sch_once', 'sch_none']);
  const off = host.querySelector('[data-scheduled-off]')!;
  expect(ids(off)).toEqual(['sch_off_new', 'sch_off_old']);
  // Both tables sit in one grid, so the Off table's Run column lines up with the On table's.
  expect(tables[0]!.parentElement).toBe(off.parentElement);
  expect(off.parentElement!.classList.contains('st-wgrid')).toBe(true);
  // The sort mark sits on Last run.
  expect(host.querySelector('[aria-sort="descending"]')?.textContent).toBe('Last run');
  // Off rows: Next run reads Off, and Run is dimmed but still there to run once.
  for (const row of off.querySelectorAll('[data-scheduled-row]')) {
    expect(row.querySelector('[data-scheduled-next]')?.textContent).toBe('Off');
    const run = row.querySelector<HTMLButtonElement>('[data-scheduled-run]')!;
    expect(run.hasAttribute('data-off')).toBe(true);
    expect(run.disabled).toBe(false);
  }
  // The running row offers Stop and says it is running; a one-time one that ran is Done; none is None.
  const running = host.querySelector('[data-scheduled-row="sch_running"]')!;
  expect(running.querySelector('[data-scheduled-run]')?.getAttribute('data-scheduled-run')).toBe('stop');
  expect(running.querySelector('[role="status"] .st-dots')).not.toBeNull();
  expect(host.querySelector('[data-scheduled-row="sch_once"] [data-scheduled-next]')?.textContent).toBe('Done');
  expect(host.querySelector('[data-scheduled-row="sch_none"] [data-scheduled-next]')?.textContent).toBe('None');
});

test.skipIf(!hasDom)('split: Routine, then its Run button in a column of its own right of the names, Runs and Last run; the same order, the open one marked', () => {
  const host = draw(true, 'sch_weekday');
  const heads = [...host.querySelectorAll('[role="columnheader"]')].map((el) => el.textContent || el.getAttribute('aria-label'));
  expect(heads).toEqual(['Routine', 'Run', 'Runs', 'Last run']);
  // Every row, On and Off, Run or Stop: the name is the first cell and the button the second, a column of its own.
  for (const row of host.querySelectorAll('[data-scheduled-row]')) {
    const [name, button] = [...row.children];
    expect(name!.classList.contains('st-sname')).toBe(true);
    expect(button!.classList.contains('st-sbtn') && !!button!.querySelector('[data-scheduled-run]')).toBe(true);
  }
  expect(ids(host)).toEqual(['sch_running', 'sch_weekday', 'sch_daily', 'sch_once', 'sch_none', 'sch_off_new', 'sch_off_old']);
  expect(host.querySelector('[data-scheduled-row="sch_weekday"]')?.hasAttribute('data-selected')).toBe(true);
  expect(host.querySelectorAll('[data-selected]').length).toBe(1);
});

test.skipIf(!hasDom)("on a phone a row's ⋯ opens main's bottom sheet (it fits a short screen and scrolls), with its scrim", async () => {
  const before = window.matchMedia;
  window.matchMedia = ((media: string) => ({ media, matches: media === PHONE_QUERY, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  try {
    const host = draw(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-scheduled-menu]')!.click());
    expect(document.querySelector('.ib-pm-pos[data-phone] .ib-pm')).not.toBeNull();
    expect(document.querySelector('.ib-pm-scrim')).not.toBeNull();
  } finally {
    window.matchMedia = before;
  }
});
