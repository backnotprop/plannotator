/**
 * The canvas shows on this computer's threads only (seat.tsx `canvasHere`, review M5). What regresses: a linked
 * machine's thread gets a blank local canvas its agent never reads, and the person's marks go out describing it.
 */
import { afterEach, expect, test } from 'bun:test';
import { rememberLocal, rememberMachine, resetMachineRoutes } from '../inboxUrl';
import { canvasHere } from './seat';

const OTHER = 'ibx_01JZ0000000000000000000000';
const THIRD = 'ibx_01JZ0000000000000000000001';

afterEach(() => resetMachineRoutes());

test("this computer's thread has a canvas; a linked machine's thread, or one two machines claim, has none", () => {
  rememberLocal(['msg_local']);
  rememberMachine(['msg_remote', 'msg_both'], OTHER);
  rememberMachine(['msg_both'], THIRD);
  expect(canvasHere('msg_local')).toBe(true);
  // Not named by any machine yet: this Inbox's own.
  expect(canvasHere('msg_unnamed')).toBe(true);
  expect(canvasHere('msg_remote')).toBe(false);
  expect(canvasHere('msg_both')).toBe(false);
  expect(canvasHere(null)).toBe(false);
});
