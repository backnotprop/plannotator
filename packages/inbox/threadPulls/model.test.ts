/**
 * Where a thread's PR row's "Open review thread" goes (`pullReviewLinks`). What regresses: a link on a merged or
 * closed PR, or on one Reviews does not list (its target would be a blank page); a thread that only named the PR
 * taken for its review thread; a PR with a review thread sent to its launchpad instead; a link on the row whose
 * review thread is the thread the list is in; and a link before Reviews' list was read.
 */
import { describe, expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull, type InboxPullLink, type InboxPullsAnswer, type InboxReviewRow, type InboxThreadPullState } from '@plannotator/core/inbox-types';
import { reviewsOfPulls } from '../pulls/reviewsTestState';
import { pullReviewLinks } from './model';

const HERE = 'msg_01M5HERE000000000000000001';
const REVIEW = 'msg_01M5REVIEW0000000000000001';

function pr(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = 'acme/bundler-web';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `PR ${number}`,
    author: 'dana',
    mine: false,
    requested: true,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
    additions: 1,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: null,
    updated_at: '2026-11-03T10:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

const link = (thread: string, fields: Partial<InboxPullLink> = {}): InboxPullLink => ({
  via: 'owner',
  thread_id: thread,
  thread_subject: null,
  project_id: 'prj_1',
  agent: { host: 'claude-code', session: 'ses_1', name: null },
  last: null,
  guide: null,
  ...fields,
});

const answer = (pulls: InboxPull[], links: Record<string, InboxPullLink> = {}): InboxPullsAnswer => ({ fetched_at: null, hosts: [], pulls, links, projects: {}, cards: {} });
/** Reviews' rows with the stack holding `key` reviewed (it has a review thread). */
const reviewedRows = (model: InboxPullsAnswer, key: string) => ({ rows: [{ reviewed: true, stacks: inboxPullStacks(model.pulls).filter((s) => s.layers.some((l) => l.key === key)) } as unknown as InboxReviewRow] });
const row = (n: number, state: InboxThreadPullState = 'open') => ({ pull: `github.com/acme/bundler-web#${n}`, state });

describe('pullReviewLinks', () => {
  test('a PR with a review thread: the thread, with the agent the launchpad names', () => {
    const model = answer([pr(9802)], { 'github.com/acme/bundler-web#9802': link(REVIEW) });
    const linkOf = pullReviewLinks(model, reviewedRows(model, 'github.com/acme/bundler-web#9802'));
    expect(linkOf(row(9802), HERE)).toEqual({ kind: 'thread', threadId: REVIEW, agent: { host: 'claude-code', name: 'Claude Code' } });
  });

  test('an ended agent keeps its thread as the review thread', () => {
    const model = answer([pr(9802)], { 'github.com/acme/bundler-web#9802': link(REVIEW, { agent: { host: 'codex', session: 'ses_2', name: 'Night shift', ended: true } }) });
    expect(pullReviewLinks(model, null)(row(9802), HERE)).toEqual({ kind: 'thread', threadId: REVIEW, agent: { host: 'codex', name: 'Night shift' } });
  });

  test('no review thread yet: the PR\'s page in Reviews; a draft too', () => {
    const model = answer([pr(9811), pr(9810, { state: 'draft' })]);
    const linkOf = pullReviewLinks(model, reviewsOfPulls(model));
    expect(linkOf(row(9811), HERE)).toEqual({ kind: 'launchpad', stackId: inboxPullStacks(model.pulls).find((s) => s.layers[0]!.number === 9811)!.id });
    expect(linkOf(row(9810, 'draft'), HERE)?.kind).toBe('launchpad');
  });

  test('a thread that only named the PR is no review thread: its page in Reviews', () => {
    // The agent's message held the PR's link (`url`) and Reviews' row says it is not reviewed.
    const model = answer([pr(9811)], { 'github.com/acme/bundler-web#9811': link(REVIEW, { via: 'url' }) });
    const linkOf = pullReviewLinks(model, reviewsOfPulls(model));
    expect(linkOf(row(9811), HERE)?.kind).toBe('launchpad');
  });

  test('a layer of a stack of several goes to its stack\'s review thread, or its stack page', () => {
    const layers = [pr(1, { head: 'l1' }), pr(2, { head: 'l2', base: 'l1' })];
    const stackId = inboxPullStacks(layers)[0]!.id;
    expect(pullReviewLinks(answer(layers), null)(row(2), HERE)).toEqual({ kind: 'launchpad', stackId });
    const linked = answer(layers, { 'github.com/acme/bundler-web#1': link(REVIEW) });
    expect(pullReviewLinks(linked, reviewedRows(linked, 'github.com/acme/bundler-web#1'))(row(2), HERE)?.kind).toBe('thread');
  });

  test('no link: merged, closed or not read yet; a PR Reviews does not list; no list read yet', () => {
    const model = answer([pr(9788, { state: 'merged', merged_at: '2026-11-02T10:00:00.000Z' }), pr(9811)]);
    const linkOf = pullReviewLinks(model, reviewsOfPulls(model));
    expect(linkOf(row(9788, 'merged'), HERE)).toBeNull();
    expect(linkOf(row(9811, 'closed'), HERE)).toBeNull();
    expect(linkOf(row(9811, 'unknown'), HERE)).toBeNull();
    // The thread still reads it open, but Reviews has it merged: Reviews would open no launchpad for it.
    expect(linkOf(row(9788, 'open'), HERE)).toBeNull();
    expect(linkOf(row(4242), HERE)).toBeNull();
    expect(pullReviewLinks(null, null)(row(9811), HERE)).toBeNull();
  });

  test('the row whose review thread is the thread the list is in has none', () => {
    const model = answer([pr(9802)], { 'github.com/acme/bundler-web#9802': link(HERE) });
    const linkOf = pullReviewLinks(model, reviewedRows(model, 'github.com/acme/bundler-web#9802'));
    expect(linkOf(row(9802), HERE)).toBeNull();
    expect(linkOf(row(9802), REVIEW)?.kind).toBe('thread');
  });
});
