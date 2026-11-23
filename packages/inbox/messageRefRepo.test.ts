import { describe, expect, test } from 'bun:test';
import type { InboxProjectRepo } from '@plannotator/core/inbox-types';
import { messageRefRepo, threadPullKeys } from './messageRefRepo';
import { threadLinks } from './threadLinks';

const writer: InboxProjectRepo = { display: 'backnotprop/plannotator', host: 'github.com' };
const threadRepo: InboxProjectRepo = { display: 'acme/billing', host: 'github.com' };
const fromWriter = (body: string) => ({ body, from_project: { name: 'plannotator', root: '/w/plannotator', repo: writer } });
const plain = (body: string) => ({ body });

describe('which repository a bare #123 links into', () => {
  test("the writer's repository wins over the thread's", () => {
    expect(messageRefRepo(fromWriter('See #3951.'), threadRepo, [])).toEqual(writer);
  });

  test("the thread's repository when the writer has none, as for a message stored before the fix", () => {
    expect(messageRefRepo(plain('See #3951.'), threadRepo, [])).toEqual(threadRepo);
    expect(messageRefRepo({ body: 'See #3951.', from_project: { name: 'scratch', root: '/w/scratch', repo: null } }, threadRepo, [])).toEqual(threadRepo);
    expect(messageRefRepo({ body: 'See #3951.', from_project: { name: 'scratch', root: '/w/scratch' } }, threadRepo, [])).toEqual(threadRepo);
  });

  test('an attached PR with the same number names the repository, only when exactly one repository matches', () => {
    const one = ['github.com/backnotprop/plannotator#3951', 'github.com/acme/web#12'];
    expect(messageRefRepo(plain('Fixed in #3951.'), null, one)).toEqual({ display: 'backnotprop/plannotator', host: 'github.com' });
    expect(messageRefRepo(plain('Fixed in #3951 and #12.'), null, one)).toBeNull();
    expect(messageRefRepo(plain('Fixed in #3951, see also #77.'), null, one)).toBeNull();
    expect(messageRefRepo(plain('Fixed in #3951.'), null, [...one, 'github.com/acme/web#3951'])).toBeNull();
    expect(messageRefRepo(plain('Nothing to link.'), null, one)).toBeNull();
    expect(messageRefRepo(plain('`#3951` in code'), null, one)).toBeNull();
  });

  test("a GitLab merge request does not claim a bare #N, which is the project's issue there", () => {
    expect(messageRefRepo(plain('See #7.'), null, ['gitlab.com/acme/api#7:pull'])).toBeNull();
  });

  test("the thread's PRs come from its pull keys and its row's headline", () => {
    expect(threadPullKeys({ pull_keys: ['github.com/a/b#1'] }, { pulls: { count: 2, headline: { key: 'github.com/c/d#2', state: 'open' } } })).toEqual(['github.com/a/b#1', 'github.com/c/d#2']);
  });
});

describe('the Links view agrees with the message', () => {
  test("each message's #123 is listed under the repository its message links into", () => {
    const messages = [
      { id: 'm0', body: 'Started in #10.' },
      { id: 'm1', body: 'Fixed in #3951.' },
    ];
    const repoOf = (id: string) => (id === 'm1' ? writer : threadRepo);
    const links = threadLinks(messages, repoOf);
    expect(links.repos.map((group) => [group.path, group.links.map((link) => link.href)])).toEqual([
      ['backnotprop/plannotator', ['https://github.com/backnotprop/plannotator/issues/3951']],
      ['acme/billing', ['https://github.com/acme/billing/issues/10']],
    ]);
  });
});
