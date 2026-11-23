/**
 * Close's notice names what closed (approval "inbox-pr-board-close-safe"). What regresses: one PR said as a bare count
 * instead of its number and title; several without their numbers, in another order than closed; many listing them
 * all instead of three and how many more; a Close across repositories with numbers that can't be told apart.
 */
import { expect, test } from 'bun:test';
import type { InboxPull } from '@plannotator/core/inbox-types';
import { closedList, closedNames, closedToast, reopenRefusedForGood } from './bulkClose';

const pull = (repo: string, number: number, title = `Change ${number}`, platform: InboxPull['platform'] = 'github') =>
  ({ key: `github.com/${repo}#${number}`, host: 'github.com', repo, number, title, platform }) as InboxPull;
const LABELS: Record<string, string> = {
  'github.com/northwind/web-app': 'web-app',
  'github.com/northwind/billing-svc': 'billing-svc',
};
const label = (key: string) => LABELS[key] ?? key;

test('one: its number and its title', () => {
  expect(closedToast([pull('northwind/web-app', 2039, 'Retry sync when the token expires')], label)).toEqual({ lead: 'Closed #2039', detail: 'Retry sync when the token expires' });
});

test('several in one repository: the count, then the numbers in the order closed', () => {
  const three = [2050, 2041, 2039].map((n) => pull('northwind/web-app', n));
  expect(closedToast(three, label)).toEqual({ lead: 'Closed 3', detail: '#2050, #2041, #2039' });
});

test('many: the first three, then how many more', () => {
  const many = Array.from({ length: 128 }, (_, i) => pull('northwind/web-app', 2100 - i));
  expect(closedToast(many, label)).toEqual({ lead: 'Closed 128', detail: '#2100, #2099, #2098 and 125 more' });
});

test('across repositories: each number after its repository, a repository named once for the numbers that follow it', () => {
  const mixed = [pull('northwind/web-app', 2039), pull('northwind/billing-svc', 88), pull('northwind/billing-svc', 85), pull('northwind/web-app', 2001)];
  expect(closedToast(mixed, label)).toEqual({ lead: 'Closed 4', detail: 'web-app #2039 · billing-svc #88, #85 and 1 more' });
  expect(closedNames(mixed, label).groups).toEqual([
    { repo: 'web-app', numbers: ['#2039'] },
    { repo: 'billing-svc', numbers: ['#88', '#85'] },
  ]);
  // GitLab's own mark.
  expect(closedList(closedNames([pull('northwind/web-app', 7, 'x', 'gitlab'), pull('northwind/web-app', 9, 'y', 'gitlab')], label))).toBe('!7, !9');
});

test('a reopen refused for good is not offered again; one that may pass is', () => {
  expect(['reopen_not_closed_here', 'pull_merged', 'pull_open', 'pull_unknown'].every(reopenRefusedForGood)).toBe(true);
  expect([undefined, 'pull_close_failed', 'pull_state_unknown', 'machine_offline'].some(reopenRefusedForGood)).toBe(false);
});
