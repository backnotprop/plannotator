/**
 * The parity ledger's rules (apps/mobile/contract/parity/ledger.json,
 * docs/agent-guides/mobile.md): every entry of the window's surface has a row
 * that decides it for the phone, and a debt the phone owes is never older than
 * DEBT_DAYS. tests/mobile-parity.test.ts runs them on the real ledger.
 */
import { OUT, readRepoText } from './lib';

export const MOBILE_MARKS = ['v1', 'rethink', 'later', 'never'] as const;
/** not-started and building: planned work. done: the app has it. owed: the window changed something the app had, and the app has not caught up. */
export const CLIENT_STATES = ['not-started', 'building', 'done', 'owed'] as const;
export const DEBT_DAYS = 14;

export type LedgerRow = {
  id: string;
  title: string;
  surface: string[];
  flows: string[];
  mobile: (typeof MOBILE_MARKS)[number];
  why: string;
  reason?: string;
  source?: string;
  ios: { state: (typeof CLIENT_STATES)[number]; since?: string; owed_since?: string };
  android?: { state: (typeof CLIENT_STATES)[number]; since?: string; owed_since?: string };
};

export type Ledger = { about?: string; rows: LedgerRow[] };

export function readLedger(): Ledger {
  return JSON.parse(readRepoText(OUT.ledger)) as Ledger;
}

export const gained = (entry: string) =>
  `The window gained \`${entry}\`. Decide for the phone: add it to apps/mobile/contract/parity/ledger.json as v1, later, never or rethink`;

/** Every way the ledger fails the surface, as the lines a person reads. Empty: it holds. */
export function parityProblems(ledger: Ledger, entries: readonly string[], checks: readonly string[], now: Date): string[] {
  const problems: string[] = [];
  const live = new Set(entries);
  const named = new Set<string>();
  const ids = new Set<string>();
  for (const row of ledger.rows) {
    if (ids.has(row.id)) problems.push(`Two ledger rows have the id ${row.id}.`);
    ids.add(row.id);
    if (!MOBILE_MARKS.includes(row.mobile)) problems.push(`${row.id}: mobile is ${JSON.stringify(row.mobile)}; it is v1, rethink, later or never.`);
    if ((row.mobile === 'later' || row.mobile === 'never') && !row.why?.trim()) problems.push(`${row.id}: ${row.mobile} needs a why.`);
    for (const entry of row.surface) {
      named.add(entry);
      if (!live.has(entry)) problems.push(`The window lost \`${entry}\`. Remove it from ledger row ${row.id}.`);
    }
    for (const check of row.flows) if (!checks.includes(check)) problems.push(`${row.id}: no flow check ${check}.`);
    for (const [client, state] of [['ios', row.ios], ['android', row.android]] as const) {
      if (!state) continue;
      if (!CLIENT_STATES.includes(state.state)) problems.push(`${row.id}: ${client}.state is ${JSON.stringify(state.state)}.`);
      if (state.state !== 'owed') continue;
      const since = state.owed_since ? Date.parse(state.owed_since) : Number.NaN;
      if (Number.isNaN(since)) problems.push(`${row.id}: ${client} owes it, with no owed_since date.`);
      else if (now.getTime() - since > DEBT_DAYS * 86_400_000) {
        problems.push(`${row.id}: ${client} has owed it since ${state.owed_since}, over ${DEBT_DAYS} days. Build it, or decide again in the ledger.`);
      }
    }
  }
  for (const entry of entries) if (!named.has(entry)) problems.push(gained(entry));
  return problems;
}
