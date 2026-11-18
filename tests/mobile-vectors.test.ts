/**
 * The native app's contract (apps/mobile/contract, docs/agent-guides/mobile.md)
 * is what the product's code makes of itself today. Every generator runs with
 * its check: a change to the door, the wire types, the window's error codes or
 * a generator that leaves a committed contract file behind fails here, with the
 * command that brings it up to date.
 *
 * What can regress, and the test that says so:
 *  - a door route, write kind or wire type changed without regenerating
 *    door.json, the schema or Wire.swift ("is up to date");
 *  - a generator whose output depends on more than its input: a second run
 *    gives other bytes ("the same input gives the same bytes");
 *  - the check passing a stale or missing file ("the check finds");
 *  - the route table losing a door route, or a phone reaching a linked
 *    computer's route ("door.json is the door").
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doorRouteNames, doorRouteOf } from '../packages/server/inbox-devices';
import { doorEntries, generateDoor } from '../scripts/mobile/door';
import { emit, type Output } from '../scripts/mobile/lib';
import { generateSchema } from '../scripts/mobile/schema';
import { generateSwift } from '../scripts/mobile/swift';

const GENERATORS: [string, () => Output[]][] = [['door', generateDoor], ['schema', generateSchema], ['swift', generateSwift]];
const sample = (path: string) => path.replace(/\{path\}/g, 'a/b.png').replace(/\{card\}/g, 'crd_x').replace(/\{combine\}/g, 'cmb_x').replace(/\{action\}/g, 'a-0123abcd').replace(/\{\w+\}/g, 'x_1');

describe('the contract is up to date', () => {
  for (const [name, generate] of GENERATORS) {
    test(`${name} is up to date (else: bun scripts/mobile/${name}.ts)`, () => {
      expect(emit(generate(), true)).toEqual([]);
    }, 10_000);
  }

  test('the same input gives the same bytes', () => {
    for (const [name, generate] of GENERATORS) expect(generate().map((o) => o.text), name).toEqual(generate().map((o) => o.text));
  }, 10_000);

  test('the check finds a stale or a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mobile-contract-'));
    const outputs: Output[] = [{ path: 'a/x.json', text: '{}\n' }];
    expect(emit(outputs, true, dir), 'missing').toEqual(['a/x.json']);
    emit(outputs, false, dir);
    expect(emit(outputs, true, dir), 'written').toEqual([]);
    expect(emit([{ path: 'a/x.json', text: '{ }\n' }], true, dir), 'changed').toEqual(['a/x.json']);
  });
});

describe('door.json is the door', () => {
  const entries = doorEntries();

  test('every door entry is there, and each route reaches the door entry it names', () => {
    expect([...new Set(entries.map((e) => e.door_name))].filter((n) => n !== 'POST pair' && n !== 'POST revoke')).toEqual(doorRouteNames());
    for (const e of entries.filter((x) => x.window)) {
      const asMachine = doorRouteOf(e.method, sample(e.path), true);
      expect(asMachine, e.name).not.toBeNull();
      expect(doorRouteOf(e.method, sample(e.path), false) !== null, `${e.name} grant`).toBe(e.grant === 'phone');
    }
  });

  test('a write has its key and its kind; a raw upload is never relayed', () => {
    for (const e of entries) {
      if (e.method === 'GET') expect([e.kind, e.key], e.name).toEqual(['read', null]);
      else if (e.kind === 'bytes') expect([e.key, e.relay], e.name).toEqual(['query', false]);
      else if (e.auth === 'token' && e.name !== 'POST revoke') expect(e.key, e.name).toBe('body');
    }
    expect(entries.find((e) => e.name === 'GET events')!.relay).toBe(false);
    expect(entries.find((e) => e.name === 'POST pair')!.auth).toBe('none');
  });
});
