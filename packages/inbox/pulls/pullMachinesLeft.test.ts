/**
 * A linked machine's PR keeps going to that machine after it leaves the board (the owner, 2026-11-23: what is open
 * stays open; 2026-11-24: whatever works on one computer works across computers). What regresses: a page open on a
 * PR merged on the other computer asking this one for it (`pulls/pull`, its diff), which has never listed it and
 * answers "no longer in the list"; a PR this computer lists again still sent to the other one.
 */
import { afterEach, expect, test } from 'bun:test';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { forgetPullMachine, forgetPullMachines, learnPullMachines, pullMachine, pullUrl, resetPullMachines } from './pullMachines';

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

test('a machine unlinked here, or one that answers it is not linked any more: its PRs are read on this machine again', () => {
  const OTHER = 'github.com/northwind/billing-svc#881';
  const SECOND = 'ibx_01JZ0000000000000000000001';
  learnPullMachines(board([{ key: KEY, host: 'github.com', machine: MACHINE }, { key: OTHER, host: 'github.com', machine: SECOND }]));
  learnPullMachines(board([]));
  // The person unlinks it in Settings: every PR remembered as its goes; the other machine's stays.
  forgetPullMachines(MACHINE);
  expect(pullMachine(KEY)).toBeNull();
  expect(pullUrl('/pulls/pull', KEY)).toBe(`/api/inbox/pulls/pull?key=${encodeURIComponent(KEY)}`);
  expect(pullMachine(OTHER)).toBe(SECOND);
  // Unlinked on the other computer: its read answered `machine_not_linked`, and that one PR goes.
  forgetPullMachine(OTHER);
  expect(pullMachine(OTHER)).toBeNull();
});
