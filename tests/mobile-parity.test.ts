/**
 * The phone decides everything the window offers (docs/agent-guides/mobile.md).
 * scripts/mobile/surface.ts reads the window's surface from the product itself
 * (the door's routes, the Inbox endpoints, frames, record kinds, wire fields,
 * blocks, Settings sections, flow checks), and every entry needs a row in
 * apps/mobile/contract/parity/ledger.json that marks it v1, rethink, later or
 * never. A debt the phone owes fails after 14 days.
 *
 * What can regress, and the test that says so:
 *  - the window gains a route, frame, field or block with no decision for the
 *    phone, or loses one a row still names ("the ledger decides");
 *  - a row with a mark that is not one of the four, later or never with no
 *    why, or an old debt ("the rules");
 *  - the rules themselves letting a gap or an old debt through ("the rules").
 *
 * Reads committed JSON and a few source files as text; imports no React and
 * builds nothing.
 */
import { describe, expect, test } from 'bun:test';
import { parityProblems, readLedger, type Ledger } from '../scripts/mobile/parity';
import { buildSurface, surfaceEntries } from '../scripts/mobile/surface';

describe('the ledger decides', () => {
  test('every entry of the window has a ledger row, and every row names entries that exist', () => {
    const surface = buildSurface();
    const problems = parityProblems(readLedger(), surfaceEntries(surface), surface.check ?? [], new Date());
    if (problems.length) throw new Error(`${problems.length} parity problem(s):\n${problems.join('\n')}`);
  }, 10_000);
});

describe('the rules', () => {
  const row = (over: Partial<Ledger['rows'][number]>): Ledger['rows'][number] => ({
    id: 'r', title: 't', surface: [], flows: [], mobile: 'v1', why: '', ios: { state: 'not-started' }, ...over,
  });
  const now = new Date('2026-12-01T00:00:00Z');

  test('a new entry fails with the words that say what to do', () => {
    expect(parityProblems({ rows: [row({ surface: ['door:GET a'] })] }, ['door:GET a', 'door:GET b'], [], now)).toEqual([
      'The window gained `door:GET b`. Decide for the phone: add it to apps/mobile/contract/parity/ledger.json as v1, later, never or rethink',
    ]);
  });

  test('a row naming an entry that is gone fails', () => {
    expect(parityProblems({ rows: [row({ surface: ['door:GET a', 'door:GET gone'] })] }, ['door:GET a'], [], now)).toEqual([
      'The window lost `door:GET gone`. Remove it from ledger row r.',
    ]);
  });

  test('later and never need a why; the mark is one of four', () => {
    const p = parityProblems({ rows: [row({ id: 'a', mobile: 'later' }), row({ id: 'b', mobile: 'maybe' as 'v1' }), row({ id: 'c', mobile: 'never', why: 'N-web' })] }, [], [], now);
    expect(p).toEqual(['a: later needs a why.', 'b: mobile is "maybe"; it is v1, rethink, later or never.']);
  });

  test('a debt fails after 14 days, not before, and needs its date', () => {
    const owed = (id: string, owed_since?: string) => row({ id, ios: { state: 'owed', owed_since } });
    const p = parityProblems({ rows: [owed('fresh', '2026-11-20'), owed('old', '2026-11-10'), owed('undated')] }, [], [], now);
    expect(p).toEqual([
      'old: ios has owed it since 2026-11-10, over 14 days. Build it, or decide again in the ledger.',
      'undated: ios owes it, with no owed_since date.',
    ]);
  });

  test('two rows with one id, and a flow check that does not exist, fail', () => {
    const p = parityProblems({ rows: [row({ id: 'x', flows: ['list-01'] }), row({ id: 'x', flows: ['list-99'] })] }, [], ['list-01'], now);
    expect(p).toEqual(['Two ledger rows have the id x.', 'x: no flow check list-99.']);
  });
});
