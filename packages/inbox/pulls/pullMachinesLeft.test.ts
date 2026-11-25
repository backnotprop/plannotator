/**
 * A linked machine's PR keeps going to that machine after it leaves the board (the owner, 2026-11-23: what is open
 * stays open; 2026-11-24: whatever works on one computer works across computers). What regresses: a page open on a
 * PR merged on the other computer asking this one for it (`pulls/pull`, its diff), which has never listed it and
 * answers "no longer in the list"; a PR this computer lists again still sent to the other one.
 */
import { afterEach, expect, test } from 'bun:test';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { learnPullMachines, pullMachine, pullUrl, resetPullMachines } from './pullMachines';

const MACHINE = 'ibx_01JZ0000000000000000000000';
const KEY = 'github.com/northwind/billing-svc#880';

const board = (pulls: Partial<InboxPull>[]) => ({ pulls }) as unknown as InboxPullsAnswer;

afterEach(() => resetPullMachines());

test('a linked machine’s PR that left the board is still read on that machine; one this machine lists is this machine’s', () => {
  learnPullMachines(board([{ key: KEY, host: 'github.com', author: 'tomas', machine: MACHINE }]));
  expect(pullUrl('/pulls/pull', KEY)).toBe(`/api/inbox/m/${MACHINE}/pulls/pull?key=${encodeURIComponent(KEY)}`);
  // Merged there: the next board no longer names it. The page open on it still reads it there.
  learnPullMachines(board([]));
  expect(pullMachine(KEY)).toBe(MACHINE);
  expect(pullUrl('/pulls/diff', KEY)).toStartWith(`/api/inbox/m/${MACHINE}/pulls/diff?`);
  // This machine lists it now: this machine's.
  learnPullMachines(board([{ key: KEY, host: 'github.com', author: 'tomas' }]));
  expect(pullMachine(KEY)).toBeNull();
  learnPullMachines(board([]));
  expect(pullMachine(KEY)).toBeNull();
});
