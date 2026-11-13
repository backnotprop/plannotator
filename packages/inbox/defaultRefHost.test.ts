/**
 * Where an owner/repo#123 links in a thread with no repo (defaultRefHost.ts): the host most projects use. What this
 * catches: a GitLab Inbox sent to github.com, a tie with github.com leaving it, a host no link can be formed for, and
 * ui not told (or told on every list read).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { getCrossRepoRefsWithoutRepo, resetCrossRepoRefsWithoutRepo, setCrossRepoRefsWithoutRepo } from '@plannotator/ui/components/InlineMarkdown';
import { defaultRefHost, learnDefaultRefHost, resetDefaultRefHost } from './defaultRefHost';

const gl = { repo_host: 'gitlab.example.com' };
const gh = { repo_host: 'github.com' };
const none = {};

describe('the host most projects use', () => {
  test('mostly GitLab: GitLab', () => {
    expect(defaultRefHost([gl, gl, gh, none, none, none])).toBe('gitlab.example.com');
  });

  test('no project with a repo: github.com', () => {
    expect(defaultRefHost([])).toBe('github.com');
    expect(defaultRefHost([none, none])).toBe('github.com');
  });

  test('a tie that includes github.com: github.com; a remote naming no host or an SSH alias counts as github.com', () => {
    expect(defaultRefHost([gl, gh])).toBe('github.com');
    // A GitLab host whose name sorts before github.com still loses the tie.
    expect(defaultRefHost([{ repo_host: 'code.gitlab.acme.dev' }, gh])).toBe('github.com');
    expect(defaultRefHost([gl, { repo_host: null }])).toBe('github.com');
    expect(defaultRefHost([gl, gl, { repo_host: null }, { repo_host: 'work-gh' }])).toBe('github.com');
    expect(defaultRefHost([gl, { repo_host: 'GitLab.Example.com:2222' }, gh])).toBe('gitlab.example.com');
  });

  test('another tie: the first host by name; a winner no link can be formed for: github.com', () => {
    expect(defaultRefHost([{ repo_host: 'gitlab.com' }, gl])).toBe('gitlab.com');
    expect(defaultRefHost([{ repo_host: 'git.internal.example' }, { repo_host: 'git.internal.example' }, gl])).toBe('github.com');
    // Mostly Bitbucket: its #N forms no link, so owner/repo#123 keeps linking on github.com.
    expect(defaultRefHost([{ repo_host: 'bitbucket.org' }, { repo_host: 'bitbucket.org' }, gl])).toBe('github.com');
  });
});

describe('ui hears it', () => {
  afterEach(() => {
    resetDefaultRefHost();
    resetCrossRepoRefsWithoutRepo();
  });

  test('a list read tells ui the host when it changes, and not again for the same list', () => {
    setCrossRepoRefsWithoutRepo(true);
    const list = [gl, gl, gh];
    learnDefaultRefHost(list);
    expect(getCrossRepoRefsWithoutRepo()).toEqual({ host: 'gitlab.example.com' });
    setCrossRepoRefsWithoutRepo(true);
    learnDefaultRefHost(list);
    expect(getCrossRepoRefsWithoutRepo()).toBe(true);
    learnDefaultRefHost([gh]);
    expect(getCrossRepoRefsWithoutRepo()).toEqual({ host: 'github.com' });
  });
});
