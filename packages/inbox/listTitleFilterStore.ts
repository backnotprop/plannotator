/**
 * Filter by typing's state (listTitleFilter.ts): whether the field shows, and what is typed in it.
 *
 * - One for the window, outside the list, so it outlives the list's own redraws: open a thread and come back, switch
 *   the sidebar's view (a project, a machine, an agent, a tag), and the field and its words are still there. The
 *   person narrowed the list to work through it.
 * - Kept for this tab (sessionStorage): a reload keeps it, a new window starts with the whole list.
 * - The list's scroll when the field opened is kept with the list it belongs to (`place`, the sidebar's view): the
 *   close puts it back only in that list, after a reload too. Closed in another list, the scroll stays where it is.
 * - Only the list subscribes, so typing redraws the list, never the whole window (App).
 */
import { useSyncExternalStore } from 'react';

export interface TitleFilterState {
  /** The field shows. */
  open: boolean;
  /** What is typed in it. */
  text: string;
}

/** The list's scroll when the field opened, and which list (the sidebar's view) it was. */
interface ScrollAtOpen {
  place: string;
  top: number;
}

const KEY = 'plannotator-inbox-title-filter';
const CLOSED: TitleFilterState = { open: false, text: '' };

let state: TitleFilterState | null = null;
let scrollAtOpen: ScrollAtOpen | null = null;
/** The field was just opened from the menu: it eases in and takes focus (a field drawn again later does neither). */
let fresh = false;
const listeners = new Set<() => void>();

function stored(): TitleFilterState {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(KEY);
    const read = raw ? (JSON.parse(raw) as Partial<TitleFilterState> & { at?: Partial<ScrollAtOpen> }) : null;
    if (read && read.open === true) {
      const at = read.at;
      scrollAtOpen = at && typeof at.place === 'string' && typeof at.top === 'number' && Number.isFinite(at.top) ? { place: at.place, top: at.top } : null;
      return { open: true, text: typeof read.text === 'string' ? read.text : '' };
    }
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
      if (next.open) sessionStorage.setItem(KEY, JSON.stringify({ ...next, at: scrollAtOpen }));
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

/** Shows the field (empty), remembering the scroll of the list it opened in (`place`); already open, it stays as it is. */
export function openTitleFilter(scroll: number, place: string) {
  if (current().open) return;
  scrollAtOpen = { place, top: scroll };
  fresh = true;
  write({ open: true, text: '' });
}

export function setTitleFilterText(text: string) {
  write({ open: true, text });
}

/**
 * Hides the field and drops its words; returns the scroll `place`'s list had when the field opened there (null: it
 * opened in another list, or it is not known: the scroll stays where it is).
 */
export function closeTitleFilter(place: string): number | null {
  current();
  const scroll = scrollAtOpen && scrollAtOpen.place === place ? scrollAtOpen.top : null;
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
