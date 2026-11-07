import { describe, expect, test } from 'bun:test';
import { checkShapeRun } from '@plannotator/core/shape-run';
import { buildScene, failsAtEnd, fitProjector, inFlight, mixWeights, momentText, spanTone, weightsOf } from './scene';

// A hedge: two calls of one batch at once, on two pods; and a pod with three calls at once.
const run = (() => {
  const r = checkShapeRun({
    run: 1,
    title: 't',
    lanes: [{ id: 'b1', label: 'batch 1' }, { id: 'b2', label: 'batch 2' }, { id: 'b3', label: 'batch 3' }],
    resources: { label: 'pod', items: [{ id: 'r1', label: 'reranker-1' }, { id: 'r2', label: 'reranker-2' }] },
    spans: [
      { lane: 'b1', on: 'r1', from: 0, to: 90, end: 'cancelled' },
      { lane: 'b1', on: 'r2', from: 30, to: 90, end: 'won' },
      { lane: 'b2', on: 'r2', from: 0, to: 40, end: 'ok' },
      { lane: 'b3', on: 'r2', from: 10, to: 70, end: 'ok' },
      { on: 'r1', from: 20, to: 100, end: 'open' },
    ],
  });
  if (r.ok === false) throw new Error(r.errors.join('\n'));
  return r.value;
})();

describe('the run scene', () => {
  const scene = buildScene(run);
  const y = (layout: 'yL' | 'yR', i: number) => scene.spans.find((s) => s.i === i)![layout];

  test('flat by lane: a hedged batch shows both calls, one under the other', () => {
    expect(y('yL', 0)).not.toBe(y('yL', 1));
    expect(scene.rowsL.find((r) => r.key === 'b1')!.subs).toBe(2);
  });

  test('flat by resource: calls that overlap on one pod get a line each', () => {
    const r2 = [1, 2, 3].map((i) => y('yR', i));
    expect(new Set(r2).size).toBe(3);
    expect(scene.rowsR.find((r) => r.key === 'r2')!.subs).toBe(3);
  });

  test("a resource's own state gets its own row by lane, and is no call in flight", () => {
    expect(scene.rowsL.some((r) => r.key === 'res:r1')).toBe(true);
    expect(inFlight(run, 65).map((s) => `${s.lane}@${s.on}`).sort()).toEqual(['b1@r1', 'b1@r2', 'b3@r2']);
  });

  test('the caption at the end names lanes blocked forever, even when the run has resources, and not work or a wait that ends with the run', () => {
    const r = checkShapeRun({
      run: 1,
      title: 'deadlock',
      lanes: [{ id: 'main', label: 'main' }, { id: 'g1', label: 'g1' }, { id: 'g2', label: 'g2' }, { id: 'g3', label: 'g3' }],
      resources: { label: 'lock', items: [{ id: 'A', label: 'lock A' }] },
      spans: [
        { lane: 'g1', from: 10, to: 60, end: 'open', tone: 'alert' },
        { lane: 'g2', from: 12, to: 60, end: 'open' },
        { lane: 'main', from: 0, to: 60 },
        { lane: 'g3', from: 30, to: 60, end: 'ok' },
        { on: 'A', from: 5, to: 60, end: 'open' },
      ],
    });
    if (r.ok === false) throw new Error(r.errors.join('\n'));
    const at = momentText(r.value, 60);
    expect(at).toContain('blocked: g1, g2');
    expect(at).not.toContain('g3');
    // main's wait ends with the run (Wait returned): it is over, not blocked.
    expect(at).not.toContain('main');
    expect(at).not.toContain('nothing in flight');
  });

  test('at the end, a send still open on a channel is named blocked on it (a leak), not "nothing in flight"', () => {
    const r = checkShapeRun({
      run: 1,
      title: 'leak',
      lanes: [{ id: 'main', label: 'main' }, { id: 'w', label: 'worker' }],
      resources: { label: 'channel', items: [{ id: 'out', label: 'results' }] },
      spans: [
        { lane: 'main', from: 0, to: 5, end: 'ok' },
        { lane: 'w', on: 'out', from: 3, to: 20, end: 'open' },
      ],
    });
    if (r.ok === false) throw new Error(r.errors.join('\n'));
    expect(momentText(r.value, 20)).toBe('20 ms · blocked: worker on results');
    expect(momentText(r.value, 10)).toBe('10 ms · 1 in flight: worker on results');
  });

  test('a failed call is drawn as the work it was, with only its end in red; a blocked span is red throughout', () => {
    const failed = { lane: 'b1', from: 0, to: 10, end: 'error' as const };
    expect(spanTone(failed)).toBe(spanTone({ ...failed, end: 'ok' }));
    expect(failsAtEnd(failed)).toBe(true);
    expect(failsAtEnd({ ...failed, tone: 'amber' })).toBe(false);
    const leak = { lane: 'b1', from: 0, to: 10, end: 'open' as const };
    expect(spanTone(leak)).toContain('--alert');
    expect(failsAtEnd(leak)).toBe(false);
  });

  test('time is to scale across the stage, and rows keep inside it in both groupings and halfway between', () => {
    const pad = { l: 100, r: 20, t: 30, b: 30 };
    for (const w of [weightsOf('lanes'), weightsOf('res'), mixWeights(weightsOf('lanes'), weightsOf('res'), 0.5)]) {
      const P = fitProjector(scene, w, 600, 300, pad);
      expect(P.x(0)).toBe(100);
      expect(P.x(scene.end)).toBe(580);
      expect(P.x(scene.end / 4)).toBe(220);
      for (const s of scene.spans) {
        const y = P.y(w.lanes * s.yL + w.res * s.yR);
        expect(y).toBeGreaterThanOrEqual(P.top);
        expect(y).toBeLessThanOrEqual(P.bottom);
      }
    }
  });
});
