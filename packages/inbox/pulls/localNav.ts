/** Opening and closing a Reviews "On this computer" row's diff (localRoute.ts is its address). */
import { writeRoute } from '../app/writeRoute';
import { closeTo } from '../app/focus';
import { readRoute } from '../app/route';
import type { LocalOpen } from './localRoute';

/**
 * Open a row's diff beside the list (a phone: in its place), in place of a PR's pane or a drawing. One diff after
 * another on a desktop replaces the entry, as a PR's pane does.
 */
export function openLocal(open: LocalOpen, phone: boolean): void {
  const route = readRoute();
  writeRoute({ ...route, page: 'reviews', thread: null, stack: null, layer: null, system: null, sheet: null, full: false, local: open }, { replace: !!route.local && !phone });
}

/** Back to the list: the way the diff was opened (a phone's Back is the browser's). */
export function closeLocal(): void {
  closeTo({ ...readRoute(), local: null });
}
