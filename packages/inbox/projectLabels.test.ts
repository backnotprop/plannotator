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

// Rename… in the project menu: the person's name for a project is drawn as it is.
test('a renamed project reads its display_name as it is, and the others no longer clash with it', () => {
  const acme = { id: 'prj_acme', root: '/Users/me/code/acme/main', name: 'acme', display_name: 'acme' };
  const initech = { id: 'prj_initech', root: '/Users/me/code/initech/main', name: 'main · initech' };
  const names = shortProjectNames([acme, initech]);
  expect(names.get(acme.id)).toBe('acme');
  // Before the rename the two `main` folders named their parents; now the other one is alone.
  expect(names.get(initech.id)).toBe('main');
  expect(shortProjectNames([{ ...acme, display_name: undefined }, initech]).get(acme.id)).toBe('main · acme');
  // A name that is also another project's folder name gets no parent added.
  const notes = { id: 'prj_notes', root: '/Users/me/code/notes', name: 'notes' };
  const named = shortProjectNames([{ ...initech, display_name: 'notes' }, notes]);
  expect(named.get(initech.id)).toBe('notes');
  expect(named.get(notes.id)).toBe('notes');
});

test('a display_name that is not a non-empty string is ignored: the folder names the project', () => {
  const names = shortProjectNames([
    { id: 'a', root: '/code/acme/main', name: 'main', display_name: 42 },
    { id: 'b', root: '/code/notes', name: 'notes', display_name: '' },
  ]);
  expect(names.get('a')).toBe('main');
  expect(names.get('b')).toBe('notes');
});

test('the window-wide names (a pin outside the sidebar included) carry the display_name too', () => {
  const acme = { id: 'prj_acme', root: '/Users/me/code/acme/main', name: 'acme', display_name: 'acme' };
  const names = windowProjectNames({ projects: [acme], sidebar: [], sections: [], pins: [{ project: { id: acme.id } }] });
  expect(names.get(acme.id)).toBe('acme');
});

// The owner, 2026-11-02: the list's banner read "1 new in appnotes · Users/ramos/workspaces/projects". On disk,
// `~/workspaces/projects/appnotes` is a plain folder of notes and `appnotes/worktrees/main` the repository's main
// checkout; a session started in the folder made a folder project beside the repository's. Both name the place
// `…/projects/appnotes`, so no parent told them apart and the old rule climbed to the filesystem root.
const APPNOTES = '/Users/ramos/workspaces/projects/appnotes';
const FOLDER = { id: 'prj_folder', root: APPNOTES, name: 'appnotes' };
const MAIN = { id: 'prj_main', root: `${APPNOTES}/worktrees/main`, name: 'main' };

test("a plain folder and the checkout in its worktrees folder read as one place: the folder's bare name, the checkout's name added", () => {
  const names = shortProjectNames([FOLDER, MAIN]);
  expect(names.get(FOLDER.id)).toBe('appnotes');
  expect(names.get(MAIN.id)).toBe('appnotes · main');
  // A repository and its Claude Code agent worktree, both projects: the same rule.
  const agent = shortProjectNames([REPO, { id: 'prj_agent', root: `${REPO.root}/.claude/worktrees/agent-a4ef845a`, name: 'x' }]);
  expect([agent.get(REPO.id), agent.get('prj_agent')]).toEqual(['plannotator', 'plannotator · agent-a4ef845a']);
});

test('that place beside another of the name: one parent for the place, the checkout only where the place holds two', () => {
  const names = shortProjectNames([FOLDER, MAIN, { id: 'prj_ws', root: '/Users/ramos/workspaces/appnotes', name: 'appnotes' }]);
  expect(names.get(FOLDER.id)).toBe('appnotes · projects');
  expect(names.get(MAIN.id)).toBe('appnotes · projects · main');
  expect(names.get('prj_ws')).toBe('appnotes · workspaces');
  // The checkout alone at that place: no checkout name.
  expect(shortProjectNames([MAIN, { id: 'prj_ws', root: '/Users/ramos/workspaces/appnotes', name: 'appnotes' }]).get(MAIN.id)).toBe('appnotes · projects');
});

test('each project takes its own shortest parents, and never spells out a home folder', () => {
  const layouts = [
    [FOLDER, MAIN],
    [FOLDER, { id: 'x', root: '/Users/ramos/appnotes', name: 'appnotes' }],
    [FOLDER, { id: 'x', root: '/Users/ramos/projects/appnotes', name: 'appnotes' }, { id: 'y', root: '/Users/ramos/appnotes', name: 'appnotes' }],
    [FOLDER, { id: 'x', root: '/Users/ramos/.codex/worktrees/d4ed/appnotes', name: 'appnotes' }],
    [FOLDER, { id: 'x', root: '/Users/ramos/Workspaces/projects/appnotes', name: 'appnotes' }],
    [{ id: 'l', root: '/home/ramos/work/api', name: 'api' }, { id: 'm', root: '/home/ramos/api', name: 'api' }],
    [{ id: 'w', root: 'C:\\Users\\ramos\\src\\api', name: 'api' }, { id: 'v', root: 'C:\\Users\\ramos\\api', name: 'api' }],
  ];
  for (const projects of layouts) {
    for (const name of shortProjectNames(projects).values()) expect(name).not.toMatch(/Users|home\//i);
  }
  const three = shortProjectNames(layouts[2]!);
  expect([three.get(FOLDER.id), three.get('x'), three.get('y')]).toEqual(['appnotes · workspaces/projects', 'appnotes · ~/projects', 'appnotes · ~']);
  expect(shortProjectNames(layouts[6]!).get('v')).toBe('api · ~');
});

test('the same folder twice (as a person reads it) is one name, not a path to the root', () => {
  const names = shortProjectNames([FOLDER, { id: 'x', root: '/Users/ramos/Workspaces/projects/appnotes/', name: 'appnotes' }]);
  expect([names.get(FOLDER.id), names.get('x')]).toEqual(['appnotes', 'appnotes']);
});

test("a renamed project keeps its name; the folder's checkout then reads alone", () => {
  const names = shortProjectNames([{ ...FOLDER, display_name: 'appnotes notes' }, MAIN]);
  expect(names.get(FOLDER.id)).toBe('appnotes notes');
  expect(names.get(MAIN.id)).toBe('appnotes');
});
