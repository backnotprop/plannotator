/**
 * Escape on an open thread (escapeStep.ts, App.tsx's window ladder): one layer per press. What regresses: Escape with
 * the canvas open closes the whole thread (review H4), full screen skips straight to closed, the canvas is kept on
 * the ladder while the canvas is off, or the older rungs (a Shape board, a guided review, Artifacts, full screen)
 * move.
 */
import { expect, test } from 'bun:test';
import type { Route } from '../app/route';
import { threadEscapeStep, type ThreadEscapeState } from './escapeStep';

const T = 'msg_01M7NQW4XEMG1FHP7SNPFAAE0Y';
const thread = { page: 'inbox', project: null, thread: T } as Route;
const idle: ThreadEscapeState = { reviewPaneOpen: false, threadFull: false, canvasOn: true, phone: false };

/** Press Escape until the thread closes: the routes it goes through. */
function presses(start: Route, state: ThreadEscapeState): (Route | 'leave-full')[] {
  const out: (Route | 'leave-full')[] = [];
  let now: Route = start;
  for (let i = 0; i < 6 && now.thread; i++) {
    const step = threadEscapeStep(now, state);
    out.push(step);
    if (step === 'leave-full') break;
    now = step;
  }
  return out;
}

test('the canvas in full screen: back beside the thread, then the canvas closes, then the thread', () => {
  const steps = presses({ ...thread, canvas: { view: 'full', version: null } }, idle);
  expect(steps).toEqual([
    { ...thread, canvas: { view: 'side', version: null } },
    { ...thread, canvas: null },
    { ...thread, canvas: null, thread: null },
  ]);
});

test('an older version keeps its place going back beside; beside, the canvas closes before the thread', () => {
  expect(threadEscapeStep({ ...thread, canvas: { view: 'full', version: 3 } }, idle)).toEqual({ ...thread, canvas: { view: 'side', version: 3 } });
  expect(threadEscapeStep({ ...thread, canvas: { view: 'side', version: null } }, idle)).toEqual({ ...thread, canvas: null });
});

test('on a phone the canvas is a screen of its own: one press closes it, back to the thread', () => {
  expect(threadEscapeStep({ ...thread, canvas: { view: 'full', version: null } }, { ...idle, phone: true })).toEqual({ ...thread, canvas: null });
});

test('the canvas closes before a thread in full screen leaves it', () => {
  const state = { ...idle, threadFull: true };
  expect(threadEscapeStep({ ...thread, canvas: { view: 'side', version: null } }, state)).toEqual({ ...thread, canvas: null });
  expect(threadEscapeStep({ ...thread, canvas: null }, state)).toBe('leave-full');
});

test('the canvas off: a leftover `&canvas` is not on the ladder, Escape closes the thread as before', () => {
  expect(threadEscapeStep({ ...thread, canvas: { view: 'full', version: null } }, { ...idle, canvasOn: false })).toEqual({ ...thread, canvas: { view: 'full', version: null }, thread: null });
});

test('the older rungs keep their order: a Shape board, a guided review, Artifacts, full screen, then the thread', () => {
  const shape = { ...thread, shape: 's1', guide: 'g1' } as unknown as Route;
  expect(threadEscapeStep(shape, idle)).toEqual({ ...shape, guide: null, guideAt: null });
  expect(threadEscapeStep(shape, { ...idle, reviewPaneOpen: true })).toEqual({ ...shape, shape: null });
  const guide = { ...thread, guide: 'g1', artifacts: true } as unknown as Route;
  expect(threadEscapeStep(guide, { ...idle, threadFull: true })).toEqual({ ...guide, guide: null });
  const artifacts = { ...thread, artifacts: true } as Route;
  expect(threadEscapeStep(artifacts, { ...idle, threadFull: true })).toEqual({ ...artifacts, artifacts: false });
  expect(threadEscapeStep(thread, { ...idle, threadFull: true })).toBe('leave-full');
  expect(threadEscapeStep(thread, idle)).toEqual({ ...thread, thread: null });
});
