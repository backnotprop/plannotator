/**
 * System's part of the Reviews address (route.ts), which App's routeOf, hashOf, Escape ladder and every new Reviews
 * address go through. What regresses: a sheet or full window without a drawing, a PR opened from the full window
 * closing to the pane, a leftover drawing link kept (or Escape caught) while System does not show, or Escape skipping
 * the full window, closing the drawing under a PR's pane.
 */
import { expect, test } from 'bun:test';
import { systemDropped, systemEscapeTo, systemHashOf, systemKept, systemRouteOf } from './route';

const at = (hash: string) => systemRouteOf(new URLSearchParams(hash));

test('the address: the drawing, its sheet and the full window; a sheet or full window alone means nothing', () => {
  expect(at('reviews&system=prj_1&sheet=L-101&full=1')).toEqual({ system: 'prj_1', sheet: 'L-101', full: true });
  expect(at('reviews&sheet=L-101&full=1')).toEqual({ system: null, sheet: null, full: false });
  expect(at('reviews&system=prj_1&full=yes')).toEqual({ system: 'prj_1', sheet: null, full: false });
  for (const hash of ['system=prj_1', 'system=prj_1&sheet=C-001', 'system=prj_1&sheet=C-001&full=1', 'system=prj%201&sheet=L%2F1']) {
    expect(systemHashOf(at(hash))).toBe(`&${hash}`);
  }
  expect(systemHashOf({ system: null, sheet: 'C-001', full: true })).toBe('');
});

test('a new Reviews address keeps the drawing as it was (the full window too), only while System shows', () => {
  const route = { system: 'prj_1', sheet: 'L-101', full: true };
  expect(systemKept(route, true)).toEqual(route);
  expect(systemKept(route, false)).toEqual({ system: null, sheet: null, full: false });
  expect(systemKept({ system: null, sheet: 'L-101', full: true }, true)).toEqual({ system: null, sheet: null, full: false });
});

test('System not shown: a leftover drawing link on Reviews is dropped; anything else is left alone', () => {
  const route: { page: string; project: string; stack: string; system: string | null; sheet: string | null; full: boolean } = { page: 'reviews', project: 'prj_9', stack: 'k', system: 'prj_1', sheet: 'L-101', full: true };
  expect(systemDropped(route, false)).toEqual({ ...route, system: null, sheet: null, full: false });
  expect(systemDropped(route, true)).toBeNull();
  expect(systemDropped({ page: 'reviews', system: null, sheet: null, full: false }, false)).toBeNull();
  expect(systemDropped({ page: 'inbox', system: 'prj_1' }, false)).toBeNull();
});

test('Escape: the full window, then the drawing, then nothing; never under a PR\'s pane or while System does not show', () => {
  const full: { page: string; stack: string | null; system: string | null; sheet: string | null; full: boolean } = { page: 'reviews', stack: null, system: 'prj_1', sheet: 'L-101', full: true };
  const pane = systemEscapeTo(full, true)!;
  expect(pane).toEqual({ ...full, full: false });
  const closed = systemEscapeTo(pane, true)!;
  expect(closed).toEqual({ ...full, system: null, sheet: null, full: false });
  expect(systemEscapeTo(closed, true)).toBeNull();
  expect(systemEscapeTo({ ...full, stack: 'github.com/acme/app#1' }, true)).toBeNull();
  expect(systemEscapeTo(full, false)).toBeNull();
  expect(systemEscapeTo({ ...full, page: 'inbox' }, true)).toBeNull();
});
