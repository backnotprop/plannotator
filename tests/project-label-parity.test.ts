/**
 * The window's project names (`shortProjectNames`, packages/inbox/projectLabels.ts)
 * apply the server's clash rule (`inboxProjectLabels`, packages/shared/inbox/project-name.ts)
 * to the projects on screen. packages/inbox cannot import shared, so the rule is
 * in both places; given the same projects, the two must name them the same, or
 * the window and the agents would disagree on a name for no reason the person
 * chose. A change to one copy that misses the other fails here.
 *
 * The chosen differences: the window names a checkout in a `worktrees` folder
 * by its repository (`labelPath`, owner's pick, 2026-10-29), and for those it
 * must equal the server's rule over the repository's path. And (the owner,
 * 2026-11-02: "appnotes · Users/ramos/workspaces/projects" in the list's
 * banner "looks bugged out") the window never climbs to the filesystem root
 * where parents cannot tell projects apart: projects at one place (the same
 * folder, a plain folder and the checkouts in its `worktrees`) are told apart
 * by the checkout alone, each project takes its own shortest parents, and a
 * home folder in them reads "~" (`WINDOW_ONLY` below).
 */
import { expect, test } from 'bun:test';
import { inboxProjectLabels } from '../packages/shared/inbox/project-name';
import { labelPath, shortProjectNames } from '../packages/inbox/projectLabels';

type Project = { id: string; root: string; name: string };
const p = (id: string, root: string, name = 'slug'): Project => ({ id, root, name });

const CASES: { what: string; projects: Project[] }[] = [
  { what: 'no clash', projects: [p('a', '/work/api'), p('b', '/work/web')] },
  { what: 'a clash one parent tells apart', projects: [p('a', '/work/api'), p('b', '/home/api')] },
  { what: 'case differs', projects: [p('a', '/x/Web'), p('b', '/y/web')] },
  { what: 'Unicode form differs (NFD vs NFC)', projects: [p('a', '/x/cafe\u0301'), p('b', '/y/caf\u00e9')] },
  { what: 'Windows drive letters', projects: [p('a', 'C:\\work\\api'), p('b', 'D:\\work\\api')] },
  { what: 'backslashes and slashes mixed', projects: [p('a', 'C:\\Users\\me\\api'), p('b', '/Users/me/api')] },
  { what: 'network paths', projects: [p('a', '\\\\server\\share\\api'), p('b', '\\\\other\\share\\api')] },
  { what: 'nested clash (same parent too)', projects: [p('a', '/x/work/api'), p('b', '/y/work/api'), p('c', '/home/api')] },
  { what: 'one project at the shallower depth', projects: [p('a', '/api'), p('b', '/work/api')] },
  { what: 'missing root (a filesystem root)', projects: [p('a', '/', 'root-slug'), p('b', '/work/api')] },
  { what: 'a drive root', projects: [p('a', 'C:\\', 'drive-slug'), p('b', '/x/C:')] },
  { what: 'trailing slashes', projects: [p('a', '/work/api/'), p('b', '/home/api//')] },
  { what: 'empty root', projects: [p('a', '', 'empty-slug')] },
  // A worktrees folder in a home folder is an ordinary folder for the window: the server's names.
  { what: 'worktrees in a home folder', projects: [p('a', '/Users/ramos/worktrees/foo'), p('b', '/home/ramos/worktrees/foo'), p('c', 'C:\\Users\\ramos\\.claude\\worktrees\\api')] },
];

test('the window and the server name the same projects the same way', () => {
  for (const { what, projects } of CASES) {
    const server = Object.fromEntries(inboxProjectLabels(projects));
    const window = Object.fromEntries(shortProjectNames(projects));
    expect({ what, names: window }).toEqual({ what, names: server });
  }
});

const WORKTREE_CASES: { what: string; projects: Project[] }[] = [
  { what: 'three checkouts of three repositories', projects: [p('a', '/w/appnotes/worktrees/main'), p('b', '/w/workspaces/worktrees/main'), p('c', '/w/workspaces-cli/.worktrees/main')] },
  { what: 'two repositories named alike', projects: [p('a', '/home/work/api/worktrees/main'), p('b', '/home/oss/api/worktrees/main')] },
  { what: 'a checkout and a plain folder', projects: [p('a', 'C:\\src\\api\\worktrees\\main'), p('b', '/srv/api')] },
  { what: 'nested clash', projects: [p('a', '/x/work/api/worktrees/main'), p('b', '/y/work/api/worktrees/dev'), p('c', '/home/api')] },
  { what: "a dot-folder's worktrees", projects: [p('a', '/u/me/plannotator/.claude/worktrees/agent-1'), p('b', '/w/plannotator')] },
];

test('a checkout in a worktrees folder is named as the server would name its repository', () => {
  for (const { what, projects } of WORKTREE_CASES) {
    const repos = projects.map((project) => ({ ...project, root: labelPath(project.root).parts.join('/') }));
    expect({ what, names: Object.fromEntries(shortProjectNames(projects)) }).toEqual({ what, names: Object.fromEntries(inboxProjectLabels(repos)) });
  }
});

const WINDOW_ONLY: { what: string; projects: Project[]; window: Record<string, string>; server: Record<string, string> }[] = [
  {
    what: 'the same root twice: one folder, one name',
    projects: [p('a', '/w/api'), p('b', '/w/api')],
    window: { a: 'api', b: 'api' },
    server: { a: 'api · w', b: 'api · w' },
  },
  {
    what: "the owner's appnotes: a plain folder and its main checkout",
    projects: [p('a', '/Users/ramos/workspaces/projects/appnotes'), p('b', '/Users/ramos/workspaces/projects/appnotes/worktrees/main')],
    window: { a: 'appnotes', b: 'appnotes · main' },
    server: { a: 'appnotes', b: 'main' },
  },
  {
    what: 'one project needs two parents, another one: each its own, the home folder as ~',
    projects: [p('a', '/Users/ramos/workspaces/projects/appnotes'), p('b', '/Users/ramos/projects/appnotes'), p('c', '/Users/ramos/appnotes')],
    window: { a: 'appnotes · workspaces/projects', b: 'appnotes · ~/projects', c: 'appnotes · ~' },
    server: { a: 'appnotes · workspaces/projects', b: 'appnotes · ramos/projects', c: 'appnotes · Users/ramos' },
  },
];

test('where the window chose to differ, it differs only there', () => {
  for (const { what, projects, window, server } of WINDOW_ONLY) {
    expect({ what, names: Object.fromEntries(shortProjectNames(projects)) }).toEqual({ what, names: window });
    expect({ what, names: Object.fromEntries(inboxProjectLabels(projects)) }).toEqual({ what, names: server });
  }
});
