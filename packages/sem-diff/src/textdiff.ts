// One VS Code diff (`@vscode/diff`, MIT) per file, shared by the passes that
// need text-level changes, plus offset -> (line, character) conversion.
import { createTsDiffComputer } from '@vscode/diff/core';
import type { SemanticDiffTextPosition } from './pierre-types.ts';

/** Above this many lines, skip move detection (it is the costly part). */
export const MAX_TEXT_MOVE_LINES = 20_000;

const computer = createTsDiffComputer();

export type TextDiff = ReturnType<typeof computer.computeDiff>;

// The library stops a costly diff by checking the clock, so a busy machine gives a
// different answer than an idle one. For the length of one (synchronous) diff we swap
// the clock for a count of work done: the same inputs then stop at the same point on
// every machine. A check inside the O(ND) algorithm costs about as much as the number
// of checks it has made so far, so it is counted that way; every other check counts 1.
type Algorithm = { compute: (...args: unknown[]) => unknown };
const impl = (computer as unknown as { _impl?: { _myersDiffingAlgorithm?: Algorithm } })._impl;
const myers = impl?._myersDiffingAlgorithm;
if (!myers) throw new Error('@vscode/diff changed shape: the work count in textdiff.ts needs updating');
let work = 0;
let round = -1; // >= 0 while inside the O(ND) algorithm
const compute = myers.compute.bind(myers);
myers.compute = (...args) => {
  const outer = round;
  round = 0;
  try {
    return compute(...args);
  } finally {
    round = outer;
  }
};
const workClock = () => (work += round < 0 ? 1 : ++round);

/** Roughly one second of diffing on a 2024 laptop (measured: 50M to 250M, median 90M). */
export const WORK_PER_SECOND = 75_000_000;

/** Work used by the most recent `computeTextDiff`. */
export let lastWork = 0;

/** `maxWork` bounds the diff by work done, not by time, so the result is repeatable. */
export function computeTextDiff(oldText: string, newText: string, maxWork = WORK_PER_SECOND): TextDiff {
  const computeMoves = oldText.split('\n').length <= MAX_TEXT_MOVE_LINES;
  const clock = Date.now;
  work = 0;
  round = -1;
  Date.now = workClock;
  try {
    return computer.computeDiff(oldText, newText, { computeMoves, maxComputationTimeMs: Math.max(1, Math.floor(maxWork)) });
  } finally {
    Date.now = clock;
    lastWork = work;
  }
}

export function positions(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number): SemanticDiffTextPosition => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, character: offset - starts[lo]! };
  };
}
