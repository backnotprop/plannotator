import { expect, test } from 'bun:test';
import { inboxProjectLabels } from '../packages/shared/inbox/project-name';
import { shortProjectNames } from '../packages/inbox/projectLabels';

type Project = { id: string; root: string; name: string; display_name?: string };
const p = (id: string, root: string, name = 'slug'): Project => ({ id, root, name });

const CASES: { what: string; projects: Project[]; names?: Record<string, string> }[] = [
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
  { what: 'worktrees in a home folder', projects: [p('a', '/Users/ramos/worktrees/foo'), p('b', '/home/ramos/worktrees/foo'), p('c', 'C:\\Users\\ramos\\.claude\\worktrees\\api')] },
  { what: 'a renamed project', projects: [{ ...p('a', '/x/docs'), display_name: 'docs' }, p('b', '/y/docs')], names: { a: 'docs', b: 'docs' } },
  { what: 'the same root twice: one folder, one name', projects: [p('a', '/w/api'), p('b', '/w/api')], names: { a: 'api', b: 'api' } },
  {
    what: "the owner's appnotes: a checkout in worktrees reads as its repository",
    projects: [p('a', '/Users/ramos/workspaces/projects/appnotes/worktrees/main'), p('b', '/Users/ramos/workspaces/projects/docs-site')],
    names: { a: 'appnotes', b: 'docs-site' },
  },
  {
    what: "the owner's appnotes: a plain folder and its main checkout",
    projects: [p('a', '/Users/ramos/workspaces/projects/appnotes'), p('b', '/Users/ramos/workspaces/projects/appnotes/worktrees/main')],
    names: { a: 'appnotes', b: 'appnotes · main' },
  },
  {
    what: 'each its own shortest parents, the home folder as ~',
    projects: [p('a', '/Users/ramos/workspaces/projects/appnotes'), p('b', '/Users/ramos/projects/appnotes'), p('c', '/Users/ramos/appnotes')],
    names: { a: 'appnotes · workspaces/projects', b: 'appnotes · ~/projects', c: 'appnotes · ~' },
  },
  { what: 'three checkouts of three repositories', projects: [p('a', '/w/appnotes/worktrees/main'), p('b', '/w/workspaces/worktrees/main'), p('c', '/w/workspaces-cli/.worktrees/main')], names: { a: 'appnotes', b: 'workspaces', c: 'workspaces-cli' } },
  { what: 'two repositories named alike', projects: [p('a', '/home/work/api/worktrees/main'), p('b', '/home/oss/api/worktrees/main')], names: { a: 'api · work', b: 'api · oss' } },
  { what: 'a checkout and a plain folder', projects: [p('a', 'C:\\src\\api\\worktrees\\main'), p('b', '/srv/api')], names: { a: 'api · src', b: 'api · srv' } },
  { what: "a dot-folder's worktrees", projects: [p('a', '/u/me/plannotator/.claude/worktrees/agent-1'), p('b', '/w/plannotator')], names: { a: 'plannotator · me', b: 'plannotator · w' } },
];

test('the window and the server name the same projects the same way', () => {
  for (const { what, projects, names } of CASES) {
    const server = Object.fromEntries(inboxProjectLabels(projects));
    const window = Object.fromEntries(shortProjectNames(projects));
    expect({ what, names: window }).toEqual({ what, names: server });
    if (names) expect({ what, names: server }).toEqual({ what, names });
  }
});
