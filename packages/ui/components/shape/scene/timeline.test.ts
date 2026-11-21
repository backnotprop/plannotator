import { describe, expect, test } from 'bun:test';
import type { ShapeScene, ShapeSceneKey } from '@plannotator/core/shape-scene';
import { beatAt, colourCss, eased, lookAt, nextBeatTime, places, reducedTime, type Geo } from './timeline';

// A straight wire from (0,0) to (100,0) bent at (100,0) down to (100,100): a point along it is not on the chord.
const geo: Geo = {
  home: (id) => (id === 'job' ? { x: 5, y: 5 } : id === 'box' ? { x: 50, y: 80 } : null),
  along: (id, p) => (id === 'wire' ? (p <= 0.5 ? { x: 200 * p, y: 0 } : { x: 100, y: 200 * (p - 0.5) }) : null),
};
const at = (keys: ShapeSceneKey[], t: number) => lookAt(keys, places('job', keys, geo), t, geo);

describe('scene timeline', () => {
  test('two keys on one path move along the path, not across the chord', () => {
    const keys: ShapeSceneKey[] = [{ at: 0, along: 'wire', p: 0 }, { at: 10, along: 'wire', p: 1, ease: 'linear' }];
    expect(at(keys, 7.5).at).toEqual({ x: 100, y: 50 });
  });

  test('a missing axis keeps its last value, starting from where the piece is drawn', () => {
    const keys: ShapeSceneKey[] = [{ at: 0, x: 40 }, { at: 10, y: 90, ease: 'linear' }];
    expect(at(keys, 0).at).toEqual({ x: 40, y: 5 });
    expect(at(keys, 10).at).toEqual({ x: 40, y: 90 });
  });

  test('before its first key a piece looks as that key says; after the last it holds; jump waits for its time', () => {
    const keys: ShapeSceneKey[] = [{ at: 4, opacity: 0 }, { at: 6, opacity: 1, ease: 'jump' }, { at: 8, to: 'box' }];
    expect(at(keys, 0).opacity).toBe(0);
    expect(at(keys, 5.99).opacity).toBe(0);
    expect(at(keys, 6).opacity).toBe(1);
    expect(at(keys, 99).at).toEqual({ x: 50, y: 80 });
  });

  test('words switch at their key and colours mix on the way', () => {
    const keys: ShapeSceneKey[] = [{ at: 0, text: 'idle', color: 'grey' }, { at: 10, text: 'busy', color: 'alert', ease: 'linear' }];
    expect(at(keys, 9).text).toBe('idle');
    expect(at(keys, 10).text).toBe('busy');
    expect(colourCss(at(keys, 5).color!)).toBe('color-mix(in oklab, var(--grey) 50.0%, var(--alert))');
  });

  test('the caption is the last beat at or before the time', () => {
    const s = { beats: [{ at: 0, say: 'a' }, { at: 5, say: 'b' }, { at: 9, say: 'c' }] } as ShapeScene;
    expect([beatAt(s, 0), beatAt(s, 4.9), beatAt(s, 5), beatAt(s, 100)]).toEqual([0, 0, 1, 2]);
  });

  test('smooth eases in and out, linear is steady, jump holds to the end', () => {
    expect(eased('linear', 0.25)).toBe(0.25);
    expect(eased(undefined, 0.25)).toBeLessThan(0.25);
    expect(eased(undefined, 0.75)).toBeGreaterThan(0.75);
    expect(eased(undefined, 0.5)).toBeCloseTo(0.5);
    expect([eased('jump', 0.99), eased('jump', 1)]).toEqual([0, 1]);
  });

  test('scaleX and scaleY tween on their own, apart from scale', () => {
    const keys: ShapeSceneKey[] = [{ at: 0, scaleY: 0, scale: 1 }, { at: 10, scaleY: 1, ease: 'linear' }];
    const mid = at(keys, 5);
    expect(mid.scaleY).toBeCloseTo(0.5);
    expect(mid.scale).toBe(1);
    expect(mid.scaleX).toBeUndefined();
  });
});

describe('reduced motion: only beats, never between them', () => {
  const s = { end: 20, beats: [{ at: 0, say: 'a' }, { at: 5, say: 'b' }, { at: 12, say: 'c' }] } as ShapeScene;
  // What regresses: a drag under reduced motion lands half way through a move, or Play steps past the last beat.
  test('a drag lands on the beat at or before it', () => {
    expect([reducedTime(s, 0), reducedTime(s, 4.9), reducedTime(s, 5), reducedTime(s, 19)]).toEqual([0, 0, 5, 12]);
  });
  test('Play shows the next beat, and stops after the last', () => {
    expect([nextBeatTime(s, 0), nextBeatTime(s, 5), nextBeatTime(s, 7)]).toEqual([5, 12, 12]);
    expect(nextBeatTime(s, 12)).toBeNull();
  });
});
