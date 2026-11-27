import { expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull } from '@plannotator/core/inbox-types';
import { pullHandoffAskLine, pullHandoffMessage } from './model';

const REPO = 'northwind/web-app';
const pr = (number: number, fields: Partial<InboxPull> = {}): InboxPull => ({
  key: `github.com/${REPO}#${number}`,
  platform: 'github',
  host: 'github.com',
  repo: REPO,
  number,
  url: `https://github.com/${REPO}/pull/${number}`,
  title: `PR ${number}`,
  author: 'tomas',
  mine: false,
  requested: true,
  state: 'open',
  base: 'main',
  head: `feat/${number}`,
  head_repo: REPO,
  additions: 3,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  updated_at: '2026-11-03T09:00:00.000Z',
  merged_at: null,
  ...fields,
});

test("a Picture it hand-off's step 1 asks for a page of the PR's diff through /picture-it, with the person's words after it", () => {
  const one = inboxPullStacks([pr(880)])[0]!;
  expect(pullHandoffAskLine(one, { kind: 'picture_it' })).toBe('1. Send me a Picture page of its diff against main, using /picture-it (its instructions are at the end of this message).');
  expect(pullHandoffAskLine(one, { kind: 'picture_it', words: ' just the retry path ' })).toBe('1. Send me a Picture page of its diff against main, using /picture-it just the retry path (its instructions are at the end of this message).');
  const message = pullHandoffMessage(one, { kind: 'picture_it' });
  expect(message).toContain('What to do\n1. Send me a Picture page of its diff against main, using /picture-it');
  expect(message).not.toContain('/review-curate');
});

test("a stack's Picture it covers the whole stack, from its base to the top layer's branch", () => {
  const stack = inboxPullStacks([pr(880), pr(881, { base: 'feat/880' })])[0]!;
  expect(pullHandoffAskLine(stack, { kind: 'picture_it' })).toBe("1. Send me a Picture page of the whole stack's diff, from main to feat/881, using /picture-it (its instructions are at the end of this message).");
});
