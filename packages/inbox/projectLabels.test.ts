/**
 * The window's project names (owner's pick, 2026-10-29): the folder's name,
 * with the parent only when two projects on screen share it. The server's
 * name weighs every stored project, so a clash with a project no longer listed
 * (an old worktree) must not lengthen the name here.
 */
import { expect, test } from 'bun:test';
import { shortProjectNames, windowProjectNames } from './projectLabels';

const REPO = { id: 'prj_repo', root: '/Users/me/plannotator/plannotator', name: 'plannotator · plannotator' };
const WORKTREE = { id: 'prj_wt', root: '/Users/me/old/plannotator', name: 'plannotator · old' };
const API_WORK = { id: 'prj_w', root: '/work/api', name: 'api · work' };
const API_HOME = { id: 'prj_h', root: '/personal/api', name: 'api · personal' };

test('a project whose folder name no other listed project shares reads just the folder name', () => {
  const names = shortProjectNames([REPO, API_WORK]);
  expect(names.get(REPO.id)).toBe('plannotator');
  expect(names.get(API_WORK.id)).toBe('api');
});

test('two listed projects with the same folder name each add their parent, as many parents as tell them apart', () => {
  const names = shortProjectNames([REPO, WORKTREE, API_WORK, API_HOME]);
  expect(names.get(REPO.id)).toBe('plannotator · plannotator');
  expect(names.get(WORKTREE.id)).toBe('plannotator · old');
  expect(names.get(API_WORK.id)).toBe('api · work');
  expect(names.get(API_HOME.id)).toBe('api · personal');
  // Same parent too: one more level, compared as a person reads names (case, Unicode form).
  const deep = shortProjectNames([
    { id: 'a', root: '/a/src/web', name: 'web' },
    { id: 'b', root: '/b/SRC/Web', name: 'web' },
  ]);
  expect(deep.get('a')).toBe('web · a/src');
  expect(deep.get('b')).toBe('Web · b/SRC');
});

test('a clash only with a stored project neither the sidebar nor the list draws leaves the folder name alone', () => {
  const sections = [{ threads: [{ project: { id: REPO.id } }, { project: { id: API_WORK.id } }] }];
  // WORKTREE is stored (the list model knows it) but is neither in the sidebar nor in a row.
  const names = windowProjectNames({ projects: [REPO, WORKTREE, API_WORK], sidebar: [REPO, API_WORK], sections });
  expect(names.get(REPO.id)).toBe('plannotator');
  expect(names.has(WORKTREE.id)).toBe(false);
});

test('the sidebar and the held list name together: a project in only one of them still makes the clash', () => {
  // The held list still shows WORKTREE's row (archived while a thread is open); the sidebar has dropped it.
  const held = windowProjectNames({ projects: [REPO, WORKTREE], sidebar: [REPO], sections: [{ threads: [{ project: { id: REPO.id } }, { project: { id: WORKTREE.id } }] }] });
  expect(held.get(REPO.id)).toBe('plannotator · plannotator');
  // A project new in the sidebar whose row the held list does not show yet.
  const fresh = windowProjectNames({ projects: [REPO, WORKTREE], sidebar: [REPO, WORKTREE], sections: [{ threads: [{ project: { id: REPO.id } }] }] });
  expect(fresh.get(REPO.id)).toBe('plannotator · plannotator');
});

test("a pin's project the window does not otherwise draw is named against the drawn ones, without renaming them", () => {
  const names = windowProjectNames({ projects: [REPO, WORKTREE], sidebar: [REPO], sections: [], pins: [{ project: { id: WORKTREE.id } }] });
  expect(names.get(REPO.id)).toBe('plannotator');
  expect(names.get(WORKTREE.id)).toBe('plannotator · old');
});

test('a project at a POSIX filesystem root (`/`, no folder name) keeps the name it came with', () => {
  expect(shortProjectNames([{ id: 'r', root: '/', name: 'root' }]).get('r')).toBe('root');
});

// Owner's pick, 2026-10-29 (variant of B): a Workspaces checkout (`<repo>/worktrees/<branch>`) reads as its
// repository; "worktrees" and the branch folder leave the name, and the parents a clash adds skip them.
const checkout = (id: string, repo: string, under = '/Users/me/workspaces/projects', branch = 'main') => ({ id, root: `${under}/${repo}/worktrees/${branch}`, name: 'main · x' });

test('a lone checkout in a worktrees folder reads as its repository', () => {
  expect(shortProjectNames([checkout('a', 'appnotes'), API_WORK]).get('a')).toBe('appnotes');
  expect(shortProjectNames([{ id: 'd', root: '/src/tool/.worktrees/fix-login', name: 'x' }]).get('d')).toBe('tool');
});

test('three checkouts of three repositories read as their three repositories, no parent', () => {
  const names = shortProjectNames([checkout('a', 'appnotes'), checkout('w', 'workspaces'), checkout('c', 'workspaces-cli')]);
  expect([names.get('a'), names.get('w'), names.get('c')]).toEqual(['appnotes', 'workspaces', 'workspaces-cli']);
});

test('checkouts of two repositories with the same name clash and add the parent above the repository', () => {
  const names = shortProjectNames([checkout('a', 'appnotes', '/home/me/work'), checkout('b', 'appnotes', '/home/me/oss')]);
  expect(names.get('a')).toBe('appnotes · work');
  expect(names.get('b')).toBe('appnotes · oss');
  // A checkout and a plain folder of the same name: the same rule, never "worktrees" in the parents.
  const mixed = shortProjectNames([checkout('a', 'api', '/work'), { id: 'p', root: '/personal/api', name: 'api' }]);
  expect(mixed.get('a')).toBe('api · work');
  expect(mixed.get('p')).toBe('api · personal');
});

test('two checkouts of one repository are told apart by the checkout', () => {
  const names = shortProjectNames([checkout('m', 'appnotes'), checkout('f', 'appnotes', undefined, 'fix')]);
  expect(names.get('m')).toBe('appnotes · main');
  expect(names.get('f')).toBe('appnotes · fix');
});

test('a folder that is not in a worktrees folder is unchanged, a folder named worktrees included', () => {
  const names = shortProjectNames([
    { id: 'n', root: '/Users/me/src/main', name: 'main' },
    { id: 'w', root: '/Users/me/worktrees', name: 'worktrees' },
    { id: 's', root: '/worktrees/main', name: 'main2' },
  ]);
  expect(names.get('n')).toBe('main · src');
  expect(names.get('w')).toBe('worktrees');
  // Nothing above `worktrees` to name it by: the folder's own name, as before.
  expect(names.get('s')).toBe('main · worktrees');
});

test("a checkout in a dot-folder's worktrees (Claude Code's agent worktrees) reads as the repository above the dot-folder", () => {
  const names = shortProjectNames([
    { id: 'c', root: '/Users/me/plannotator/plannotator/.claude/worktrees/agent-a4ef845a', name: 'x' },
    { id: 'd', root: '/src/tool/.cache/.tools/worktrees/fix', name: 'x' },
  ]);
  expect(names.get('c')).toBe('plannotator');
  expect(names.get('d')).toBe('tool');
});

test('a worktrees folder right in a home folder (or with only dot-folders up to it) is an ordinary folder, never named for the person', () => {
  const names = shortProjectNames([
    { id: 'mac', root: '/Users/ramos/worktrees/foo', name: 'x' },
    { id: 'linux', root: '/home/ramos/worktrees/bar', name: 'x' },
    { id: 'win', root: 'C:\\Users\\ramos\\worktrees\\baz', name: 'x' },
    { id: 'dot', root: '/Users/ramos/.claude/worktrees/qux', name: 'x' },
    { id: 'top', root: '/.hidden/worktrees/quux', name: 'x' },
  ]);
  expect(['mac', 'linux', 'win', 'dot', 'top'].map((id) => names.get(id))).toEqual(['foo', 'bar', 'baz', 'qux', 'quux']);
});
