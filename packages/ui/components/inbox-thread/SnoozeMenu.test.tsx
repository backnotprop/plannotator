/**
 * Pick a time (approval "inbox-snooze", option E: two scrolling lists, day and
 * half-hour time), the host-neutral part the Inbox and Workspaces both draw.
 * What can regress: the first position (two days out, 3:00 PM), a list the
 * keys cannot walk (arrows, Page, Home, End, Left and Right between the lists,
 * Enter snoozes), a key leaking to the menu around it, a click that does not
 * pick, today's past half hours offered, and a picked time a day lacks
 * sending nothing.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { SnoozePicker } = (hasDom ? await import('./SnoozeMenu') : {}) as typeof import('./SnoozeMenu');

let root: Root | null = null;
let host: HTMLElement | null = null;
const savedTz = process.env.TZ;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.parentElement?.remove();
  root = null;
  host = null;
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

/** Local wall time in the test's zone. */
const local = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m - 1, d, h, mi);

function render(now: Date, outside: (event: KeyboardEvent) => void = () => {}) {
  const picks: string[] = [];
  // The menu around the picker, above React's root (a listener on the root itself shares React's own).
  const around = document.createElement('div');
  around.addEventListener('keydown', outside);
  host = document.createElement('div');
  around.appendChild(host);
  document.body.appendChild(around);
  root = createRoot(host);
  act(() => root!.render(<SnoozePicker now={now} onPick={(until) => picks.push(until)} />));
  return picks;
}

const list = (name: 'Day' | 'Time') => document.querySelector<HTMLElement>(`[data-snooze-list="${name}"]`)!;
const selected = (name: 'Day' | 'Time') => list(name).querySelector('[aria-selected="true"]')?.textContent ?? null;
const labels = (name: 'Day' | 'Time') => [...list(name).querySelectorAll('[role="option"]')].map((el) => el.textContent);
function key(target: HTMLElement, name: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
}

test.skipIf(!hasDom)('opens two days out at 3:00 PM; the keys walk both lists and Enter snoozes at that local time', () => {
  process.env.TZ = 'America/New_York';
  const outside: string[] = [];
  const picks = render(local(2026, 11, 3, 13, 10), (event) => outside.push(event.key));
  expect(list('Day').getAttribute('role')).toBe('listbox');
  expect(selected('Day')).toBe('Thu, Nov 5');
  expect(selected('Time')).toBe('3:00 PM');
  key(list('Day'), 'ArrowDown');
  expect(selected('Day')).toBe('Fri, Nov 6');
  key(list('Day'), 'ArrowUp');
  key(list('Day'), 'ArrowUp');
  expect(selected('Day')).toBe('Tomorrow');
  // Right crosses to the times, Left back.
  list('Day').focus();
  key(list('Day'), 'ArrowRight');
  expect(document.activeElement).toBe(list('Time'));
  key(list('Time'), 'ArrowLeft');
  expect(document.activeElement).toBe(list('Day'));
  key(list('Time'), 'ArrowDown');
  expect(selected('Time')).toBe('3:30 PM');
  key(list('Time'), 'PageDown');
  expect(selected('Time')).toBe('6:30 PM');
  key(list('Time'), 'Home');
  expect(selected('Time')).toBe('12:00 AM');
  key(list('Time'), 'End');
  expect(selected('Time')).toBe('11:30 PM');
  // The list's own keys never reach the menu around it (its arrows, type-ahead, Tab); Escape does.
  expect(outside).toEqual([]);
  key(list('Time'), 'Escape');
  expect(outside).toEqual(['Escape']);
  key(list('Time'), 'Enter');
  // Tomorrow (Wed Nov 4), 11:30 PM in New York, is 04:30 UTC the next day.
  expect(picks).toEqual(['2026-11-05T04:30:00.000Z']);
  expect(list('Day').getAttribute('aria-activedescendant')).toBe(list('Day').querySelector('[aria-selected="true"]')!.id);
});

test.skipIf(!hasDom)("a click picks; today offers only the half hours ahead; a time today lacks moves on, and the button snoozes", () => {
  process.env.TZ = 'America/New_York';
  const picks = render(local(2026, 11, 3, 13, 10));
  const today = list('Day').querySelector<HTMLElement>('[role="option"]')!;
  expect(today.textContent).toBe('Today');
  // 3:00 PM was picked; today has it too, so it stays.
  act(() => today.click());
  expect(selected('Day')).toBe('Today');
  expect(labels('Time')[0]).toBe('1:30 PM');
  expect(labels('Time')).not.toContain('1:00 PM');
  expect(selected('Time')).toBe('3:00 PM');
  // Pick 11:30 PM tomorrow, then go back to Today at 1:30 PM by mouse.
  act(() => list('Day').querySelectorAll<HTMLElement>('[role="option"]')[1]!.click());
  act(() => [...list('Time').querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent === '1:00 PM')!.click());
  expect(selected('Time')).toBe('1:00 PM');
  // Today has no 1:00 PM any more: the time moves on to the next one it has.
  act(() => today.click());
  expect(selected('Time')).toBe('1:30 PM');
  act(() => document.querySelector<HTMLButtonElement>('[data-snooze-go]')!.click());
  expect(picks).toEqual(['2026-11-03T18:30:00.000Z']);
});
