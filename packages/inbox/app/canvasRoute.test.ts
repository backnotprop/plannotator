/**
 * The thread canvas's part of the address (route.ts `routeOf`, writeRoute.ts `hashOf`): `&canvas` beside the
 * thread, `&canvas=full`, `&cv=N` for an older version. What regresses: a reload or a shared link opening the canvas
 * the wrong way, the canvas kept over an open file, or the flag written as `canvas=` so links stop matching.
 */
import { expect, test } from 'bun:test';
import { routeOf } from './route';
import { hashOf } from './writeRoute';

const T = 'msg_01M7NQW4XEMG1FHP7SNPFAAE0Y';

test('beside the thread, full screen, and an older version', () => {
  expect(routeOf(`#thread=${T}&canvas`).canvas).toEqual({ view: 'side', version: null });
  expect(routeOf(`#thread=${T}&canvas=full`).canvas).toEqual({ view: 'full', version: null });
  expect(routeOf(`#thread=${T}&canvas&cv=2`).canvas).toEqual({ view: 'side', version: 2 });
  expect(routeOf(`#thread=${T}&canvas=full&cv=12`).canvas).toEqual({ view: 'full', version: 12 });
});

test('a bad version reads as now; any other view reads as beside', () => {
  for (const cv of ['0', '-1', 'abc', '1.5', '01']) expect(routeOf(`#thread=${T}&canvas&cv=${cv}`).canvas).toEqual({ view: 'side', version: null });
  expect(routeOf(`#thread=${T}&canvas=wide`).canvas).toEqual({ view: 'side', version: null });
});

test('no canvas without a thread, with a file open, or without the flag', () => {
  expect(routeOf('#canvas').canvas ?? null).toBeNull();
  expect(routeOf(`#thread=${T}&file=att_1&canvas`).canvas).toBeNull();
  expect(routeOf(`#thread=${T}&cv=2`).canvas).toBeNull();
});

test('written back the way it was read: the flag without its `=`', () => {
  for (const hash of [`#thread=${T}&canvas`, `#thread=${T}&canvas=full`, `#thread=${T}&canvas&cv=3`, `#thread=${T}&canvas=full&cv=3`]) {
    expect(hashOf(routeOf(hash))).toBe(hash);
  }
  const route = routeOf(`#thread=${T}&canvas&cv=3`);
  expect(hashOf({ ...route, canvas: null })).toBe(`#thread=${T}`);
});
