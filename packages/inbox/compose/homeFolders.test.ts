/**
 * "Another folder on <machine>…": which folder is read for a typed path, which of its names are offered, and when the
 * field names a folder one can start in. A wrong split reads the wrong folder (the suggestions under "~/code/bil"
 * would be home's), a wrong filter hides the folder being typed, and a Start row for home or an unread name would
 * start an agent somewhere the person never saw.
 */
import { describe, expect, test } from 'bun:test';
import { closestFirst, folderSuggestions, missingFolderLine, nameBelow, namedFolder, normalizeFolderPath, shownFolderPath, splitFolderPath } from './homeFolders';

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

test('a missing path points below only when folders are listed there', () => {
  expect(missingFolderLine('Mac mini', '~/code/x')).toBe('Mac mini has no folder ~/code/x. Check the path, or pick a folder below.');
  expect(missingFolderLine('Mac mini', '~/code/x', false)).toBe('Mac mini has no folder ~/code/x. Check the path.');
  expect(missingFolderLine(null, '~/code/x', false)).toBe("There's no folder ~/code/x. Check the path.");
});

test('the folders under the missing line: the one closest to what was typed first, ties in their order', () => {
  expect(closestFirst(['billing-api', 'billing-reports', 'billing-svc', 'infra'], 'biling-svc')).toEqual(['billing-svc', 'billing-api', 'billing-reports', 'infra']);
  expect(closestFirst(['code', 'notes'], 'NOTE')).toEqual(['notes', 'code']);
  // A shared start counts before length: "nope" is nearer notes-local than the shorter web-app.
  expect(closestFirst(['notes-local', 'web-app'], 'nope')).toEqual(['notes-local', 'web-app']);
  expect(closestFirst(['web-app', 'notes-local'], 'nope')).toEqual(['notes-local', 'web-app']);
  expect(closestFirst(['b', 'a'], '')).toEqual(['b', 'a']);
});

test('the name typed one level below the nearest folder that is there', () => {
  expect(nameBelow('~/cod/billing', '~')).toBe('cod');
  expect(nameBelow('~/code/nope/deeper', '~/code')).toBe('nope');
  expect(nameBelow('~/code', '~/other')).toBe('');
});
