/**
 * The parity ledger's rules (apps/mobile/contract/parity/ledger.json,
 * docs/agent-guides/mobile.md): every entry of the window's surface has a row
 * that decides it for the phone, no entry carries two decisions that disagree,
 * and a feature the app built is marked owed when the window changes it.
 * scripts/mobile/check.ts runs them on the real ledger (never a unit test);
 * tests/mobile-parity.test.ts checks them on fixed ledgers. The clock (an
 * undecided row or a debt older than 14 days) is parity-debts.ts, run apart.
 *
 * The one command, `bun scripts/mobile/all.ts`, keeps the ledger in step
 * (ledgerInStep, through ledger.ts): an entry the window gained becomes an
 * `undecided` row dated today, an entry it lost leaves its row, and a built
 * feature the window changed becomes `owed`. An Inbox author never picks a
 * mark; the owner's operators decide undecided rows within the 14 days.
 *
 * Rules only: this module reads no file and imports no product code, so its
 * test never fails for an Inbox change (scripts/ci-affected-map.test.ts holds
 * that). Reading the real ledger and the live surface is ledger.ts.
 */
import { createHash } from 'node:crypto';
import { REGENERATE } from './lib';

/** v1 and rethink: in the first app (rethink: done the phone's way). undecided: the owner has not decided yet (needs `since`). */
export const MOBILE_MARKS = ['v1', 'rethink', 'later', 'never', 'undecided'] as const;
/** not-started and building: planned work. done: the app has it. owed: the window changed something the app had, and the app has not caught up. */
export const CLIENT_STATES = ['not-started', 'building', 'done', 'owed'] as const;

type Client = { state: (typeof CLIENT_STATES)[number]; since?: string; owed_since?: string; fingerprint?: string };

export type LedgerRow = {
  id: string;
  title: string;
  surface: string[];
  flows: string[];
  mobile: (typeof MOBILE_MARKS)[number];
  why: string;
  reason?: string;
  source?: string;
  /** undecided: the day the row was added (YYYY-MM-DD). */
  since?: string;
  /** The app decodes these entries (Wire.swift); a fact about reading, separate from the mark, which is about showing. */
  decoded?: boolean;
  ios: Client;
  android?: Client;
};

export type Ledger = { about?: string; rows: LedgerRow[] };


export const gained = (entry: string) =>
  `The window gained \`${entry}\`. Run \`${REGENERATE}\` and commit: it records the entry in the ledger as undecided, for the owner to decide.`;

/** Marks that agree: v1 and rethink are both "in the first app". */
const decision = (mark: string) => (mark === 'rethink' ? 'v1' : mark);

/** A row's fingerprint: its entries' together. */
export function rowFingerprint(row: Pick<LedgerRow, 'surface'>, prints: ReadonlyMap<string, string>): string {
  const text = [...row.surface].sort().map((e) => `${e}=${prints.get(e) ?? e}`).join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Every way the ledger fails the surface, as the lines a person reads. Empty: it holds. No date rule here (parity-debts.ts). */
export function parityProblems(ledger: Ledger, entries: readonly string[], checks: readonly string[], prints: ReadonlyMap<string, string> = new Map()): string[] {
  const problems: string[] = [];
  const live = new Set(entries);
  const marks = new Map<string, Set<string>>();
  const ids = new Set<string>();
  for (const row of ledger.rows) {
    if (ids.has(row.id)) problems.push(`Two ledger rows have the id ${row.id}.`);
    ids.add(row.id);
    if (!MOBILE_MARKS.includes(row.mobile)) problems.push(`${row.id}: mobile is ${JSON.stringify(row.mobile)}; it is v1, rethink, later, never or undecided.`);
    if ((row.mobile === 'later' || row.mobile === 'never') && !row.why?.trim()) problems.push(`${row.id}: ${row.mobile} needs a why.`);
    if (row.mobile === 'undecided' && !/^\d{4}-\d{2}-\d{2}$/.test(row.since ?? '')) problems.push(`${row.id}: undecided needs \`since\`, the day it was added (YYYY-MM-DD).`);
    for (const entry of row.surface) {
      if (!live.has(entry)) problems.push(`The window lost \`${entry}\` (ledger row ${row.id}). Run \`${REGENERATE}\` and commit.`);
      if (!marks.has(entry)) marks.set(entry, new Set());
      if (row.mobile !== 'undecided') marks.get(entry)!.add(`${decision(row.mobile)}:${row.id}`);
    }
    for (const check of row.flows) if (!checks.includes(check)) problems.push(`${row.id}: no flow check ${check}.`);
    for (const [client, state] of [['ios', row.ios], ['android', row.android]] as const) {
      if (!state) continue;
      if (!CLIENT_STATES.includes(state.state)) problems.push(`${row.id}: ${client}.state is ${JSON.stringify(state.state)}.`);
      if (state.state === 'owed' && !state.owed_since) problems.push(`${row.id}: ${client} owes it, with no owed_since date.`);
      if (state.state === 'done') {
        if (!state.fingerprint) problems.push(`${row.id}: ${client} is done with no fingerprint. Run \`${REGENERATE}\` and commit.`);
        else if (prints.size && state.fingerprint !== rowFingerprint(row, prints)) {
          problems.push(`${row.id}: the window changed what ${client} built. Run \`${REGENERATE}\` and commit: it records the debt.`);
        }
      }
    }
  }
  for (const [entry, seen] of marks) {
    const by = new Map<string, string[]>();
    for (const m of seen) {
      const [mark, id] = m.split(/:(.*)/s) as [string, string];
      by.set(mark, [...(by.get(mark) ?? []), id]);
    }
    if (by.size > 1) problems.push(`\`${entry}\` has two decisions: ${[...by].map(([m, rows]) => `${m} (${rows.sort().join(', ')})`).join(' and ')}. Keep it in one.`);
  }
  for (const entry of entries) if (!marks.has(entry)) problems.push(gained(entry));
  return problems;
}

const today = () => new Date().toISOString().slice(0, 10);
const slug = (entry: string) => entry.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Every entry no row names gets an undecided row of its own, dated today. */
export function deferNew(ledger: Ledger, entries: readonly string[], day = today()): Ledger {
  const named = new Set(ledger.rows.flatMap((r) => r.surface));
  const added: LedgerRow[] = entries.filter((e) => !named.has(e)).map((e) => ({
    id: `undecided-${slug(e)}`, title: e, surface: [e], flows: [], mobile: 'undecided', why: '', since: day, ios: { state: 'not-started' },
  }));
  return { ...ledger, rows: [...ledger.rows, ...added] };
}

/** A built feature whose entries changed becomes owed today; a done row with no fingerprint records it. */
export function markOwed(ledger: Ledger, prints: ReadonlyMap<string, string>, day = today()): Ledger {
  const rows = ledger.rows.map((row) => {
    const now = rowFingerprint(row, prints);
    const update = (state: Client | undefined): Client | undefined => {
      if (!state || state.state !== 'done') return state;
      if (!state.fingerprint) return { ...state, fingerprint: now };
      return state.fingerprint === now ? state : { ...state, state: 'owed', owed_since: day, fingerprint: now };
    };
    return { ...row, ios: update(row.ios)!, ...(row.android ? { android: update(row.android) } : {}) };
  });
  return { ...ledger, rows };
}

/** Entries the window no longer has leave every row (a row may end up naming none, which is allowed). */
export function dropGone(ledger: Ledger, entries: readonly string[]): Ledger {
  const live = new Set(entries);
  return { ...ledger, rows: ledger.rows.map((row) => (row.surface.every((e) => live.has(e)) ? row : { ...row, surface: row.surface.filter((e) => live.has(e)) })) };
}

/** The ledger kept in step with the window: gone entries dropped, new ones undecided today, changed built features owed. */
export function ledgerInStep(ledger: Ledger, entries: readonly string[], prints: ReadonlyMap<string, string>, day = today()): Ledger {
  return markOwed(deferNew(dropGone(ledger, entries), entries, day), prints, day);
}

/**
 * The decided rows that named entries before and name none after (a rename, or a feature the window dropped): the
 * one command leaves each naming nothing, so its decision is moved by hand to whatever replaced it. Rows that never
 * named an entry (a behavior with no entry of its own) are not listed.
 */
export function emptiedRows(before: Ledger, after: Ledger): LedgerRow[] {
  const now = new Map(after.rows.map((r) => [r.id, r]));
  return before.rows.filter((r) => r.mobile !== 'undecided' && r.surface.length > 0 && now.get(r.id)?.surface.length === 0);
}
