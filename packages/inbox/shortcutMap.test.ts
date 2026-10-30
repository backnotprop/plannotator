/**
 * The shortcut map (components/ShortcutMap.tsx, laid out in shortcuts/map.ts)
 * lists every Inbox key: a key added to the registry and left off the map
 * fails here, and so does a map row naming an action the registry lacks.
 */
import { expect, test } from 'bun:test';
import { inboxShortcutRegistry } from './shortcuts';
import { MAP_COLUMNS } from './shortcuts/map';

const listed = new Set(MAP_COLUMNS.flat().flatMap((group) => group.rows.flatMap((row) => [...row.keys, ...(row.also ?? [])])).map((ref) => `${ref.scope.id}.${ref.action}`));
const known = new Set(inboxShortcutRegistry.flatMap((scope) => Object.keys(scope.shortcuts).map((action) => `${scope.id}.${action}`)));

/** Actions on the map that the registry does not have yet, each landing with its key. */
const HELD = new Set<string>(); // Map rows whose action waits for a fix to land (none now).

test('every registry action has a row on the map', () => {
  expect([...known].filter((id) => !listed.has(id))).toEqual([]);
});

test('every map row names an action the registry has, the held ones aside', () => {
  expect([...listed].filter((id) => !known.has(id) && !HELD.has(id))).toEqual([]);
  // A held action that lands in the registry comes out of HELD.
  expect([...HELD].filter((id) => known.has(id))).toEqual([]);
});
