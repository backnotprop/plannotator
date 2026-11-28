/**
 * The native app's contract helpers (apps/mobile/contract,
 * docs/agent-guides/mobile.md), checked on fixed inputs only. Whether the
 * committed contract files are in step with the product, and the generators'
 * own rules on the live product (door.json, the schema, the words), is
 * scripts/mobile/check.ts, run by the mobile-contract workflow and never by a
 * unit lane: this file imports no product code, so an Inbox pull request
 * never fails here.
 *
 * What can regress, and the test that says so:
 *  - the check passing a stale or missing file ("the check finds");
 *  - a color drawn other than the CSS says ("colors").
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, type Output } from '../scripts/mobile/lib';
import { displayP3, linearSrgb, srgbHex } from '../scripts/mobile/tokens';

describe('the generators', () => {
  test('the check finds a stale or a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mobile-contract-'));
    const outputs: Output[] = [{ path: 'a/x.json', text: '{}\n' }];
    expect(emit(outputs, true, dir), 'missing').toEqual(['a/x.json']);
    emit(outputs, false, dir);
    expect(emit(outputs, true, dir), 'written').toEqual([]);
    expect(emit([{ path: 'a/x.json', text: '{ }\n' }], true, dir), 'changed').toEqual(['a/x.json']);
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
