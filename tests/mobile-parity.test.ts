/**
 * The phone decides everything the window offers (docs/agent-guides/mobile.md).
 * scripts/mobile/surface.ts reads the window's surface from the product itself
 * (the door's routes, the server's endpoints, frames, record kinds, enum
 * values, wire fields, blocks, Settings, capabilities, flow checks), and every
 * entry needs a row in apps/mobile/contract/parity/ledger.json that decides it
 * for the phone (v1, rethink, later, never) or leaves it undecided, dated.
 *
 * Whether the committed ledger is in step with the live surface is
 * scripts/mobile/check.ts (the mobile-contract workflow), never a unit lane,
 * so an Inbox pull request never fails for a new entry. These tests check the
 * rules and the one command on fixed ledgers.
 *
 * What can regress, and the test that says so:
 *  - a row with a mark that is not one of the five, later or never with no
 *    why, undecided with no date, one entry with two decisions, a built
 *    feature the window changed without it being marked owed ("the rules");
 *  - the one command (bun scripts/mobile/all.ts) keeping the ledger in step
 *    other than it promises, or a rename leaving a decided row naming
 *    nothing without saying so ("the tools").
 * The 14-day clock is tests/mobile-parity-debts.test.ts, apart, so a pull
 * request that only changes the Inbox never fails for an old debt.
 *
 * Imports only the rules (parity.ts), which read no file and no product code.
 */
import { describe, expect, test } from 'bun:test';
import { deferNew, emptiedRows, gained, ledgerInStep, markOwed, parityProblems, rowFingerprint, type Ledger } from '../scripts/mobile/parity';

const row = (over: Partial<Ledger['rows'][number]>): Ledger['rows'][number] => ({
  id: 'r', title: 't', surface: [], flows: [], mobile: 'v1', why: '', ios: { state: 'not-started' }, ...over,
});

describe('the rules', () => {
  test('a new entry fails, and the message names the one command', () => {
    expect(parityProblems({ rows: [row({ surface: ['door:GET a'] })] }, ['door:GET a', 'door:GET b'], [])).toEqual([gained('door:GET b')]);
    expect(gained('door:GET b')).toContain('Run `bun scripts/mobile/all.ts` and commit');
  });

  test('a row naming an entry that is gone fails', () => {
    expect(parityProblems({ rows: [row({ surface: ['door:GET a', 'door:GET gone'] })] }, ['door:GET a'], [])).toEqual([
      'The window lost `door:GET gone` (ledger row r). Run `bun scripts/mobile/all.ts` and commit.',
    ]);
  });

  test('later and never need a why; undecided needs its day; the mark is one of five', () => {
    const p = parityProblems({
      rows: [
        row({ id: 'a', mobile: 'later' }), row({ id: 'b', mobile: 'maybe' as 'v1' }), row({ id: 'c', mobile: 'never', why: 'N-web' }),
        row({ id: 'd', mobile: 'undecided' }), row({ id: 'e', mobile: 'undecided', since: '2026-11-18' }),
      ],
    }, [], []);
    expect(p).toEqual([
      'a: later needs a why.', 'b: mobile is "maybe"; it is v1, rethink, later, never or undecided.',
      'd: undecided needs `since`, the day it was added (YYYY-MM-DD).',
    ]);
  });

  test('one entry with two decisions fails; v1 and rethink agree; an undecided row beside a decision does not count', () => {
    const rows = [
      row({ id: 'a', surface: ['field:T.x', 'field:T.y', 'field:T.z'] }),
      row({ id: 'b', mobile: 'never', why: 'N-web', surface: ['field:T.x'] }),
      row({ id: 'c', mobile: 'rethink', surface: ['field:T.y'] }),
      row({ id: 'd', mobile: 'undecided', since: '2026-11-18', surface: ['field:T.z'] }),
    ];
    expect(parityProblems({ rows }, ['field:T.x', 'field:T.y', 'field:T.z'], [])).toEqual(['`field:T.x` has two decisions: v1 (a) and never (b). Keep it in one.']);
  });

  test('a built feature the window changed fails until it is marked owed; one never recorded fails too', () => {
    const prints = new Map([['field:T.x', 'aaaa']]);
    const built = row({ id: 'built', surface: ['field:T.x'], ios: { state: 'done', fingerprint: rowFingerprint({ surface: ['field:T.x'] }, prints) } });
    expect(parityProblems({ rows: [built] }, ['field:T.x'], [], prints)).toEqual([]);
    const changed = new Map([['field:T.x', 'bbbb']]);
    expect(parityProblems({ rows: [built] }, ['field:T.x'], [], changed)).toEqual(['built: the window changed what ios built. Run `bun scripts/mobile/all.ts` and commit: it records the debt.']);
    expect(parityProblems({ rows: [row({ id: 'n', ios: { state: 'done' } })] }, [], [], prints)).toEqual([
      'n: ios is done with no fingerprint. Run `bun scripts/mobile/all.ts` and commit.',
    ]);
  });

  test('two rows with one id, and a flow check that does not exist, fail', () => {
    const p = parityProblems({ rows: [row({ id: 'x', flows: ['list-01'] }), row({ id: 'x', flows: ['list-99'] })] }, [], ['list-01']);
    expect(p).toEqual(['Two ledger rows have the id x.', 'x: no flow check list-99.']);
  });
});

describe('the tools', () => {
  test('a new entry gets an undecided row of its own, dated, and the ledger then holds', () => {
    const next = deferNew({ rows: [row({ surface: ['door:GET a'] })] }, ['door:GET a', 'field:T.new'], '2026-11-18');
    expect(next.rows.at(-1)).toEqual(row({ id: 'undecided-field-t-new', title: 'field:T.new', surface: ['field:T.new'], mobile: 'undecided', since: '2026-11-18' }));
    expect(parityProblems(next, ['door:GET a', 'field:T.new'], [])).toEqual([]);
  });

  test('a changed built feature becomes owed today, and a fingerprint never recorded is recorded', () => {
    const before = new Map([['field:T.x', 'aaaa']]);
    const after = new Map([['field:T.x', 'bbbb']]);
    const built = row({ id: 'built', surface: ['field:T.x'], ios: { state: 'done', fingerprint: rowFingerprint({ surface: ['field:T.x'] }, before) } });
    const owed = markOwed({ rows: [built, row({ id: 'n', surface: ['field:T.x'], ios: { state: 'done' } })] }, after, '2026-11-18');
    expect(owed.rows[0]!.ios).toEqual({ state: 'owed', owed_since: '2026-11-18', fingerprint: rowFingerprint({ surface: ['field:T.x'] }, after) });
    expect(owed.rows[1]!.ios).toEqual({ state: 'done', fingerprint: rowFingerprint({ surface: ['field:T.x'] }, after) });
  });

  test('the one command keeps the ledger in step: a lost entry leaves its row, a new one is undecided, and the ledger holds', () => {
    const prints = new Map([['field:T.x', 'aaaa']]);
    const before: Ledger = { rows: [row({ id: 'a', surface: ['field:T.x', 'field:T.gone'] })] };
    const next = ledgerInStep(before, ['field:T.x', 'field:T.new'], prints, '2026-11-18');
    expect(next.rows.map((r) => [r.id, r.surface, r.mobile])).toEqual([['a', ['field:T.x'], 'v1'], ['undecided-field-t-new', ['field:T.new'], 'undecided']]);
    expect(parityProblems(next, ['field:T.x', 'field:T.new'], [], prints)).toEqual([]);
    expect(ledgerInStep(next, ['field:T.x', 'field:T.new'], prints, '2026-12-01')).toEqual(next);
  });

  test('a decided row whose every entry is gone is listed; one that never named an entry, or an undecided one, is not', () => {
    const before: Ledger = {
      rows: [
        row({ id: 'renamed', surface: ['field:T.old'] }),
        row({ id: 'behavior', surface: [] }),
        row({ id: 'kept', surface: ['field:T.x', 'field:T.old'] }),
        row({ id: 'pending', surface: ['field:T.gone'], mobile: 'undecided', since: '2026-11-01' }),
      ],
    };
    const after = ledgerInStep(before, ['field:T.x', 'field:T.new'], new Map(), '2026-11-18');
    expect(emptiedRows(before, after).map((r) => [r.id, r.surface])).toEqual([['renamed', ['field:T.old']]]);
    expect(emptiedRows(after, ledgerInStep(after, ['field:T.x', 'field:T.new'], new Map(), '2026-11-19'))).toEqual([]);
  });
});
