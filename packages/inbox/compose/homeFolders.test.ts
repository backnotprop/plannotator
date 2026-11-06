/**
 * "Another folder on <machine>…": which folder is read for a typed path, which of its names are offered, and when the
 * field names a folder one can start in. A wrong split reads the wrong folder (the suggestions under "~/code/bil"
 * would be home's), a wrong filter hides the folder being typed, and a Start row for home or an unread name would
 * start an agent somewhere the person never saw.
 */
import { describe, expect, test } from 'bun:test';
import { folderSuggestions, namedFolder, normalizeFolderPath, shownFolderPath, splitFolderPath } from './homeFolders';

describe('splitFolderPath', () => {
  test('the parent is read, the tail filters', () => {
    expect(splitFolderPath('~/code/bil')).toEqual({ parent: '~/code', tail: 'bil' });
    expect(splitFolderPath('~/code/billing-api/')).toEqual({ parent: '~/code/billing-api', tail: '' });
    expect(splitFolderPath('~/co')).toEqual({ parent: '~', tail: 'co' });
  });
  test('home, empty, a bare name and a doubled slash', () => {
    expect(splitFolderPath('~/')).toEqual({ parent: '~', tail: '' });
    expect(splitFolderPath('~')).toEqual({ parent: '~', tail: '' });
    expect(splitFolderPath('   ')).toEqual({ parent: '~', tail: '' });
    expect(splitFolderPath('code/x')).toEqual({ parent: '~/code', tail: 'x' });
    expect(splitFolderPath('~/code//')).toEqual({ parent: '~/code', tail: '' });
  });
  test('a full path is read as typed (the server keeps it inside home)', () => {
    expect(splitFolderPath('/Users/me/code/bil')).toEqual({ parent: '/Users/me/code', tail: 'bil' });
    expect(normalizeFolderPath('/Users/me')).toBe('/Users/me');
  });
});

describe('folderSuggestions', () => {
  const names = ['Billing-Reports', 'billing-api', 'docs', 'ledger'];
  test('starts with the tail, case aside, in the order read', () => {
    expect(folderSuggestions(names, 'bil')).toEqual(['Billing-Reports', 'billing-api']);
    expect(folderSuggestions(names, 'BILLING-a')).toEqual(['billing-api']);
  });
  test('a tail inside a name is not a match; no tail is every name', () => {
    expect(folderSuggestions(names, 'ger')).toEqual([]);
    expect(folderSuggestions(names, '')).toEqual(names);
  });
});

describe('namedFolder', () => {
  test('a folder read with nothing after its slash', () => {
    expect(namedFolder({ parent: '~/code/billing-api', exists: true, folders: [] }, '')).toBe('~/code/billing-api');
  });
  test('a name read that the tail spells exactly (not a prefix, not another case)', () => {
    const read = { parent: '~/code', exists: true, folders: ['billing-api', 'billing-reports'] };
    expect(namedFolder(read, 'billing-api')).toBe('~/code/billing-api');
    expect(namedFolder(read, 'billing')).toBeNull();
    expect(namedFolder(read, 'Billing-api')).toBeNull();
  });
  test('never home itself, never a path that is not there', () => {
    expect(namedFolder({ parent: '~', exists: true, folders: ['code'] }, '')).toBeNull();
    expect(namedFolder({ parent: '~/cod', exists: false, folders: [] }, '')).toBeNull();
  });
});

test('the missing line names the path as typed, without its last slash', () => {
  expect(shownFolderPath('~/code/biling-svc/')).toBe('~/code/biling-svc');
  expect(shownFolderPath('~/')).toBe('~/');
});
