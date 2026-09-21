/**
 * Change tracker contract, no DOM.
 *
 * Regressions guarded: new id -> new seq; edited text -> new seq; removal ->
 * tombstone flagged agent-authored or not; the agent's own creations are
 * never new to it while a human edit of them is; an explicit `since`
 * overrides the implicit watermark; `advance` never runs backwards; the
 * per-path set keeps independent watermarks and activity times.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationChangeTracker, BROWSER_AGENT_SOURCE, ChangeTrackerSet, MAX_TOMBSTONES, type TrackedAnnotation } from './changes';

const human = (id: string, text: string): TrackedAnnotation => ({ id, text, originalText: 'q' });
const agent = (id: string, text: string): TrackedAnnotation => ({ id, text, originalText: 'q', source: BROWSER_AGENT_SOURCE });

describe('AnnotationChangeTracker', () => {
  test('a new id gets the next seq and is new until the watermark advances', () => {
    const tracker = new AnnotationChangeTracker(() => 1000);
    tracker.observe([human('a', 'one')]);
    expect(tracker.seqOf('a')).toBe(1);
    expect(tracker.newSince()).toEqual(['a']);
    tracker.advance();
    expect(tracker.newSince()).toEqual([]);
    expect(tracker.cursor()).toBe('w:1');
    expect(tracker.lastActivity).toBe(1000);
  });

  test('an edited text gets a new seq; an unchanged one keeps its seq', () => {
    const tracker = new AnnotationChangeTracker();
    tracker.observe([human('a', 'one'), human('b', 'two')]);
    tracker.advance();
    const delta = tracker.observe([human('a', 'one'), human('b', 'two!')]);
    expect(delta).toEqual({ added: [], changed: ['b'], removed: [] });
    expect(tracker.seqOf('a')).toBe(1);
    expect(tracker.seqOf('b')).toBe(3);
    expect(tracker.newSince()).toEqual(['b']);
  });

  test('a removal writes a tombstone that says whether the agent authored it', () => {
    const tracker = new AnnotationChangeTracker();
    tracker.observe([human('h', 'x'), agent('g', 'y')]);
    tracker.advance();
    const delta = tracker.observe([]);
    expect(delta.removed.map((t) => [t.id, t.agent])).toEqual([['h', false], ['g', true]]);
    expect(tracker.removedSince().map((t) => t.id).sort()).toEqual(['g', 'h']);
    expect(tracker.knows('g')).toBe(true);
    expect(tracker.seqOf('g')).toBeUndefined();
  });

  test('the agent never sees its own creation as new, but does see the human editing it', () => {
    const tracker = new AnnotationChangeTracker();
    const mine = agent('m', 'my comment');
    tracker.claimOwn(mine);
    tracker.observe([mine]);
    expect(tracker.newSince()).toEqual([]);
    expect(tracker.isNew('m')).toBe(false);
    tracker.observe([agent('m', 'the human reworded this')]);
    expect(tracker.newSince()).toEqual(['m']);
  });

  test('claimOwn after observe (state already present) also marks it not-new', () => {
    const tracker = new AnnotationChangeTracker();
    const mine = agent('m', 'text');
    tracker.observe([mine]);
    tracker.claimOwn(mine);
    expect(tracker.isNew('m')).toBe(false);
  });

  test('an explicit since overrides the implicit watermark', () => {
    const tracker = new AnnotationChangeTracker();
    tracker.observe([human('a', '1')]);
    tracker.observe([human('a', '1'), human('b', '2')]);
    tracker.advance();
    expect(tracker.newSince()).toEqual([]);
    expect(tracker.newSince(0)).toEqual(['a', 'b']);
    expect(tracker.newSince(1)).toEqual(['b']);
    expect(AnnotationChangeTracker.parseSince('w:1')).toBe(1);
    expect(AnnotationChangeTracker.parseSince(2)).toBe(2);
    expect(AnnotationChangeTracker.parseSince('junk')).toBeNull();
  });

  test('advance never runs backwards nor past the current seq', () => {
    const tracker = new AnnotationChangeTracker();
    tracker.observe([human('a', '1'), human('b', '2')]);
    tracker.advance(99);
    expect(tracker.watermark).toBe(2);
    tracker.advance(0);
    expect(tracker.watermark).toBe(2);
  });

  test('a re-added id after removal clears its tombstone', () => {
    const tracker = new AnnotationChangeTracker();
    tracker.observe([human('a', '1')]);
    tracker.observe([]);
    tracker.observe([human('a', '1')]);
    expect(tracker.removedSince(0)).toEqual([]);
    expect(tracker.seqOf('a')).toBe(3);
  });

  // A create/delete loop of 5,000 left tombstones, ownHashes and ownSeqs at
  // 5,000 each for the life of the tab: nothing was ever evicted.
  test('tombstones and the ownership records of forgotten ids are evicted oldest first past MAX_TOMBSTONES', () => {
    const tracker = new AnnotationChangeTracker();
    const total = MAX_TOMBSTONES + 500;
    for (let i = 0; i < total; i++) {
      const id = `a-${i}`;
      tracker.claimOwn({ id, text: 'x' });
      tracker.observe([{ id, text: 'x' }]);
      tracker.observe([]);
    }
    const removed = tracker.removedSince(0);
    expect(removed.length).toBe(MAX_TOMBSTONES);
    // The oldest 500 are gone, the newest MAX_TOMBSTONES remain, in order.
    expect(removed[0].id).toBe('a-500');
    expect(removed[removed.length - 1].id).toBe(`a-${total - 1}`);
    expect(tracker.knows('a-0')).toBe(false);
    expect(tracker.isOwn('a-0')).toBe(false);
    expect(tracker.knows('a-500')).toBe(true);
    expect(tracker.isOwn(`a-${total - 1}`)).toBe(true);
  });
});

describe('ChangeTrackerSet', () => {
  test('paths track independently with their own activity time', () => {
    let now = 1;
    const set = new ChangeTrackerSet(() => now++);
    set.forPath('a.md').observe([human('x', '1')]);
    set.forPath('b.md').observe([human('y', '1')]);
    set.forPath('a.md').advance();
    expect(set.forPath('a.md').newSince()).toEqual([]);
    expect(set.forPath('b.md').newSince()).toEqual(['y']);
    expect(set.forPath('a.md').lastActivity).toBe(1);
    expect(set.forPath('b.md').lastActivity).toBe(2);
    expect(set.paths().sort()).toEqual(['a.md', 'b.md']);
  });
});
