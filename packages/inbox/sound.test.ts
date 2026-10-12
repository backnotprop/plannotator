/**
 * When the question sound rings (sound.ts `decideRing`): once per burst,
 * only while no Inbox tab is in front, never with the sound off. A burst is
 * questions less than 30 s apart; coming to the front ends it; a ring another
 * tab reported joins this tab to that burst.
 */
import { describe, expect, test } from 'bun:test';
import { DING_DONG, decideRing, heardRing, QUIET_GATE, RING_BURST_MS, type RingGate } from './sound';
import { inboxNotificationOptions } from './notify';

const away = { enabled: true, inFront: false, otherTabInFront: false };

/** Questions arriving at these times (ms), all while away: which of them ring. */
function rings(times: number[], start: RingGate = QUIET_GATE): boolean[] {
  let gate = start;
  return times.map((now) => {
    const decided = decideRing(gate, { ...away, now });
    gate = decided.gate;
    return decided.ring;
  });
}

describe('decideRing', () => {
  test('the first question while away rings; a burst of three rings once', () => {
    expect(rings([0])).toEqual([true]);
    expect(rings([0, 400, 900])).toEqual([true, false, false]);
  });

  test('each question extends the burst: questions 20 s apart never ring again', () => {
    expect(rings([0, 20_000, 40_000, 60_000])).toEqual([true, false, false, false]);
  });

  test('after 30 s of quiet the next question rings again', () => {
    expect(rings([0, RING_BURST_MS - 1, 2 * RING_BURST_MS - 1])).toEqual([true, false, true]);
    expect(rings([0, RING_BURST_MS])).toEqual([true, true]);
  });

  test('this tab or another Inbox tab in front: no ring, and the burst ends', () => {
    let gate = decideRing(QUIET_GATE, { ...away, now: 0 }).gate;
    const front = decideRing(gate, { ...away, now: 1000, inFront: true });
    expect(front).toEqual({ ring: false, gate: QUIET_GATE });
    expect(decideRing(gate, { ...away, now: 1000, otherTabInFront: true })).toEqual({ ring: false, gate: QUIET_GATE });
    // Away again a moment later: the next question starts a new burst and rings.
    gate = front.gate;
    expect(decideRing(gate, { ...away, now: 2000 }).ring).toBe(true);
  });

  test('sound off: never rings, and leaves the burst as it was', () => {
    const gate = { lastAt: 5 };
    expect(decideRing(gate, { ...away, now: 10, enabled: false })).toEqual({ ring: false, gate });
    expect(decideRing(QUIET_GATE, { ...away, now: 10, enabled: false }).ring).toBe(false);
  });

  test('a ring another tab reported puts this tab in the same burst', () => {
    const gate = heardRing(QUIET_GATE, 1000);
    expect(decideRing(gate, { ...away, now: 2500 }).ring).toBe(false);
    // An older report never shortens a later burst.
    expect(heardRing({ lastAt: 9000 }, 1000)).toEqual({ lastAt: 9000 });
  });
});

describe('the sound itself', () => {
  // Pinned on purpose: the owner chose this exact sound (tile #9, "Ding-dong") from twelve.
  test('two triangle notes a major third apart, the second at +0.32 s, each with a quiet sine an octave up', () => {
    const triangles = DING_DONG.filter((n) => n.type === 'triangle');
    expect(triangles.map((n) => n.t)).toEqual([0, 0.32]);
    expect(triangles[0]!.freq / triangles[1]!.freq).toBeCloseTo(Math.pow(2, 4 / 12), 6);
    for (const tri of triangles) expect(DING_DONG.some((n) => n.type === 'sine' && n.t === tri.t && n.freq === tri.freq * 2)).toBe(true);
  });
});

describe('notifications while the sound is on', () => {
  test('silent, so the system chime does not ring a second time; unchanged with the sound off', () => {
    expect(inboxNotificationOptions({ body: 'x' }, { silent: true }).silent).toBe(true);
    expect('silent' in inboxNotificationOptions({ body: 'x' })).toBe(false);
    expect(inboxNotificationOptions({ body: 'x' }, { silent: true }).renotify).toBe(true);
  });
});
