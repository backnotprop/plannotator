/**
 * The Agents view's folds (agentsView/folds.ts): an agent starts as the view says until the person opens or folds it,
 * then keeps that choice, per agent, in a small cookie.
 *
 * What this catches: a click forgotten on the next read of the cookie, one agent's choice landing on another, a
 * default overridden for an agent the person never touched, a cookie that grows with every agent ever seen, a fold
 * that hides a thread waiting on the person that came after it, and this machine's agents losing their folds when a
 * first machine is linked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setStorageBackend, resetStorageBackend, storage } from '@plannotator/ui/utils/storage';
import { AGENT_FOLDS_COOKIE, AGENT_FOLDS_KEPT, ENDED_BAND, agentFoldKey, foldHash, foldOpen, foldToggled, formatAgentFolds, parseAgentFolds } from './folds';

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
});
afterEach(() => resetStorageBackend());

describe('folds', () => {
  test('untouched, an agent starts as the view says; a click keeps the other state for that agent only', () => {
    const none = parseAgentFolds(null);
    expect(foldOpen(none, 'ibx\u0000ses_a', true)).toBe(true);
    expect(foldOpen(none, 'ibx\u0000ses_b', false)).toBe(false);
    const folded = foldToggled(none, 'ibx\u0000ses_a', true);
    expect(foldOpen(folded, 'ibx\u0000ses_a', true)).toBe(false);
    expect(foldOpen(folded, 'ibx\u0000ses_b', false)).toBe(false);
    // A later start of "open" (something new for the person) does not undo the person's fold.
    expect(foldOpen(folded, 'ibx\u0000ses_a', true)).toBe(false);
  });

  test('the choices read back from the cookie as written', () => {
    let folds = foldToggled(parseAgentFolds(null), 'a', true);
    folds = foldToggled(folds, ENDED_BAND, true);
    storage.setItem(AGENT_FOLDS_COOKIE, formatAgentFolds(folds));
    const back = parseAgentFolds(storage.getItem(AGENT_FOLDS_COOKIE));
    expect(foldOpen(back, 'a', true)).toBe(false);
    expect(foldOpen(back, ENDED_BAND, true)).toBe(false);
    expect(parseAgentFolds('junk,<x>:1,zz:7').size).toBe(0);
    // A cookie from before the fold's time still reads.
    expect(foldOpen(parseAgentFolds('~ended:0'), ENDED_BAND, true)).toBe(false);
  });

  test('a fold gives way to a thread that waits on the person and came after it, not to one from before', () => {
    const at = Date.parse('2026-11-19T10:00:00Z');
    const folded = parseAgentFolds(formatAgentFolds(foldToggled(parseAgentFolds(null), 'a', true, 0, at)));
    expect(foldOpen(folded, 'a', true, at - 60_000)).toBe(false);
    expect(foldOpen(folded, 'a', true, at + 60_000)).toBe(true);
    // Folding it again after that thread keeps it folded.
    const again = foldToggled(folded, 'a', true, at + 60_000, at + 120_000);
    expect(foldOpen(again, 'a', true, at + 60_000)).toBe(false);
  });

  test("a fold holds against the rows it was made over: one a moment newer than the browser's clock, and part of a second", () => {
    const at = Date.parse('2026-11-19T10:00:00.400Z');
    // The newest waiting row 3.7 s ahead of this browser's clock (the server's), folded now: it stays folded.
    const ahead = parseAgentFolds(formatAgentFolds(foldToggled(parseAgentFolds(null), 'a', true, at + 3_700, at)));
    expect(foldOpen(ahead, 'a', true, at + 3_700)).toBe(false);
    // A row from earlier in the same second as the click, read back from the cookie's whole seconds: still folded.
    const same = parseAgentFolds(formatAgentFolds(foldToggled(parseAgentFolds(null), 'a', true, at - 100, at)));
    expect(foldOpen(same, 'a', true, at - 100)).toBe(false);
    expect(foldOpen(same, 'a', true, at + 60_000)).toBe(true);
  });

  test("this machine's agents keep their key when a first machine is linked; another machine's agent has its own", () => {
    expect(agentFoldKey({ id: 'ses_a', machine: null }, null)).toBe(agentFoldKey({ id: 'ses_a', machine: 'ibx_self' }, 'ibx_self'));
    expect(agentFoldKey({ id: 'ses_a', machine: 'ibx_mini' }, 'ibx_self')).not.toBe(agentFoldKey({ id: 'ses_a', machine: null }, 'ibx_self'));
  });

  test('only the latest clicks are kept, each agent by a short name', () => {
    let folds = parseAgentFolds(null);
    for (let i = 0; i < AGENT_FOLDS_KEPT + 10; i++) folds = foldToggled(folds, `ibx_machine\u0000ses_${i}-0123456789abcdef`, false);
    expect(folds.size).toBe(AGENT_FOLDS_KEPT);
    expect(foldOpen(folds, `ibx_machine\u0000ses_0-0123456789abcdef`, false)).toBe(false);
    expect(foldOpen(folds, `ibx_machine\u0000ses_${AGENT_FOLDS_KEPT + 9}-0123456789abcdef`, false)).toBe(true);
    expect(foldHash('a long agent key that never fits a cookie well').length).toBeLessThanOrEqual(7);
  });
});
