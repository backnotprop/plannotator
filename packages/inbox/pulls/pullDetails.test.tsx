/**
 * The details' checks on the numbers a real project has. What regresses: a hundred green rows pushing the labels out of
 * the column, skipped checks counted as passed, and what needs eyes hidden behind the line.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPullCheck, InboxPullDetailsAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { byState, CheckRows, DetailsStatus, reviewWords } = (hasDom ? await import('./PullDetails') : {}) as typeof import('./PullDetails');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  if (!hasDom) return;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root.unmount());
  host.remove();
});

const many = (n: number, state: InboxPullCheck['state'], note?: string): InboxPullCheck[] =>
  Array.from({ length: n }, (_, i) => ({ name: `${note ?? state} ${i}`, state, ...(note ? { note } : {}) }));
const draw = (checks: InboxPullCheck[]) => act(() => root.render(<CheckRows checks={checks} />));
const rows = () => host.querySelectorAll('[data-pull-details-check]').length;
const line = () => host.querySelector('button');

test.if(hasDom)('a few passed checks are a list; many are a line that says what ran and what was skipped, and opens', () => {
  draw(many(3, 'pass'));
  expect(rows()).toBe(3);
  expect(line()).toBeNull();

  draw([...many(14, 'pass'), ...many(29, 'pass', 'Skipped')]);
  expect(rows()).toBe(0);
  expect(line()!.textContent).toBe('14 passed, 29 skipped');
  act(() => line()!.click());
  expect(rows()).toBe(43);
  expect(host.querySelectorAll('[data-pull-details-check]')[0]!.textContent).toContain('pass 0');
});

test.if(hasDom)('what needs eyes stays on the column, whatever else folds, and is first when opened', () => {
  draw([...many(120, 'pass'), ...many(2, 'fail'), ...many(1, 'pending')]);
  expect(rows()).toBe(3);
  expect(line()!.textContent).toBe('120 passed');
  act(() => line()!.click());
  expect(host.querySelectorAll('[data-pull-details-check]')[0]!.getAttribute('data-pull-details-check')).toBe('fail');
});

test.if(hasDom)("an answer with no comments list, from an older server, leaves the bar's control standing", () => {
  const partial = { key: 'k', description: null, labels: [], reviewers: [], checks: [] } as unknown as InboxPullDetailsAnswer;
  act(() => root.render(<DetailsStatus data={partial} />));
  expect(host.querySelector('[data-pull-details-comments]')).toBeNull();
});

test.if(hasDom)("a bot that only commented neither leads the reviewers nor says where the review stands, as on a real next.js PR", () => {
  const bot = { login: 'vercel-fleet-prod', state: 'commented' as const, bot: true };
  const waiting = [{ login: 'ana', state: 'waiting' as const }, { login: 'kim', state: 'waiting' as const }];
  expect(byState([bot, ...waiting]).map((r) => r.login)).toEqual(['ana', 'kim', 'vercel-fleet-prod']);
  expect(reviewWords([bot, ...waiting])).toBe('Waiting');
  // Alone, it is what there is; and a person's comment still counts.
  expect(reviewWords([bot])).toBe('Commented');
  expect(reviewWords([{ login: 'ana', state: 'commented' }, ...waiting])).toBe('Commented');
  // A bot that asks for changes is heard.
  expect(reviewWords([{ ...bot, state: 'changes' }, ...waiting])).toBe('Changes requested');
});
