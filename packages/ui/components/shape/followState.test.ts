/**
 * "Follow an example": the step on now. What regresses: next or back running
 * past an example's ends (a card with no step), "Step through" not starting at
 * the first step, a new version with fewer examples leaving the card on one
 * that is gone, and a jump or a hand-off read as the wrong direction (the
 * output flying into a step it never reached).
 */
import { describe, expect, test } from 'bun:test';
import type { ShapeExample } from '@plannotator/core/shape';
import { followCardCut, followDir, followFileFit, followReduce, followSignature, followSignatureFit, type FollowPhase } from './followState';

const ex = (steps: number): ShapeExample => ({
  name: `${steps} steps`,
  title: 't',
  steps: Array.from({ length: steps }, (_, i) => ({
    part: `p${i}`,
    tag: String(i),
    text: 's',
    inputs: [],
    signature: 'f()',
    checks: [],
    output: { name: 'o', value: '1', type: 'number' },
    code: { path: 'a.ts', line: 1 },
  })),
});
const EXAMPLES = [ex(3), ex(2)];

function run(actions: Parameters<typeof followReduce>[1][], from: FollowPhase = { open: false }, examples = EXAMPLES): FollowPhase {
  return actions.reduce((p, a) => followReduce(p, a, examples), from);
}

describe('followReduce', () => {
  test('opens on the first example, all steps; next starts at the first step and stops at the last', () => {
    expect(run([{ type: 'toggle' }])).toEqual({ open: true, ex: 0, step: null });
    expect(run([{ type: 'toggle' }, { type: 'next' }])).toEqual({ open: true, ex: 0, step: 0 });
    expect(run([{ type: 'toggle' }, { type: 'next' }, { type: 'next' }, { type: 'next' }, { type: 'next' }, { type: 'next' }])).toEqual({ open: true, ex: 0, step: 2 });
  });

  test('back stops at the first step; rapid next, next, back lands one step on', () => {
    expect(run([{ type: 'toggle' }, { type: 'step', step: 0 }, { type: 'back' }, { type: 'back' }])).toEqual({ open: true, ex: 0, step: 0 });
    expect(run([{ type: 'toggle' }, { type: 'step', step: 0 }, { type: 'next' }, { type: 'next' }, { type: 'back' }])).toEqual({ open: true, ex: 0, step: 1 });
  });

  test('a jump past the end is clamped; switching example starts it from all steps', () => {
    const open = run([{ type: 'toggle' }, { type: 'step', step: 9 }]);
    expect(open).toEqual({ open: true, ex: 0, step: 2 });
    expect(run([{ type: 'example', ex: 1 }], open)).toEqual({ open: true, ex: 1, step: null });
    expect(run([{ type: 'example', ex: 7 }], open)).toBe(open);
  });

  test('toggle and close close it; an example a new version dropped closes it', () => {
    expect(run([{ type: 'toggle' }, { type: 'toggle' }])).toEqual({ open: false });
    expect(run([{ type: 'toggle' }, { type: 'close' }])).toEqual({ open: false });
    expect(run([{ type: 'next' }], { open: true, ex: 1, step: 0 }, [ex(3)])).toEqual({ open: false });
    expect(run([{ type: 'toggle' }], { open: false }, [])).toEqual({ open: false });
  });
});

describe('followDir', () => {
  test('forward one is the hand-off; back one is back; anything else is a jump', () => {
    const at = (step: number | null, e = 0): FollowPhase => ({ open: true, ex: e, step });
    expect(followDir(at(1), at(2))).toBe('fwd');
    expect(followDir(at(2), at(1))).toBe('back');
    expect(followDir(at(0), at(2))).toBe('jump');
    expect(followDir(at(null), at(0))).toBe('jump');
    expect(followDir(at(1, 0), at(2, 1))).toBe('jump');
    expect(followDir(null, at(0))).toBe('jump');
  });
});

describe('followSignature', () => {
  test('a long signature goes one parameter a line, and a generic or a default keeps its commas', () => {
    expect(followSignature('f(a: number): boolean')).toBe('f(a: number): boolean');
    expect(followSignature("snoozeIntroMayClaim(gate: Omit<SnoozeIntroGate, 'toast'>, now: Date = new Date()): boolean")).toBe(
      "snoozeIntroMayClaim(\n  gate: Omit<SnoozeIntroGate, 'toast'>,\n  now: Date = new Date(),\n): boolean",
    );
  });
});

describe('followSignatureFit', () => {
  const sig = "snoozeIntroMayClaim(gate: Omit<SnoozeIntroGate, 'toast'>, now: Date = new Date()): boolean";
  test('one line when it fits, then two broken between parameters, then one parameter a line', () => {
    expect(followSignatureFit(sig, sig.length)).toBe(sig);
    expect(followSignatureFit(sig, 60)).toBe("snoozeIntroMayClaim(gate: Omit<SnoozeIntroGate, 'toast'>,\n  now: Date = new Date()): boolean");
    expect(followSignatureFit(sig, 30)).toBe(followSignature(sig, 30));
  });
});

describe('followFileFit', () => {
  test('a name that fits with its line stays whole', () => {
    expect(followFileFit('snoozeIntroRows.ts', 27, 21)).toBe('snoozeIntroRows.ts');
  });
  test('a longer one is cut so name and line take exactly the room', () => {
    const name = followFileFit('snoozeIntroRows.ts', 27, 16);
    expect(name).toBe('snoozeIntroR\u2026');
    expect(`${name}:27`.length).toBe(16);
    expect(`${followFileFit('snoozeIntroRows.ts', 1274, 16)}:1274`.length).toBe(16);
  });
  test('no room still names the file', () => {
    expect(followFileFit('snoozeIntroRows.ts', 27, 2)).toBe('sno\u2026');
  });
});

describe('followCardCut', () => {
  test('a little spare height holds: the edge does not move for it', () => {
    expect(followCardCut(82, 200)).toBe(0);
    expect(followCardCut(82, null)).toBe(0);
  });
  test('a lot of it comes off', () => {
    expect(followCardCut(130, null)).toBe(130);
  });
  test('never past what the rail needs', () => {
    expect(followCardCut(200, 120)).toBe(120);
    expect(followCardCut(200, 40)).toBe(0);
  });
});
