/**
 * When the Inbox's sound rings (soundRing.ts `decideRing`, re-exported by
 * sound.ts): only while no Inbox tab is in front, never with the sound off.
 * Questions among themselves keep the rule from before the choice (one ring
 * per burst of questions less than 30 s apart); a plain agent message rings
 * by `plainMessageRings` (unless any news came within 30 s) and never holds a
 * question back nor takes its notice's sound; coming to the front ends both
 * bursts; a ring another tab reported joins this tab to that burst.
 */
import { describe, expect, test } from 'bun:test';
import { DING_DONG, decideRing, heardRing, plainMessageRings, QUIET_GATE, RING_BURST_MS, ringsFor, soundFromFrame, type RingGate } from './sound';
import { inboxNotificationOptions } from './notify';

const away = { enabled: true, inFront: false, otherTabInFront: false };
const QUESTION = { asks: true, plain: false };
const REPLY = { asks: false, plain: true };
const NEW_THREAD = { asks: false, plain: false, fresh: true };

/** News arriving at these times (ms), all while away: which of it rings. `kind`: what each one is (questions by default). */
function rings(times: number[], start: RingGate = QUIET_GATE, kinds: { asks: boolean; plain: boolean; fresh?: boolean }[] = [], when?: 'messages' | 'asks'): boolean[] {
  let gate = start;
  return times.map((now, i) => {
    const decided = decideRing(gate, { ...away, now, when, ...(kinds[i] ?? QUESTION) });
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
    let gate = decideRing(QUIET_GATE, { ...away, now: 0, ...QUESTION }).gate;
    const front = decideRing(gate, { ...away, now: 1000, inFront: true, ...REPLY });
    expect(front).toEqual({ ring: false, rangFor: { asks: false, plain: false, fresh: false }, gate: QUIET_GATE });
    expect(decideRing(gate, { ...away, now: 1000, otherTabInFront: true, ...QUESTION }).gate).toEqual(QUIET_GATE);
    // Away again a moment later: the next news starts a new burst and rings.
    gate = front.gate;
    expect(decideRing(gate, { ...away, now: 2000, ...QUESTION }).ring).toBe(true);
    expect(decideRing(gate, { ...away, now: 2000, ...REPLY }).ring).toBe(true);
  });

  test('sound off: never rings, and leaves the bursts as they were', () => {
    const gate: RingGate = { ...QUIET_GATE, lastAt: 5, askAt: 5, lastRang: true, askRang: true };
    expect(decideRing(gate, { ...away, now: 10, enabled: false, ...QUESTION })).toEqual({ ring: false, rangFor: { asks: false, plain: false, fresh: false }, gate });
    expect(decideRing(QUIET_GATE, { ...away, now: 10, enabled: false, ...REPLY }).ring).toBe(false);
  });

  test('a ring another tab reported puts this tab in the same burst; one for a question, in the question burst too', () => {
    expect(decideRing(heardRing(QUIET_GATE, 1000, true), { ...away, now: 2500, ...QUESTION }).ring).toBe(false);
    expect(decideRing(heardRing(QUIET_GATE, 1000, false), { ...away, now: 2500, ...REPLY }).ring).toBe(false);
    // A plain ring elsewhere never holds a question back.
    expect(decideRing(heardRing(QUIET_GATE, 1000, false), { ...away, now: 2500, ...QUESTION }).ring).toBe(true);
    // An older report never shortens a later burst.
    expect(heardRing({ ...QUIET_GATE, lastAt: 9000, askAt: 9000 }, 1000, true)).toMatchObject({ lastAt: 9000, askAt: 9000 });
    // The other tab's ring makes this burst one the bell rang in: this tab's notices in it are silent too.
    expect(decideRing(heardRing(QUIET_GATE, 1000, true), { ...away, now: 2500, ...QUESTION }).rangFor).toEqual({ asks: true, plain: false, fresh: false });
    expect(decideRing(heardRing(QUIET_GATE, 1000, false), { ...away, now: 2500, ...REPLY }).rangFor).toEqual({ asks: false, plain: true, fresh: false });
  });
});

describe('a plain message never swallows a question (the review\'s H1)', () => {
  test('agent A replies at 0 s (rings) and 20 s (quiet), agent B asks at 40 s: the question rings, and the bell rang for it', () => {
    expect(rings([0, 20_000, 40_000], QUIET_GATE, [REPLY, REPLY, QUESTION])).toEqual([true, false, true]);
    let gate = QUIET_GATE;
    for (const [now, kind] of [[0, REPLY], [20_000, REPLY]] as const) gate = decideRing(gate, { ...away, now, ...kind }).gate;
    // So its notice is silent (one sound), never silent with no ring.
    expect(decideRing(gate, { ...away, now: 40_000, ...QUESTION }).rangFor).toEqual({ asks: true, plain: false, fresh: false });
  });

  test('replies every 10 s for minutes never hold back a question; questions among themselves keep their burst', () => {
    const times = [0, 10_000, 20_000, 25_000, 30_000, 40_000, 50_000, 54_000];
    const kinds = [REPLY, REPLY, REPLY, QUESTION, REPLY, REPLY, REPLY, QUESTION];
    // The question at 25 s rings (no question before it); the one at 54 s is within 30 s of it: quiet.
    expect(rings(times, QUIET_GATE, kinds)).toEqual([true, false, false, true, false, false, false, false]);
  });

  test('a reply right after a question that rang stays quiet (news within 30 s)', () => {
    expect(rings([0, 5_000], QUIET_GATE, [QUESTION, REPLY])).toEqual([true, false]);
  });

  test('three questions seconds apart: one ring, and all three are the bell\'s (their notices silent: one sound, as before)', () => {
    let gate = QUIET_GATE;
    const seen = [0, 4_000, 8_000].map((now) => {
      const decided = decideRing(gate, { ...away, now, ...QUESTION });
      gate = decided.gate;
      return [decided.ring, decided.rangFor.asks];
    });
    expect(seen).toEqual([[true, true], [false, true], [false, true]]);
  });

  test('"every agent message": three plain messages seconds apart, one ring, all three the bell\'s', () => {
    let gate = QUIET_GATE;
    const seen = [0, 4_000, 8_000].map((now) => {
      const decided = decideRing(gate, { ...away, now, ...REPLY });
      gate = decided.gate;
      return [decided.ring, decided.rangFor.plain];
    });
    expect(seen).toEqual([[true, true], [false, true], [false, true]]);
  });

  test('a burst the bell never rang in (the tab not armed yet) is nobody\'s: its notices keep the system\'s sound', () => {
    let gate = decideRing(QUIET_GATE, { ...away, now: 0, armed: false, ...QUESTION }).gate;
    expect(decideRing(QUIET_GATE, { ...away, now: 0, armed: false, ...QUESTION })).toMatchObject({ ring: false, rangFor: { asks: false, plain: false } });
    // Armed seconds later, still in that burst: no ring (its burst), and still nobody's.
    const later = decideRing(gate, { ...away, now: 5_000, ...QUESTION });
    expect(later).toMatchObject({ ring: false, rangFor: { asks: false, plain: false } });
    gate = later.gate;
    // After 30 s of quiet a new burst rings, and is the bell's.
    expect(decideRing(gate, { ...away, now: 5_000 + RING_BURST_MS, ...QUESTION })).toMatchObject({ ring: true, rangFor: { asks: true, plain: false } });
  });

  test('a plain burst that rang does not make a question\'s notice silent unless the bell rang for a question', () => {
    // A reply rang at 0 s. Under "when an agent asks you" nothing plain rings, so take the default: the question at 10 s
    // starts its own question burst and rings (H1); were it not to ring, its notice would not be the bell's.
    const gate = decideRing(QUIET_GATE, { ...away, now: 0, ...REPLY }).gate;
    expect(decideRing(gate, { ...away, now: 10_000, ...QUESTION })).toMatchObject({ ring: true, rangFor: { asks: true } });
    expect(decideRing(gate, { ...away, now: 10_000, armed: false, ...QUESTION })).toMatchObject({ ring: false, rangFor: { asks: false } });
  });
});

describe('every new thread rings the Ding-dong', () => {
  test('under either choice, even right after a reply rang; a question right after it still rings', () => {
    for (const when of ['asks', 'messages'] as const) {
      expect(rings([0, 5_000], QUIET_GATE, [NEW_THREAD, QUESTION], when)).toEqual([true, true]);
    }
    expect(rings([0, 10_000], QUIET_GATE, [REPLY, NEW_THREAD], 'messages')).toEqual([true, true]);
  });

  test('new threads seconds apart: one ring, and each is the bell\'s (its notice silent)', () => {
    let gate = QUIET_GATE;
    const out = [0, 3_000, 6_000].map((now) => {
      const decided = decideRing(gate, { ...away, now, when: 'asks', ...NEW_THREAD });
      gate = decided.gate;
      return [decided.ring, decided.rangFor.fresh];
    });
    expect(out).toEqual([[true, true], [false, true], [false, true]]);
  });

  test('a question 55 s after the last question rings, though new threads kept arriving at 20 s and 40 s', () => {
    for (const when of ['asks', 'messages'] as const) {
      expect(rings([0, 20_000, 40_000, 55_000], QUIET_GATE, [QUESTION, NEW_THREAD, NEW_THREAD, QUESTION], when)).toEqual([true, false, false, true]);
    }
  });

  test('a new thread right after a locked question (the bell never rang) is not the bell\'s: its notice keeps the system sound', () => {
    const locked = decideRing(QUIET_GATE, { ...away, now: 0, armed: false, ...QUESTION }).gate;
    expect(decideRing(locked, { ...away, now: 5_000, armed: false, ...NEW_THREAD }).rangFor.fresh).toBe(false);
  });
});

describe("soundFromFrame: another window's save (event: sound)", () => {
  test('the settings it carries, an unknown choice read as the default; anything that is not settings is ignored', () => {
    expect(soundFromFrame({ enabled: false, volume: 30, when: 'asks', dialog_shown_for: null, dialog_due: true })).toEqual({ enabled: false, volume: 30, when: 'asks', dialog_shown_for: null, dialog_due: true });
    expect(soundFromFrame({ enabled: true, volume: 60, when: 'someday', dialog_shown_for: '0.29.0' })?.when).toBe('messages');
    for (const bad of [null, 'on', { enabled: 'yes', volume: 60 }, { enabled: true, volume: 101 }, { enabled: true }]) expect(soundFromFrame(bad)).toBeNull();
  });
});

describe('plainMessageRings: the owner\'s cadence ("Every message, as picked")', () => {
  test('each plain message rings unless any news came within 30 s: agents posting a minute apart ring every time', () => {
    expect(plainMessageRings(QUIET_GATE, 0)).toBe(true);
    expect(plainMessageRings({ ...QUIET_GATE, lastAt: 0 }, RING_BURST_MS - 1)).toBe(false);
    expect(plainMessageRings({ ...QUIET_GATE, lastAt: 0 }, RING_BURST_MS)).toBe(true);
    expect(rings([0, 60_000, 120_000, 180_000], QUIET_GATE, [REPLY, REPLY, REPLY, REPLY])).toEqual([true, true, true, true]);
    // Five agents at once: one ring.
    expect(rings([0, 100, 200, 300, 400], QUIET_GATE, [REPLY, REPLY, REPLY, REPLY, REPLY])).toEqual([true, false, false, false, false]);
  });

  test('"questions and new threads": a plain message neither rings nor starts or extends a burst', () => {
    expect(rings([0, 10_000], QUIET_GATE, [REPLY, QUESTION], 'asks')).toEqual([false, true]);
    expect(decideRing(QUIET_GATE, { ...away, now: 0, when: 'asks', ...REPLY })).toEqual({ ring: false, rangFor: { asks: false, plain: false, fresh: false }, gate: QUIET_GATE });
  });
});

describe('ringsFor: the person\'s choice', () => {
  test('"every agent message" (also nothing chosen, or a value this build does not know) rings for a plain reply; "questions and new threads" not for one', () => {
    for (const when of ['messages', undefined, 'sometimes' as never] as const) expect([ringsFor(when, false), ringsFor(when, true)]).toEqual([true, true]);
    expect([ringsFor('asks', false), ringsFor('asks', true)]).toEqual([false, true]);
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
