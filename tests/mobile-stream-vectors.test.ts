/**
 * The app contract's stream suite (apps/mobile/contract/vectors/stream.json,
 * docs/agent-guides/mobile.md) is what the window's own stream reader takes
 * from the fixture's bytes. Apart from tests/mobile-vectors.test.ts because
 * its generator imports the window's reader.
 *
 * What can regress: the window's reader changing what it takes from a stream
 * (a frame name added or dropped, `id` or multi-line `data` read differently)
 * without the app's vectors following.
 */
import { describe, expect, test } from 'bun:test';
import { emit } from '../scripts/mobile/lib';
import { generateStreamVectors } from '../scripts/mobile/vectors-stream';

describe('the stream suite', () => {
  test('is up to date (else: bun scripts/mobile/all.ts)', () => {
    expect(emit(generateStreamVectors(), true)).toEqual([]);
  }, 10_000);
});
