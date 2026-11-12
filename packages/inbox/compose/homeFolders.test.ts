import { describe, expect, test } from 'bun:test';
import { closestFirst, folderSuggestions, nameBelow, normalizeFolderPath, splitFolderPath } from './homeFolders';

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

test('the folders under the missing line: the one closest to what was typed first, ties in their order', () => {
  expect(closestFirst(['billing-api', 'billing-reports', 'billing-svc', 'infra'], 'biling-svc')).toEqual(['billing-svc', 'billing-api', 'billing-reports', 'infra']);
  expect(closestFirst(['code', 'notes'], 'NOTE')).toEqual(['notes', 'code']);
  expect(closestFirst(['notes-local', 'web-app'], 'nope')).toEqual(['notes-local', 'web-app']);
  expect(closestFirst(['web-app', 'notes-local'], 'nope')).toEqual(['notes-local', 'web-app']);
  expect(closestFirst(['b', 'a'], '')).toEqual(['b', 'a']);
});

test('the name typed one level below the nearest folder that is there', () => {
  expect(nameBelow('~/cod/billing', '~')).toBe('cod');
  expect(nameBelow('~/code/nope/deeper', '~/code')).toBe('nope');
  expect(nameBelow('~/code', '~/other')).toBe('');
});
