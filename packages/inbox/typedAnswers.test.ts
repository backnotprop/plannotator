import { expect, test } from 'bun:test';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { createTypedSaves, isTypedChange, type TypedSavesTimers } from './typedAnswers';

const base: QuestionAnswer = { v: 1, key: 'q-1', kind: 'single', prompt: 'Where?', selected: [] };
const a = (extra: Partial<QuestionAnswer>): QuestionAnswer => ({ ...base, ...extra });

test('typing waits for a pause; a choice, Skip, a cleared answer or the first words save at once', () => {
  // Typing: only the words change.
  expect(isTypedChange(a({ other: 'car' }), a({ other: 'card' }))).toBe(true);
  expect(isTypedChange(a({ selected: ['Pin it'], note: 'be' }), a({ selected: ['Pin it'], note: 'bec' }))).toBe(true);
  expect(isTypedChange(a({ kind: 'text', text: 'ye' }), a({ kind: 'text', text: 'yes' }))).toBe(true);
  // At once: the question's state can change.
  expect(isTypedChange(null, a({ other: 'c' }))).toBe(false);
  expect(isTypedChange(a({ other: 'c' }), null)).toBe(false);
  expect(isTypedChange(a({ selected: ['Pin it'] }), a({ selected: ['Loosen it'] }))).toBe(false);
  expect(isTypedChange(a({ other: 'c' }), a({ selected: [], skipped: true }))).toBe(false);
  // The agent's suggested answer is its own row: picking it is a click, even though it lands as "Other…" words.
  expect(isTypedChange(a({ other: 'Use a queue' }), a({ other: 'Retry five times' }), 'Retry five times')).toBe(false);
  // The same words again (a re-render) are no change at all.
  expect(isTypedChange(a({ other: 'c' }), a({ other: 'c' }))).toBe(false);
});

/** Timers the test moves by hand. */
function handTimers() {
  let now = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const timers: TypedSavesTimers = {
    set: (run, ms) => {
      const id = next++;
      due.set(id, { at: now + ms, run });
      return id;
    },
    clear: (id) => void due.delete(id as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...due]) {
      if (timer.at > now) continue;
      due.delete(id);
      timer.run();
    }
  };
  return { timers, advance };
}

test('each key restarts the pause, so a steady typist saves once, with the last words', () => {
  const { timers, advance } = handTimers();
  const typed = createTypedSaves(500, timers);
  const ran: string[] = [];
  for (const words of ['c', 'ca', 'car', 'card']) {
    typed.type('q', () => ran.push(words));
    advance(200);
  }
  expect(ran).toEqual([]);
  advance(300);
  expect(ran).toEqual(['card']);
  expect(typed.has('q')).toBe(false);
});

test('flushAll saves every question waiting now, once; drop and take leave nothing to run later', () => {
  const { timers, advance } = handTimers();
  const typed = createTypedSaves(500, timers);
  const ran: string[] = [];
  typed.type('a', () => ran.push('a'));
  typed.type('b', () => ran.push('b'));
  typed.flushAll();
  advance(1000);
  expect(ran).toEqual(['a', 'b']);

  typed.type('c', () => ran.push('c'));
  typed.drop('c');
  typed.type('d', () => ran.push('d'));
  const taken = typed.take();
  expect(taken.map((t) => t.id)).toEqual(['d']);
  advance(1000);
  expect(ran).toEqual(['a', 'b']);
  expect(typed.size()).toBe(0);
});
