/**
 * A review's Viewed ticks while its machine is away: each tick still held for it shows as the person made it, laid over
 * what that machine keeps, so reopening the review never shows a tick gone, and a second tick never drops the first.
 */
import { expect, test } from 'bun:test';
import type { OutboxView } from '@plannotator/core/inbox-wire-models';
import { viewedWithHeld } from './heldViewed';

const MSG = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const held = (key: string, at: string, path: string, viewed: boolean, state: OutboxView['state'] = 'queued'): [string, OutboxView] => [
  key,
  { key, machine: 'ibx_01K7MMMMMMMMMMMMMMMMMMMMMM', route: `messages/${MSG}/guide/viewed`, state, queued_at: at, settled_at: null, status: null, answer: null, notice: null, dismissed: false, viewed: { path, viewed } },
];

test('reopened while its machine is away, a held tick still shows, and a second one keeps the first', () => {
  // The machine keeps none yet; A was ticked and waits. The review opens again from what that machine keeps.
  const one = new Map([held('k1', '2026-11-25T10:00:00.000Z', 'src/a.ts', true)]);
  expect(viewedWithHeld([], one, MSG)).toEqual(['src/a.ts']);
  // B ticked too: both wait, both show.
  const two = new Map([...one, held('k2', '2026-11-25T10:01:00.000Z', 'src/b.ts', true)]);
  expect(viewedWithHeld([], two, MSG)).toEqual(['src/a.ts', 'src/b.ts']);
  // An untick held after them takes that file alone; what the machine keeps stays.
  const three = new Map([...two, held('k3', '2026-11-25T10:02:00.000Z', 'src/a.ts', false)]);
  expect(viewedWithHeld(['src/c.ts'], three, MSG)).toEqual(['src/c.ts', 'src/b.ts']);
});

test('a delivered or refused tick, another review\'s, or another write is not laid over', () => {
  const done = new Map([
    held('k1', '2026-11-25T10:00:00.000Z', 'src/a.ts', true, 'delivered'),
    held('k2', '2026-11-25T10:00:00.000Z', 'src/b.ts', true, 'refused'),
    ['k3', { ...held('k3', '2026-11-25T10:00:00.000Z', 'src/c.ts', true)[1], route: 'messages/msg_other/guide/viewed' }],
    ['k4', { ...held('k4', '2026-11-25T10:00:00.000Z', 'src/d.ts', true)[1], viewed: null }],
  ] as [string, OutboxView][]);
  expect(viewedWithHeld(['src/x.ts'], done, MSG)).toEqual(['src/x.ts']);
  expect(viewedWithHeld(['src/x.ts'], null, MSG)).toEqual(['src/x.ts']);
});
