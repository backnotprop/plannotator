import { expect, test } from 'bun:test';
import { inboxShortcutRegistry, inboxThreadShortcuts } from './shortcuts';
import { MAP_COLUMNS } from './shortcuts/map';

const listed = new Set(MAP_COLUMNS.flat().flatMap((group) => group.rows.flatMap((row) => [...row.keys, ...(row.also ?? [])])).map((ref) => `${ref.scope.id}.${ref.action}`));
const known = new Set(inboxShortcutRegistry.flatMap((scope) => Object.keys(scope.shortcuts).map((action) => `${scope.id}.${action}`)));

const HELD = new Set<string>();

test('every registry action has a row on the map', () => {
  expect([...known].filter((id) => !listed.has(id))).toEqual([]);
});

test('every map row names an action the registry has, the held ones aside', () => {
  expect([...listed].filter((id) => !known.has(id) && !HELD.has(id))).toEqual([]);
  expect([...HELD].filter((id) => known.has(id))).toEqual([]);
});

test('the legend lists Q (open questions and action items) in the Thread group', () => {
  const thread = MAP_COLUMNS.flat().find((group) => group.title === 'Thread')!;
  expect(thread.rows.some((r) => r.keys.some((ref) => ref.action === 'openItems'))).toBe(true);
  expect(inboxThreadShortcuts.shortcuts.openItems.bindings).toEqual(['Q']);
});
