/**
 * The parity ledger's clock (scripts/mobile/parity-debts.ts,
 * docs/agent-guides/mobile.md). This file checks the rule on fixed dates
 * only, never the real ledger: the ledger's own dates are checked by
 * mobile-contract.yml's `ledger` job alone, so a mobile debt never turns a
 * `bun test` red (scripts/ci-affected-map.test.ts holds this).
 *
 * What can regress: the clock passing an old decision or debt, or failing a
 * fresh one.
 */
import { describe, expect, test } from 'bun:test';
import { debtProblems } from '../scripts/mobile/parity-debts';

describe('the clock', () => {
  const now = new Date('2026-12-01T00:00:00Z');
  test('an undecided row or a debt fails after 14 days, not before', () => {
    expect(debtProblems([
      { id: 'fresh', mobile: 'undecided', since: '2026-11-20' },
      { id: 'old', mobile: 'undecided', since: '2026-11-10' },
      { id: 'debt', mobile: 'v1', ios: { state: 'owed', owed_since: '2026-11-01' } },
      { id: 'newdebt', mobile: 'v1', ios: { state: 'owed', owed_since: '2026-11-25' } },
    ], now)).toEqual([
      'old: undecided since 2026-11-10, over 14 days. The owner decides it: v1, rethink, later or never.',
      'debt: ios has owed it since 2026-11-01, over 14 days. Build it, or decide again in the ledger.',
    ]);
  });
});
