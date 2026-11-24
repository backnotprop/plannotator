/**
 * The layer Reviews' list shows selected beside an open stack, carried by the address, never remembered by the list.
 * What regresses: a layer's diff closing back to its stack without that layer selected (the top layer, whose key is the
 * stack's id, among them); a layer opened later from the stack's own page not taking the selection; a fresh way to the
 * stack (a row, a thread, a board tile) showing an old layer selected; and a phone's Back from a layer's diff no longer
 * being the browser's Back (the entry under it is the stack's page, without `&back=`, or the list when the diff was
 * opened from a layer's row there: never a new entry for the stack's page, so the window's Back and the swipe agree).
 */
import { describe, expect, test } from 'bun:test';
import { layerClosed, routeOf, type Route } from '../app/route';
import { hashOf } from '../app/writeRoute';
import { backHashOf, backOnClose, listUnder } from '../app/focus';
import { backLanded, type HistoryLike } from '../history';
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
const list: Route = { page: 'reviews', project: null, view: 'all', thread: null, stack: null, layer: null };

/** A history whose entry on screen was opened from `from` (history.ts `ibFrom`); counts its Backs. */
function opened(from: string): HistoryLike & { backs: number } {
  const history = { state: { ibFrom: from }, backs: 0, pushState: () => {}, back: () => (history.backs += 1) };
  return history;
}
/** A phone's Back from the diff: whether it was the browser's Back, then the next Back may start (the traversal landed). */
function phoneBack(route: Route, history: HistoryLike): boolean {
  const went = backOnClose(layerClosed(route), true, history);
  backLanded();
  return went;
}

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

  test("a phone's Back from a diff opened from the stack's page, after its list showed a layer: still that page's entry", () => {
    const history = opened(hashOf({ ...stackPage, backLayer: L412 }));
    expect(phoneBack(diff(L413), history)).toBe(true);
    expect(history.backs).toBe(1);
  });
});

describe("a layer's diff opened from the list (a layer's row)", () => {
  test("a phone's Back is the browser's Back to the list, not a new entry for the stack's page", () => {
    const history = opened(hashOf(list));
    expect(phoneBack(diff(L413), history)).toBe(true);
    expect(history.backs).toBe(1);
  });

  test('the list it lands on shows that layer selected, its stack unfolded, with no stack open', () => {
    const landed = listUnder(layerClosed(diff(L413)))!;
    expect(routeOf(hashOf(landed)).stack).toBeNull();
    expect(routeOf(hashOf(landed)).backLayer).toBe(L413);
    // The list's open row is the stack holding that layer (PullsPage `listed`), that layer's row the selected one.
    expect(selectedLayerOf(STACK, { threadId: null, stackId: null, layerId: routeOf(hashOf(landed)).backLayer })).toBe(L413);
  });

  test('opened again from that list, and from it the stack: each Back is still the browser\'s', () => {
    const shown = hashOf(listUnder(layerClosed(diff(L413)))!);
    const again = opened(shown);
    expect(phoneBack(diff(L412), again)).toBe(true);
    // The stack's page opened from the list showing a layer closes back to it (Reviews' `onOpenStack(null)`).
    const stack = opened(shown);
    expect(backOnClose(list, true, stack)).toBe(true);
    backLanded();
    expect(stack.backs).toBe(1);
  });

  test('a desktop keeps its new entry for the stack\'s page', () => {
    const history = opened(hashOf(list));
    expect(backOnClose(layerClosed(diff(L413)), false, history)).toBe(false);
    expect(history.backs).toBe(0);
  });
});

