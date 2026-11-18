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
 *    computer's route ("door.json is the door");
 *  - a color drawn other than the CSS says ("colors");
 *  - a word template that no longer prints what the window prints ("words").
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doorRouteNames, doorRouteOf } from '../packages/server/inbox-devices';
import { doorEntries, generateDoor } from '../scripts/mobile/door';
import { emit, type Output } from '../scripts/mobile/lib';
import { generateSchema } from '../scripts/mobile/schema';
import { generateSurface } from '../scripts/mobile/surface';
import { generateVectors } from '../scripts/mobile/vectors';
import { generateSwift } from '../scripts/mobile/swift';
import { displayP3, generateTokens, linearSrgb, srgbHex } from '../scripts/mobile/tokens';
import { buildWords, generateWords } from '../scripts/mobile/words';
import { reaskRowLine, sentRowLine } from '../packages/core/inbox-delivery-line';
import { INBOX_SECTIONS } from '../packages/core/inbox-types';

const GENERATORS: [string, () => Output[] | Promise<Output[]>][] = [
  ['door', generateDoor],
  ['schema', generateSchema],
  ['swift', generateSwift],
  ['tokens', generateTokens],
  ['words', generateWords],
  ['surface', generateSurface],
  ['vectors', generateVectors],
];
const sample = (path: string) => path.replace(/\{path\}/g, 'a/b.png').replace(/\{card\}/g, 'crd_x').replace(/\{combine\}/g, 'cmb_x').replace(/\{action\}/g, 'a-0123abcd').replace(/\{\w+\}/g, 'x_1');

describe('the contract is up to date', () => {
  for (const [name, generate] of GENERATORS) {
    test(`${name} is up to date (else: bun scripts/mobile/${name}.ts)`, async () => {
      expect(emit(await generate(), true)).toEqual([]);
    }, 10_000);
  }

  test('the same input gives the same bytes', async () => {
    for (const [name, generate] of GENERATORS) expect((await generate()).map((o) => o.text), name).toEqual((await generate()).map((o) => o.text));
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

describe('colors', () => {
  test('oklch and hex convert to the sRGB and Display P3 a browser draws', () => {
    // CSS Color 4's own reference points: sRGB red, green and blue, and white.
    expect(srgbHex(linearSrgb('oklch(0.62796 0.25768 29.234)')!)).toBe('#ff0000');
    expect(srgbHex(linearSrgb('oklch(0.86644 0.29483 142.495)')!)).toBe('#00ff00');
    expect(srgbHex(linearSrgb('oklch(0.45201 0.31321 264.052)')!)).toBe('#0000ff');
    expect(displayP3(linearSrgb('oklch(1 0 0)')!)).toEqual([1, 1, 1]);
    expect(displayP3(linearSrgb('#ff0000')!)).toEqual([0.9175, 0.2003, 0.1386]);
    expect(srgbHex(linearSrgb('#336699')!)).toBe('#336699');
    expect(linearSrgb('0.625rem')).toBeNull();
  });
});

describe('words', () => {
  const words = buildWords();
  const fill = (key: string, parts: Record<string, string>) => words[key]!.text.replace(/\{(\w+)\}/g, (_, p: string) => parts[p]!);

  test('a template filled in prints what the window prints', () => {
    expect(fill('delivery.sent_queued', { name: 'Ada' })).toBe(sentRowLine('Ada', true));
    expect(fill('delivery.sent_saved', { name: 'Ada' })).toBe(sentRowLine('Ada', false));
    expect(fill('delivery.reask_waiting', { name: 'Ada' })).toBe(reaskRowLine('Ada', '2026-02-02T00:00:00.000Z', false));
    expect(fill('delivery.reask_saved', { name: 'Ada' })).toBe(reaskRowLine('Ada', null, false));
  });

  test('every section has its name', () => {
    for (const { id, label } of INBOX_SECTIONS) expect(words[`section.${id}`]?.text, id).toBe(label);
  });
});
