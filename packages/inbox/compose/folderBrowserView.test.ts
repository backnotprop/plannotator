/**
 * Create a folder and Paste a path (approval "launch-create-clone", A1-A12, B1-B3): what the folder browser offers for
 * a typed path, from the folder listing's answers. Each case guards a rule the person relies on: a folder that is
 * there always leads (Enter never forces them deeper, except at home); a name that isn't there becomes Create, last
 * and quiet while a folder still starts with it; only the last folder can be made; a file, a folder that can't be
 * opened, one that can't be written, a hidden one or one outside home is said, never offered.
 */
import { describe, expect, test } from 'bun:test';
import { cleanPastedPath, cloneAt, folderBrowserView, looksLikePath, needsNameRead, type CloneTargetRead, type FolderRead } from './homeFolders';

const CODE: FolderRead = {
  exists: true,
  state: 'folder',
  folders: ['api-gateway', 'billing-svc', 'docs-site', 'experiments', 'locked', 'payments-api', 'side-project', 'web', 'web-app'],
  locked: ['locked'],
  writable: true,
};
const HOME: FolderRead = { exists: true, state: 'folder', folders: ['code', 'Documents', 'Downloads', 'work'], writable: true };
const missing: FolderRead = { exists: false, state: 'missing', folders: [] };
const kinds = (view: ReturnType<typeof folderBrowserView>) => view.rows.map((row) => `${row.kind}:${row.kind === 'fix' ? row.path : row.name}${row.kind === 'create' && row.quiet ? ' (quiet)' : ''}`);

describe('folderBrowserView', () => {
  test('A1: home lists its folders and never offers to start in home itself', () => {
    const view = folderBrowserView({ typed: '~/', read: HOME, nameRead: null });
    expect(view.note).toBeNull();
    expect(kinds(view)).toEqual(['folder:code', 'folder:Documents', 'folder:Downloads', 'folder:work']);
  });

  test('A2: a folder that is there leads, with or without the slash; its folders sit below', () => {
    const side: FolderRead = { exists: true, state: 'folder', folders: ['docs', 'src'], writable: true };
    expect(kinds(folderBrowserView({ typed: '~/code/side-project/', read: side, nameRead: null }))).toEqual(['start:side-project', 'folder:docs', 'folder:src']);
    expect(kinds(folderBrowserView({ typed: '~/code/side-project', read: CODE, nameRead: null }))[0]).toBe('start:side-project');
  });

  test('A3: a partial name: the matches first, Create last and quiet, so Enter still goes into the match', () => {
    expect(kinds(folderBrowserView({ typed: '~/code/ex', read: CODE, nameRead: missing }))).toEqual(['folder:experiments', 'create:ex (quiet)']);
    // web next to web-app (decision 5a): typing "web" starts in web; "we" offers both and a quiet Create.
    expect(kinds(folderBrowserView({ typed: '~/code/we', read: CODE, nameRead: missing }))).toEqual(['folder:web', 'folder:web-app', 'create:we (quiet)']);
  });

  test('A4: a missing folder: Create leads, the closest folders below it under one quiet line', () => {
    const view = folderBrowserView({ typed: '~/code/pricing-page', read: CODE, nameRead: missing });
    expect(kinds(view)).toEqual(['create:pricing-page', 'folder:payments-api', 'folder:billing-svc', 'folder:docs-site', 'folder:api-gateway']);
    expect(view.rows[0]).toEqual({ kind: 'create', name: 'pricing-page', path: '~/code/pricing-page', quiet: false });
    expect(view.after).toEqual({ at: 1, text: "A new, empty folder. Or pick one that's there:" });
  });

  test('no Create row until the name is known not to be a file', () => {
    expect(kinds(folderBrowserView({ typed: '~/code/pricing-page', read: CODE, nameRead: null }))).toEqual([]);
  });

  test('A5: a typo one level up is fixed in one Enter', () => {
    const view = folderBrowserView({ typed: '~/cdoe/pricing-page', read: { ...missing, nearest: { path: '~', folders: HOME.folders } }, nameRead: null });
    expect(view.note).toBe("There's no ~/cdoe.");
    expect(view.rows[0]).toEqual({ kind: 'fix', path: '~/code/pricing-page', name: 'code', from: 'cdoe' });
  });

  test('A6: two missing levels: only the last folder can be made, and the line says so', () => {
    const view = folderBrowserView({ typed: '~/code/new-client/site', read: { ...missing, nearest: { path: '~/code', folders: CODE.folders } }, nameRead: null });
    expect(view.note).toBe("There's no ~/code/new-client. Only the last folder in a path can be made.");
    expect(view.rows.every((row) => row.kind === 'folder')).toBe(true);
  });

  test('A7: a path to a file: its folder leads', () => {
    const webApp: FolderRead = { exists: true, state: 'folder', folders: ['packages', 'src'], writable: true };
    const view = folderBrowserView({ typed: '~/code/web-app/README.md', read: webApp, nameRead: { exists: false, state: 'file', folders: [] } });
    expect(view.note).toBe('README.md is a file.');
    expect(kinds(view)[0]).toBe('start:web-app');
  });

  test('A8: a name taken by a file: no Create row', () => {
    const view = folderBrowserView({ typed: '~/code/roadmap', read: CODE, nameRead: { exists: false, state: 'file', folders: [] } });
    expect(view.note).toBe("There's already a file named roadmap. Pick another name.");
    expect(view.rows.some((row) => row.kind === 'create' || row.kind === 'start')).toBe(false);
  });

  test('A9: a folder that can not be opened: dimmed in its parent, said when typed, never a lead', () => {
    expect(folderBrowserView({ typed: '~/code/', read: CODE, nameRead: null }).rows.find((row) => row.name === 'locked')?.kind).toBe('noaccess');
    const typed = folderBrowserView({ typed: '~/code/locked', read: CODE, nameRead: null });
    expect(typed.note).toBe("Can't open ~/code/locked: no permission.");
    expect(typed.rows.some((row) => row.kind === 'start')).toBe(false);
    expect(folderBrowserView({ typed: '~/code/locked/', read: { exists: false, state: 'locked', folders: [] }, nameRead: null }).note).toBe("Can't open ~/code/locked: no permission.");
  });

  test('A10: a folder that can not be written: no Create, its folders still there to pick', () => {
    const archive: FolderRead = { exists: true, state: 'folder', folders: ['2023', '2024'], writable: false };
    const view = folderBrowserView({ typed: '~/Documents/Archive/q3', read: archive, nameRead: missing });
    expect(view.note).toBe("Can't make a folder in ~/Documents/Archive: no permission.");
    expect(kinds(view)).toEqual(['folder:2023', 'folder:2024']);
  });

  test('A11: hidden or outside home: one line', () => {
    expect(folderBrowserView({ typed: '~/.config/x', read: null, nameRead: null }).note).toBe("Hidden folders aren't offered.");
    expect(folderBrowserView({ typed: '/etc', read: null, nameRead: null }).note).toBe('Only folders inside your home folder.');
  });

  test('A12: one Backspace back to a folder that is there: Create goes, Start comes back', () => {
    expect(kinds(folderBrowserView({ typed: '~/code/side-projectx', read: CODE, nameRead: missing }))[0]).toBe('create:side-projectx');
    expect(kinds(folderBrowserView({ typed: '~/code/side-project', read: CODE, nameRead: null }))[0]).toBe('start:side-project');
  });

  test('a name with \\ or : is never offered as a new folder', () => {
    expect(folderBrowserView({ typed: '~/code/a:b', read: CODE, nameRead: missing }).note).toBe("A folder name can't have \\ or :.");
  });

  test('a path under a file or a locked folder says what stops it', () => {
    expect(folderBrowserView({ typed: '~/code/notes.md/x/', read: { ...missing, blocked: { path: '~/code/notes.md', state: 'file' } }, nameRead: null }).note).toBe('~/code/notes.md is a file.');
  });

  test('the full path is read only for a name that is none of the folders read', () => {
    expect(needsNameRead(CODE, 'pricing-page')).toBe(true);
    expect(needsNameRead(CODE, 'web')).toBe(false);
    expect(needsNameRead(CODE, '')).toBe(false);
    expect(needsNameRead(missing, 'x')).toBe(false);
  });
});

describe('cleanPastedPath', () => {
  test('B1: a full path in home reads as ~/…', () => {
    expect(cleanPastedPath('/Users/ramos/code/web-app', '/Users/ramos')).toBe('~/code/web-app');
    expect(cleanPastedPath('/Users/ramos', '/Users/ramos')).toBe('~/');
  });
  test('B2: ~ and a trailing slash stay as typed', () => {
    expect(cleanPastedPath('~/code/web-app/', '/Users/ramos')).toBe('~/code/web-app/');
  });
  test('B3: Terminal escapes, quotes, a file:// URL and a line break', () => {
    expect(cleanPastedPath('~/Documents/Client\\ Work', null)).toBe('~/Documents/Client Work');
    expect(cleanPastedPath('"/Users/ramos/Documents/Client Work"', '/Users/ramos')).toBe('~/Documents/Client Work');
    expect(cleanPastedPath("'~/code/x'\n", null)).toBe('~/code/x');
    expect(cleanPastedPath('file:///Users/ramos/Documents/Client%20Work/', '/Users/ramos')).toBe('~/Documents/Client Work/');
    expect(cleanPastedPath('~/code/Foo\\(1\\)', null)).toBe('~/code/Foo(1)');
  });
  test('a paste is unescaped once: the filter reading it again keeps the backslash the paste left', () => {
    const pasted = cleanPastedPath('~/a\\\\b', null);
    expect(pasted).toBe('~/a\\b');
    expect(cleanPastedPath(pasted, null, { unescape: false })).toBe('~/a\\b');
  });
  test('B4: what reads as a path, not words', () => {
    expect(looksLikePath('~/code/web')).toBe(true);
    expect(looksLikePath('/Users/x')).toBe(true);
    expect(looksLikePath('"/Users/x y"')).toBe(true);
    expect(looksLikePath('web app')).toBe(false);
    expect(looksLikePath('acme/billing-api')).toBe(false);
  });
});

describe('folderBrowserView, cloning into another folder', () => {
  const target = (into: string, over: Partial<CloneTargetRead> = {}): CloneTargetRead => ({ into, path: `${into}/billing-api`, name: 'billing-api', state: 'clone', taken: null, writable: true, ...over });
  const cloneKinds = (view: ReturnType<typeof folderBrowserView>) => view.rows.map((row) => `${row.kind}:${row.kind === 'cloneHere' || row.kind === 'cloneStart' ? row.path : row.name}${'quiet' in row && row.quiet ? ' (quiet)' : ''}`);

  test('C14, C15: a folder that is there leads as Clone here; its folders sit quiet below, so Enter never goes deeper', () => {
    expect(cloneKinds(folderBrowserView({ typed: '~/code/', read: CODE, nameRead: null, clone: { repo: 'billing-api', target: target('~/code') } }))[0]).toBe('cloneHere:~/code/billing-api');
    const web: FolderRead = { exists: true, state: 'folder', folders: ['docs', 'src'], writable: true };
    expect(cloneKinds(folderBrowserView({ typed: '~/code/web/', read: web, nameRead: null, clone: { repo: 'billing-api', target: target('~/code/web') } }))).toEqual(['cloneHere:~/code/web/billing-api', 'folder:docs', 'folder:src']);
    // Without the slash, the same lead (the folder named is where the clone goes).
    expect(cloneAt('~/code/web', CODE, null)).toBe('~/code/web');
    // A target for another folder (an older answer) offers nothing until the right one comes.
    expect(cloneKinds(folderBrowserView({ typed: '~/code/web/', read: web, nameRead: null, clone: { repo: 'billing-api', target: target('~/code') } }))).toEqual(['folder:docs', 'folder:src']);
  });

  test('home is allowed when cloning; the same repo there already starts in it (C9); a taken name keeps -2 (C10)', () => {
    expect(cloneAt('~/', HOME, null)).toBe('~');
    expect(cloneKinds(folderBrowserView({ typed: '~/', read: HOME, nameRead: null, clone: { repo: 'billing-api', target: target('~') } }))[0]).toBe('cloneHere:~/billing-api');
    expect(cloneKinds(folderBrowserView({ typed: '~/code/', read: CODE, nameRead: null, clone: { repo: 'api-gateway', target: target('~/code', { state: 'already', path: '~/code/api-gateway', name: 'api-gateway' }) } }))[0]).toBe('cloneStart:~/code/api-gateway');
    const web2 = folderBrowserView({ typed: '~/code/', read: CODE, nameRead: null, clone: { repo: 'web', target: target('~/code', { path: '~/code/web-2', name: 'web-2', taken: '~/code/web' }) } });
    expect(web2.rows[0]).toEqual({ kind: 'cloneHere', path: '~/code/web-2', name: 'web-2', repo: 'web', taken: '~/code/web' });
  });

  test('C15b: a new name is the clone\'s own folder, last and quiet while a folder still matches', () => {
    expect(cloneKinds(folderBrowserView({ typed: '~/code/invoices', read: CODE, nameRead: missing, clone: { repo: 'billing-api', target: null } }))[0]).toBe('cloneInto:invoices');
    expect(cloneKinds(folderBrowserView({ typed: '~/code/bil', read: CODE, nameRead: missing, clone: { repo: 'billing-api', target: null } }))).toEqual(['folder:billing-svc', 'cloneInto:bil (quiet)']);
    expect(cloneAt('~/code/invoices', CODE, missing)).toBeNull();
  });

  test('C15c: a folder that can\'t be written says so, and its folders are still there to go into', () => {
    const archive: FolderRead = { exists: true, state: 'folder', folders: ['2019', '2020'], writable: false };
    const view = folderBrowserView({ typed: '~/Documents/Archive/', read: archive, nameRead: null, clone: { repo: 'billing-api', target: target('~/Documents/Archive', { writable: false }) } });
    expect(view.note).toBe("Can't clone into ~/Documents/Archive: no permission.");
    expect(cloneKinds(view)).toEqual(['folder:2019', 'folder:2020']);
    expect(folderBrowserView({ typed: '~/Documents/Archive/new', read: archive, nameRead: missing, clone: { repo: 'billing-api', target: null } }).note).toBe("Can't clone into ~/Documents/Archive: no permission.");
  });
});
