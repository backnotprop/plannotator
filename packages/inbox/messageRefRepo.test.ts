import { describe, expect, test } from 'bun:test';
import type { InboxProjectRepo } from '@plannotator/core/inbox-types';
import { messageRefRepo, threadPullKeys } from './messageRefRepo';
import { threadLinks } from './threadLinks';

let next = 0;
const writer: InboxProjectRepo = { display: 'backnotprop/plannotator', host: 'github.com' };
const threadRepo: InboxProjectRepo = { display: 'acme/billing', host: 'github.com' };
const fromWriter = (body: string, repo: InboxProjectRepo | null = writer) => ({ id: `m${next++}`, body, from_project: { name: 'plannotator', root: '/w/plannotator', repo } });
const notLookedUp = (body: string) => ({ id: `m${next++}`, body, from_project: { name: 'plannotator', root: '/w/plannotator' } });
const plain = (body: string) => ({ id: `m${next++}`, body });
const attached = ['github.com/backnotprop/plannotator#3951', 'github.com/acme/web#12'];

describe('which repository a bare #123 links into', () => {
  test("the writer's repository wins over the thread's", () => {
    expect(messageRefRepo(fromWriter('See #3951.'), threadRepo, [])).toEqual(writer);
  });

  test("the thread's repository for a message with no writer's folder (the thread's own agent, the person, a message stored before the fix)", () => {
    expect(messageRefRepo(plain('See #3951.'), threadRepo, attached)).toEqual(threadRepo);
  });

  test("a writer's folder with no repository falls back to the thread's, never to an attached PR", () => {
    expect(messageRefRepo(fromWriter('See #3951.', null), threadRepo, [])).toEqual(threadRepo);
    expect(messageRefRepo(fromWriter('See #3951.', null), null, attached)).toBeNull();
  });

  test("a writer's repository not looked up yet is no guess: neither the thread's nor an attached PR's", () => {
    expect(messageRefRepo(notLookedUp('See #3951.'), threadRepo, attached)).toBeNull();
    expect(messageRefRepo(notLookedUp('See #3951.'), null, attached)).toBeNull();
  });

  test('an attached PR with the same number names the repository, only when exactly one repository matches', () => {
    expect(messageRefRepo(plain('Fixed in #3951.'), null, attached)).toEqual(writer);
    expect(messageRefRepo(plain('Fixed in #3951 and #12.'), null, attached)).toBeNull();
    expect(messageRefRepo(plain('Fixed in #3951, see also #77.'), null, attached)).toBeNull();
    expect(messageRefRepo(plain('Fixed in #3951.'), null, [...attached, 'github.com/acme/web#3951'])).toBeNull();
    expect(messageRefRepo(plain('Nothing to link.'), null, attached)).toBeNull();
    expect(messageRefRepo(plain('`#3951` in code'), null, attached)).toBeNull();
    expect(messageRefRepo(plain('Fixed in #3951, not `#77`.'), null, attached)).toBeNull();
    expect(messageRefRepo(plain('Fixed in #3951, see a/#77.'), null, attached)).toBeNull();
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
