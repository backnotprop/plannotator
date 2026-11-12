import { describe, expect, test } from 'bun:test';
import { sceneFrameFromHash } from './frame';

describe('the frame address', () => {
  test('reads frame and at, and nothing without both', () => {
    expect(sceneFrameFromHash('#shape=shp_1&view=how&frame=pool&at=12.5')).toEqual({ scene: 'pool', at: 12.5 });
    expect(sceneFrameFromHash('#shape=shp_1&frame=pool&at=0')).toEqual({ scene: 'pool', at: 0 });
    for (const hash of ['#shape=shp_1', '#shape=shp_1&frame=pool', '#shape=shp_1&at=3', '#frame=pool&at=-1', '#frame=pool&at=x', '#frame=a%20b&at=1']) expect(sceneFrameFromHash(hash)).toBeNull();
  });
});
