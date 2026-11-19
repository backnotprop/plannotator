/**
 * The parity ledger's clock (docs/agent-guides/mobile.md): a decision left
 * `undecided`, or a debt the app `owed`, must not stay older than DEBT_DAYS.
 *
 *   bun scripts/mobile/parity-debts.ts
 *
 * Only the `ledger` job of .github/workflows/mobile-contract.yml runs it. It
 * is a script, not a test file, so no
 * `bun test` runs it: a mobile debt never turns the Inbox's checks, main's
 * full run or a release red. It imports nothing, so it runs with no install.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEBT_DAYS = 14;

type Dated = { id: string; mobile: string; since?: string; ios?: { state: string; owed_since?: string }; android?: { state: string; owed_since?: string } };

const DAY = 86_400_000;

/** Every decision or debt older than DEBT_DAYS at `now`, as the lines a person reads. */
export function debtProblems(rows: readonly Dated[], now: Date): string[] {
  const problems: string[] = [];
  const old = (date: string | undefined) => {
    const at = date ? Date.parse(date) : Number.NaN;
    return !Number.isNaN(at) && now.getTime() - at > DEBT_DAYS * DAY;
  };
  for (const row of rows) {
    if (row.mobile === 'undecided' && old(row.since)) {
      problems.push(`${row.id}: undecided since ${row.since}, over ${DEBT_DAYS} days. The owner decides it: v1, rethink, later or never.`);
    }
    for (const [client, state] of [['ios', row.ios], ['android', row.android]] as const) {
      if (state?.state === 'owed' && old(state.owed_since)) {
        problems.push(`${row.id}: ${client} has owed it since ${state.owed_since}, over ${DEBT_DAYS} days. Build it, or decide again in the ledger.`);
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const ledger = JSON.parse(readFileSync(join(import.meta.dir, '../../apps/mobile/contract/parity/ledger.json'), 'utf8')) as { rows: Dated[] };
  const problems = debtProblems(ledger.rows, new Date());
  if (problems.length) {
    console.error(`${problems.length} old decision(s) or debt(s) in apps/mobile/contract/parity/ledger.json:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`ledger: no decision or debt older than ${DEBT_DAYS} days`);
}
