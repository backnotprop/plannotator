/**
 * The words a live session's state is named by outside the Agents list: the To picker, the phone's To sheet, Send to
 * another session and search (`busyWord`, compose/model.ts), and the Board's card panel (`agentState`, board/model.ts).
 * The failure these guard (review M3): a host that reports no turns (`busy` null: Codex, Qwen Code, T3 Code,
 * Antigravity) named "Idle" anywhere, which claims what nobody said. Pure.
 */
import { expect, test } from 'bun:test';
import { busyWord } from './model';
import { agentState } from '../board/model';

test('working while busy, idle when its host said it is not, nothing when its host says nothing', () => {
  expect([busyWord({ busy: true }), busyWord({ busy: false }), busyWord({ busy: null })]).toEqual(['Working', 'Idle', null]);
});

test("the Board's card: working, idle, ended (not live), and nothing for a live host that reports no turns", () => {
  const live = [
    { session: 'cc', busy: true },
    { session: 'pi', busy: false },
    { session: 'codex', busy: null },
  ];
  expect(['cc', 'pi', 'codex', 'gone'].map((session) => agentState(session, live))).toEqual(['working', 'idle', null, 'ended']);
});
