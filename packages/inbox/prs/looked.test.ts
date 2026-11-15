/**
 * "Changed since you looked" (looked.ts). What regresses: a PR never opened marked as changed (every row would be),
 * a PR marked while its head is the one opened, a merged layer or one whose head the list does not name marked, the
 * kept map growing without end, and a stored value from elsewhere breaking the page.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxPull } from '@plannotator/core/inbox-types';
import { LOOKED_KEPT, changedLayers, changedSince, mergeLooked, parseLooked, withLooked } from './looked';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const pull = (over: Partial<Pick<InboxPull, 'key' | 'state' | 'head_sha'>> = {}) => ({ key: 'github.com/n/l#1', state: 'open' as const, head_sha: B, ...over });

describe('changed since the person looked', () => {
  test('a PR never opened is not marked', () => {
    expect(changedSince(pull(), {})).toBeNull();
  });

  test('a PR whose head is the one opened is not marked; another head is, with the look it changed since', () => {
    expect(changedSince(pull({ head_sha: A }), { 'github.com/n/l#1': { sha: A, at: 5 } })).toBeNull();
    expect(changedSince(pull(), { 'github.com/n/l#1': { sha: A, at: 5 } })).toEqual({ sha: A, at: 5 });
  });

  test('the head is compared without its case', () => {
    expect(changedSince(pull({ head_sha: A.toUpperCase() }), withLooked({}, [{ key: 'github.com/n/l#1', sha: A }], 1))).toBeNull();
  });

  test('a merged or closed PR, or one whose head the list does not name, is not marked', () => {
    const map = { 'github.com/n/l#1': { sha: A, at: 5 } };
    expect(changedSince(pull({ state: 'merged' }), map)).toBeNull();
    expect(changedSince(pull({ state: 'closed' }), map)).toBeNull();
    expect(changedSince(pull({ head_sha: null }), map)).toBeNull();
  });

  test("a stack's changed layers are the ones whose head moved", () => {
    const map = { 'k#1': { sha: A, at: 1 }, 'k#2': { sha: A, at: 1 } };
    const layers = [pull({ key: 'k#1', head_sha: A }), pull({ key: 'k#2' }), pull({ key: 'k#3' })] as InboxPull[];
    expect(changedLayers({ layers }, map).map((l) => l.key)).toEqual(['k#2']);
  });
});

describe('the kept map', () => {
  test('a look replaces the last one; a PR with no head named keeps what it had', () => {
    const map = withLooked({ k: { sha: A, at: 1 } }, [{ key: 'k', sha: B }, { key: 'j', sha: null }], 9);
    expect(map).toEqual({ k: { sha: B, at: 9 } });
  });

  test(`keeps the newest ${LOOKED_KEPT}`, () => {
    let map = {};
    for (let i = 0; i < LOOKED_KEPT + 3; i++) map = withLooked(map, [{ key: `k${i}`, sha: A }], i);
    expect(Object.keys(map)).toHaveLength(LOOKED_KEPT);
    expect(map).not.toHaveProperty('k0');
    expect(map).toHaveProperty(`k${LOOKED_KEPT + 2}`);
  });

  test('a stored value that is not the map is nothing kept, and bad entries are dropped', () => {
    expect(parseLooked('not json')).toEqual({});
    expect(parseLooked('[1,2]')).toEqual({});
    expect(parseLooked(JSON.stringify({ k: { sha: A, at: 1 }, j: { sha: 3 }, h: null }))).toEqual({ k: { sha: A, at: 1 } });
  });

  test("the machine's look and this browser's: the newer of the two wins", () => {
    const B = 'b'.repeat(40);
    const local = { k: { sha: A, at: 5 }, j: { sha: A, at: 5 } };
    const merged = mergeLooked(local, [{ key: 'k', looked: { sha: B, at: 9 } }, { key: 'j', looked: { sha: B, at: 1 } }, { key: 'n', looked: { sha: B, at: 1 } }]);
    expect(merged).toEqual({ k: { sha: B, at: 9 }, j: { sha: A, at: 5 }, n: { sha: B, at: 1 } });
  });
});
