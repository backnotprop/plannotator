import type { InboxPull, InboxPullLink, InboxPullsAnswer } from '@plannotator/core/inbox-types';

export function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = fields.repo ?? 'northwind/billing-svc';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `Layer ${number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
    additions: 4,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: 'success',
    updated_at: '2026-11-03T09:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

export const LAST = 'msg_01M4H6G73M9H3Z32T859E72DPY';
export const link: InboxPullLink = {
  via: 'url',
  thread_id: 'thr_retries',
  thread_subject: 'Retry the failed charges',
  project_id: 'prj_1',
  agent: { host: 'claude-code', session: 'ses_1', name: null },
  last: { message_id: LAST, preview: 'The stack is up.', at: '2026-11-03T09:00:00.000Z' },
  guide: null,
};

export const stack = [
  pull(412, { head: 'retry/schedule' }),
  pull(413, { head: 'retry/backoff', base: 'retry/schedule' }),
  pull(414, { head: 'retry/dunning', base: 'retry/backoff', state: 'draft' }),
];
export const model: InboxPullsAnswer = {
  fetched_at: '2026-11-03T09:30:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [
    ...stack,
    pull(880, { repo: 'northwind/web-app', mine: false, requested: true, author: 'tomas', head: 'rtl', updated_at: '2026-11-03T10:00:00.000Z' }),
    pull(872, { repo: 'northwind/web-app', review: 'approved', approved_by: 'priya', head: 'vite' }),
    pull(869, { repo: 'northwind/web-app', reviewers: ['jun'], head: 'locale' }),
  ],
  links: { [stack[2]!.key]: link },
  projects: { 'github.com/northwind/billing-svc': ['prj_1'], 'github.com/northwind/web-app': ['prj_2'] },
  cards: {},
};
export const STACK_ID = stack[2]!.key;
