/**
 * The parity ledger's clock (scripts/mobile/parity-debts.ts,
 * docs/agent-guides/mobile.md): an `undecided` row or an `owed` debt older
 * than 14 days fails. Apart from tests/mobile-parity.test.ts and importing
 * nothing that reads the product, so the picker selects it only when the
 * ledger or this clock changes; main's full run checks it every merge. A pull
 * request that only changes the Inbox never fails for a debt it did not make.
 *
 * What can regress: an old decision or debt passing unnoticed ("the ledger"),
 * or the clock failing a fresh one ("the clock").
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debtProblems } from '../scripts/mobile/parity-debts';

describe('the ledger', () => {
  test('no decision is left undecided, and no debt owed, for more than 14 days', () => {
    const ledger = JSON.parse(readFileSync(join(import.meta.dir, '../apps/mobile/contract/parity/ledger.json'), 'utf8')) as { rows: Parameters<typeof debtProblems>[0] };
    const problems = debtProblems(ledger.rows, new Date());
    if (problems.length) throw new Error(`${problems.length} old decision(s) or debt(s):\n${problems.join('\n')}`);
  });
});

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
