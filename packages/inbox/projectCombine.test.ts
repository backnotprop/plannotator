/**
 * Which projects a typed name points at: the rename warning asks only for a
 * real match, and two clashing clones are still found by the name a person types.
 */
import { expect, test } from 'bun:test';
import { projectNameMatches, sameProjectName } from './projectCombine';

const DOCS = { id: 'prj_docs', root: '/code/docs', name: 'docs' };
const CODE = { id: 'prj_code', root: '/code/acme', name: 'acme · code' };
const SPACES = { id: 'prj_spaces', root: '/workspaces/acme/worktrees/main', name: 'acme · workspaces' };

const ids = (typed: string, others: readonly { id: string; root: string; name: string; display_name?: unknown }[]) => projectNameMatches(typed, others).map((p) => p.id);

test('two names are the same as a person reads them: case, Unicode form and spaces aside', () => {
  expect(sameProjectName('Docs', 'docs')).toBe(true);
  expect(sameProjectName('  my   docs ', 'my docs')).toBe(true);
  expect(sameProjectName('café', 'café')).toBe(true);
  expect(sameProjectName('docs', 'docs-site')).toBe(false);
});

test('a typed name matches the project that reads it, and only a whole name matches', () => {
  expect(ids('DOCS', [DOCS, CODE])).toEqual([DOCS.id]);
  expect(ids('doc', [DOCS, CODE])).toEqual([]);
  expect(ids('notes', [DOCS, CODE])).toEqual([]);
});

test('two clashing clones are found by their folder, a checkout by its repository', () => {
  expect(ids('acme', [DOCS, CODE, SPACES])).toEqual([CODE.id, SPACES.id]);
  expect(ids('acme · code', [DOCS, CODE, SPACES])).toEqual([CODE.id]);
});

test('a full name wins over a folder: the person meant the project that reads it', () => {
  const given = { id: 'prj_given', root: '/code/other', name: 'acme', display_name: 'acme' };
  expect(ids('acme', [CODE, given])).toEqual([given.id]);
});

test('a project the person renamed answers to that name, no longer to its folder', () => {
  const renamed = { id: 'prj_r', root: '/code/acme/main', name: 'platform', display_name: 'platform' };
  expect(ids('platform', [renamed])).toEqual([renamed.id]);
  expect(ids('main', [renamed])).toEqual([]);
});
