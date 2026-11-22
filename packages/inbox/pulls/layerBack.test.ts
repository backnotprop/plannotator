/**
 * The layer Reviews' list shows selected beside an open stack, carried by the address, never remembered by the list.
 * What regresses: a layer's diff closing back to its stack without that layer selected (the top layer, whose key is the
 * stack's id, among them); a layer opened later from the stack's own page not taking the selection; a fresh way to the
 * stack (a row, a thread, a board tile) showing an old layer selected; and a phone's Back from a layer's diff no longer
 * being the browser's Back (the entry under it is the stack's page, without `&back=`).
 */
import { describe, expect, test } from 'bun:test';
import { layerClosed, routeOf, type Route } from '../app/route';
import { hashOf } from '../app/writeRoute';
import { backHashOf } from '../app/focus';
import { selectedLayerOf } from './selectedLayer';

const STACK = 'github.com/northwind/billing-svc#414';
const L412 = 'github.com/northwind/billing-svc#412';
const L413 = 'github.com/northwind/billing-svc#413';

/** The list's selected layer for the address on screen, as App and PullsPage read it. */
const listLayer = (hash: string) => {
  const route = routeOf(hash);
  return selectedLayerOf(STACK, { threadId: route.thread, stackId: route.stack ?? null, layerId: route.layer ?? route.backLayer ?? null });
};
const diff = (layer: string): Route => ({ page: 'reviews', project: null, view: 'all', thread: null, stack: STACK, layer, scope: 'layer' });
const stackPage: Route = { page: 'reviews', project: null, view: 'all', thread: null, stack: STACK, layer: null };

describe("a layer's diff closed back to its stack", () => {
  test('the layer it closed from is the selected one, through the address', () => {
    expect(listLayer(hashOf(layerClosed(diff(L412))))).toBe(L412);
    expect(routeOf(hashOf(layerClosed(diff(L412)))).layer).toBeNull();
  });

  test("then a layer opened from the stack's own page: that layer, not the first", () => {
    const back = routeOf(hashOf(layerClosed(diff(L412))));
    // The stack page's Landing order opens #413's diff (App's `go({ ...route, layer, scope })`).
    const next = routeOf(hashOf({ ...back, layer: L413, scope: 'layer' }));
    expect(listLayer(hashOf(layerClosed(next)))).toBe(L413);
  });

  test("the top layer, whose key is the stack's id: its own row, not the stack's", () => {
    expect(listLayer(hashOf(layerClosed(diff(STACK))))).toBe(STACK);
    // Opened by its id alone, it is the stack.
    expect(listLayer(hashOf(stackPage))).toBeNull();
  });

  test('a fresh way to the stack shows the stack, whatever was closed before', () => {
    expect(listLayer(hashOf(stackPage))).toBeNull();
    // A stack opened by a lower layer's own key still unfolds onto that layer.
    expect(listLayer(hashOf({ ...stackPage, stack: L412 }))).toBe(L412);
    // Beside a thread opened from Reviews, no layer.
    expect(selectedLayerOf(STACK, { threadId: 'thr_1', stackId: STACK, layerId: L412 })).toBeNull();
  });

  test("a phone's Back from the diff goes back to the stack's page entry, not a new one", () => {
    expect(backHashOf(layerClosed(diff(L413)))).toBe(hashOf(stackPage));
  });
});
