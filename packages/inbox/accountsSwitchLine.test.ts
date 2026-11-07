/**
 * `switchLine` (useAccounts.tsx): what the page says after a switch, from the
 * switch's answer and the read after it. Pure, so it runs whether or not
 * INBOX_ACCOUNT_SWITCHING is on; the page around it is
 * accountsSection.test.tsx.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxAccount } from '@plannotator/core/inbox-types';
import { switchLine, type AccountsView } from './useAccounts';

const PERSONAL = { number: 1, email: 'a@fake.test', organizationName: 'Home', alias: 'personal' };
const row = (fields: Partial<InboxAccount>): InboxAccount => ({ number: 1, email: null, organizationName: null, alias: null, isOrganization: false, active: false, usageStatus: 'ok', usage: null, ...fields }) as InboxAccount;
const list = (...accounts: InboxAccount[]): AccountsView => ({ state: 'accounts', accounts });
/** The read after the switch shows `PERSONAL` in use. */
const shown = list(row({ ...PERSONAL, active: true }), row({ number: 2, email: 'b@fake.test' }));
/** The read after shows another login in use. */
const notShown = list(row({ ...PERSONAL }), row({ number: 2, email: 'b@fake.test', active: true }));
const readFailed: AccountsView = { state: 'failed', reason: 'timed_out' };

describe('switchLine', () => {
  test('the read after has the last word: the login in use there is done, whatever the answer said', () => {
    expect(switchLine({ state: 'switched', number: 1 }, shown, PERSONAL)).toBeNull();
    expect(switchLine({ state: 'failed', reason: 'timed_out' }, shown, PERSONAL)).toBeNull();
    expect(switchLine({ state: 'failed', reason: 'unreachable' }, shown, PERSONAL)).toBeNull();
  });

  test('the same number with another login in use is not done', () => {
    const other = list(row({ ...PERSONAL, alias: 'renamed', active: true }));
    expect(switchLine({ state: 'switched', number: 1 }, other, PERSONAL)).toBe('run_failed');
  });

  test('switched, and the read after failed: unconfirmed, never a failure; switched and not shown: it did not switch', () => {
    expect(switchLine({ state: 'switched', number: 1 }, readFailed, PERSONAL)).toBe('unconfirmed');
    expect(switchLine({ state: 'switched', number: 1 }, { state: 'unreachable' }, PERSONAL)).toBe('unconfirmed');
    expect(switchLine({ state: 'switched', number: 1 }, notShown, PERSONAL)).toBe('run_failed');
  });

  test('past the wait: still switching while no read can tell, a failure once a read shows another login', () => {
    expect(switchLine({ state: 'failed', reason: 'timed_out' }, readFailed, PERSONAL)).toBe('still_switching');
    expect(switchLine({ state: 'failed', reason: 'timed_out' }, notShown, PERSONAL)).toBe('run_failed');
  });

  test('every other answer is its own line', () => {
    expect(switchLine({ state: 'not_installed' }, notShown, PERSONAL)).toBe('not_installed');
    for (const reason of ['changed', 'renumbered', 'busy', 'run_failed', 'bad_output', 'unknown_schema', 'owner_only', 'unreachable'] as const) {
      expect(switchLine({ state: 'failed', reason }, notShown, PERSONAL)).toBe(reason);
    }
  });
});
