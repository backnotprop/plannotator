/**
 * Filter by typing's state (listTitleFilter.ts): whether the field shows, and what is typed in it.
 *
 * - One for the window, outside the list, so it outlives the list's own redraws: open a thread and come back, switch
 *   the sidebar's view (a project, a machine, an agent, a tag), and the field and its words are still there. The
 *   person narrowed the list to work through it.
 * - Kept for this tab (sessionStorage): a reload keeps it, a new window starts with the whole list.
 * - Only the list subscribes, so typing redraws the list, never the whole window (App).
 */
import { useSyncExternalStore } from 'react';

export interface TitleFilterState {
  /** The field shows. */
  open: boolean;
  /** What is typed in it. */
  text: string;
}

const KEY = 'plannotator-inbox-title-filter';
const CLOSED: TitleFilterState = { open: false, text: '' };

let state: TitleFilterState | null = null;
/** The list's scroll when the field opened: the close puts it back. */
let scrollAtOpen: number | null = null;
/** The field was just opened from the menu: it eases in and takes focus (a field drawn again later does neither). */
let fresh = false;
const listeners = new Set<() => void>();

function stored(): TitleFilterState {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(KEY);
    const read = raw ? (JSON.parse(raw) as Partial<TitleFilterState>) : null;
    if (read && read.open === true) return { open: true, text: typeof read.text === 'string' ? read.text : '' };
  } catch {
    // Storage off or a bad value: the whole list.
  }
  return CLOSED;
}

const current = () => (state ??= stored());

function write(next: TitleFilterState) {
  if (next.open === current().open && next.text === current().text) return;
  state = next;
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (next.open) sessionStorage.setItem(KEY, JSON.stringify(next));
      else sessionStorage.removeItem(KEY);
    }
  } catch {
    // Storage off: it still holds for this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Shows the field (empty), remembering the list's scroll; already open, it stays as it is. */
export function openTitleFilter(scroll: number) {
  if (current().open) return;
  scrollAtOpen = scroll;
  fresh = true;
  write({ open: true, text: '' });
}

export function setTitleFilterText(text: string) {
  write({ open: true, text });
}

/** Hides the field and drops its words; returns the list's scroll from when it opened (null: not known here). */
export function closeTitleFilter(): number | null {
  const scroll = scrollAtOpen;
  scrollAtOpen = null;
  fresh = false;
  write(CLOSED);
  return scroll;
}

/** The menu just opened the field: the field drawn for it eases in and takes focus (read while drawing). */
export const freshTitleFilter = () => fresh;
/** The field has eased in (its effect): a field drawn again later does neither. */
export function settleTitleFilter() {
  fresh = false;
}

export function useTitleFilter(): TitleFilterState {
  return useSyncExternalStore(subscribe, current, current);
}

/** What is typed, read only while `on` (the filter menu open): the menu's counts follow it without a redraw per key. */
export function useTitleFilterTextWhen(on: boolean): string {
  const text = () => (on && current().open ? current().text : '');
  return useSyncExternalStore(subscribe, text, text);
}

export function resetTitleFilterForTests() {
  state = null;
  scrollAtOpen = null;
  fresh = false;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // No storage in this test.
  }
}
