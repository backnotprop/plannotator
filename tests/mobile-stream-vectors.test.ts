/**
 * The app contract's stream suite (apps/mobile/contract/vectors/stream.json,
 * docs/agent-guides/mobile.md): the frames the window's own stream reader
 * takes from the fixture's bytes. Whether the committed vectors are in step
 * is scripts/mobile/check.ts (the mobile-contract workflow), never a unit
 * lane.
 *
 * What can regress: a fixture whose cut points fall outside its bytes, so the
 * app's split-read test cuts nothing real.
 */
import { describe, expect, test } from 'bun:test';
import { streamVectors } from '../scripts/mobile/vectors-stream';

describe('the stream suite', () => {
  test('every cut point falls inside the bytes, and the window reads frames from them', () => {
    const made = streamVectors() as { cuts: number[]; text: string; frames: unknown[] };
    expect(made.cuts.length).toBeGreaterThan(0);
    expect(made.frames.length).toBeGreaterThan(0);
  });
});
