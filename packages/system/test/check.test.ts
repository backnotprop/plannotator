import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FILE_BYTES } from '../src/format/keys.ts';
import { loadFiles } from '../src/index.ts';
import { check, load, loadCommitted, readCommitted } from '../src/node/index.ts';
import { drawingDir, edited, git, isolateGitConfig, repoRoot, revisionOfSize, smallDrawing, tempDir, writeTree } from './helpers.ts';

isolateGitConfig();
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
const temp = () => {
  const t = tempDir();
  cleanups.push(t.done);
  return t.dir;
};
const commit = (root: string, msg = 'step') => {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', msg);
  return git(root, 'rev-parse', 'HEAD').trim();
};

/** A git repo with the small drawing in its working tree (not committed) and its cited files committed. */
function smallRepo(code: Record<string, string> = { 'src/main.ts': '', 'src/api/index.ts': '' }) {
  const root = temp();
  git(root, 'init', '-q');
  writeTree(root, code);
  const sha = commit(root, 'code');
  const dir = join(root, '.plannotator', 'system');
  writeTree(dir, smallDrawing());
  return { root, dir, sha };
}

describe('check', () => {
  // CI checks out one commit, so the drawing's own `at` is not there: check at HEAD.
  test('the committed drawing is clean against this repo at HEAD', async () => {
    expect(await check({ dir: drawingDir, root: repoRoot, at: 'HEAD' })).toEqual({ errors: [], warnings: [], missing: [] });
  });

  test('a band whose written spans pass 12 columns is a warning naming the sheet and band; 12 is clean', async () => {
    const r = smallRepo();
    writeTree(r.dir, { 'sheets/L-101.yaml': 'sheet: L-101\nscope: app\nkind: logical\ntitle: The app\nbands:\n  - { id: inside, row: [api 4, ~ 8] }\n  - { id: more, row: [~ 6, [api, 10]] }\n' });
    const over = await check({ dir: r.dir, root: r.root, at: r.sha });
    expect(over.errors).toEqual([]);
    expect(over.warnings).toEqual([{ file: 'sheets/L-101.yaml', field: 'bands[1].row', message: 'the spans add up to 16 columns; a band holds at most 12' }]);
  });

  test('the committed drawing is clean at its own commit, when this clone has it', async () => {
    const { model } = await load(drawingDir);
    const at = model!.sources!.repos.self!.at;
    const has = (() => {
      try {
        git(repoRoot, 'cat-file', '-e', `${at}^{commit}`);
        return true;
      } catch {
        return false;
      }
    })();
    const result = await check({ dir: drawingDir, root: repoRoot });
    if (has) expect(result).toEqual({ errors: [], warnings: [], missing: [] });
    else expect(result.errors.map((e) => e.field)).toEqual(['sources.repos.self.at']);
  });

  test('a cited file is looked up at the commit, not in the working tree', async () => {
    const { root, dir, sha } = smallRepo();
    expect(await check({ dir, root, at: sha })).toEqual({ errors: [], warnings: [], missing: [] });
    git(root, 'rm', '-q', 'src/main.ts');
    const later = commit(root);
    // the working tree no longer has it, but the drawing was checked at sha
    expect((await check({ dir, root, at: sha })).missing).toEqual([]);
    expect((await check({ dir, root, at: later })).missing).toEqual(['src/main.ts']);
  });

  test("with no --at, the drawing's own sources.repos.self.at is used", async () => {
    const { root, dir, sha } = smallRepo();
    writeTree(dir, { 'system.yaml': smallDrawing()['system.yaml']!.replace('at: 1a2b3c4', `at: ${sha}`) });
    expect(await check({ dir, root })).toEqual({ errors: [], warnings: [], missing: [] });
    writeTree(dir, { 'system.yaml': smallDrawing()['system.yaml']!.replace('at: 1a2b3c4', 'at: abcdef0') });
    const r = await check({ dir, root });
    expect(r.errors).toEqual([
      { file: 'system.yaml', field: 'sources.repos.self.at', message: `abcdef0 is not a commit in ${root}; fetch it, or check at another commit (--at)` },
    ]);
  });

  test('an untracked or ignored file does not count', async () => {
    const { root, dir, sha } = smallRepo({ 'src/api/index.ts': '', '.gitignore': 'src/main.ts\n' });
    writeTree(root, { 'src/main.ts': 'built' });
    expect((await check({ dir, root, at: sha })).missing).toEqual(['src/main.ts']);
  });

  test('a committed symlink is an error, and a path through a symlinked folder is missing', async () => {
    const { root, dir } = smallRepo({ 'src/api/index.ts': '' });
    symlinkSync('/etc/hosts', join(root, 'src', 'main.ts'));
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'elsewhere', 'index.ts'), '');
    git(root, 'rm', '-q', '-r', 'src/api');
    symlinkSync(join(root, 'elsewhere'), join(root, 'src', 'api'));
    const sha = commit(root);
    const r = await check({ dir, root, at: sha });
    expect(r.errors).toEqual([
      { file: 'system.yaml', field: 'parts.app.code', message: 'src/main.ts is a symlink; cite the file it points to' },
      { file: 'system.yaml', field: 'parts.api.code', message: 'src/api is a symlink; cite the file it points to' },
    ]);
    // the line cites src/api/index.ts, which is not in the tree at all
    expect(r.missing).toEqual(['src/api/index.ts']);
  });

  test('a renamed cited file is missing, by its path', async () => {
    const { root, dir } = smallRepo();
    git(root, 'mv', 'src/main.ts', 'src/entry.ts');
    expect((await check({ dir, root, at: commit(root) })).missing).toEqual(['src/main.ts']);
  });

  test('a cited path in the wrong case is missing, on a case-blind disk too', async () => {
    const { root, dir, sha } = smallRepo({ 'src/Main.ts': '', 'src/api/index.ts': '' });
    expect((await check({ dir, root, at: sha })).missing).toEqual(['src/main.ts']);
  });

  test('a project in a folder of a bigger repo looks its paths up under that folder', async () => {
    const top = temp();
    git(top, 'init', '-q');
    writeTree(top, { 'src/main.ts': '', 'app/src/api/index.ts': '' });
    const sha = commit(top);
    const root = join(top, 'app');
    const dir = join(root, '.plannotator', 'system');
    writeTree(dir, smallDrawing());
    // src/main.ts is at the top of the repo, not in app/: it is missing
    expect((await check({ dir, root, at: sha })).missing).toEqual(['src/main.ts']);
  });

  test('outside git, the disk is read, with the same case and symlink rules', async () => {
    const root = temp();
    const dir = join(root, '.plannotator', 'system');
    writeTree(dir, smallDrawing());
    writeTree(root, { 'src/Main.ts': '', 'real/index.ts': '' });
    mkdirSync(join(root, 'src', 'api'));
    symlinkSync(join(root, 'real', 'index.ts'), join(root, 'src', 'api', 'index.ts'));
    const r = await check({ dir, root });
    expect(r.missing).toEqual(['src/main.ts']);
    expect(r.errors).toEqual([{ file: 'system.yaml', field: 'flows.use.code', message: 'src/api/index.ts is a symlink; cite the file it points to' }]);
  });

  test('a folder with no drawing is an error, not a clean check', async () => {
    const root = temp();
    const dir = join(root, '.plannotator', 'system');
    expect((await check({ dir, root })).errors).toEqual([{ file: 'system.yaml', field: '', message: `no drawing in ${dir}` }]);
  });
});

describe('load from disk', () => {
  test('a symlinked drawing file is an error naming it, not a missing file', async () => {
    const root = temp();
    const dir = join(root, 'drawing');
    writeTree(root, { 'real.yaml': smallDrawing()['system.yaml']! });
    writeTree(dir, { 'sheets/C-001.yaml': smallDrawing()['sheets/C-001.yaml']! });
    symlinkSync(join(root, 'real.yaml'), join(dir, 'system.yaml'));
    const r = await load(dir);
    expect(r.model).toBeNull();
    expect(r.errors).toEqual([{ file: 'system.yaml', field: '', message: 'is a symlink; a drawing file is a plain file in the drawing folder' }]);
  });

  test('a file that is not UTF-8 is an error, and the rest still loads', async () => {
    const root = temp();
    const files = edited('system.yaml', (t) => `${t}wanted:\n  - { code: F-101, kind: flow, question: x }\n`);
    writeTree(root, { ...files, 'sheets/F-101.yaml': new Uint8Array([0x73, 0x68, 0xff, 0xfe, 0x0a]) });
    const r = await load(root);
    expect(r.errors).toEqual([{ file: 'sheets/F-101.yaml', field: '', message: 'is not UTF-8 text' }]);
    expect(Object.keys(r.model!.sheets).sort()).toEqual(['C-001', 'L-101']);
  });

  test('a file over the size cap is not read', async () => {
    const root = temp();
    const big = `revision: PR-1\ntitle: "${'x'.repeat(1024 * 1024)}"\n`;
    writeTree(root, { ...smallDrawing(), 'revisions/PR-1.yaml': big });
    const r = await load(root);
    expect(r.errors).toEqual([{ file: 'revisions/PR-1.yaml', field: '', message: `is ${big.length} bytes; this Plannotator reads at most 1048576 bytes in one file` }]);
    expect(r.model).not.toBeNull();
  });
});

describe('the caps, read from disk and from git', () => {
  const bigDrawing = () => {
    const files: Record<string, string> = { ...smallDrawing() };
    for (let i = 1; i <= 9; i++) files[`revisions/PR-${i}.yaml`] = revisionOfSize(`PR-${i}`, MAX_FILE_BYTES - 100);
    return files;
  };
  const capError = { file: '', field: '', message: 'the drawing is over 8388608 bytes; this Plannotator reads at most that in one drawing' };

  test('a file of exactly 1 MiB on disk is read', async () => {
    const root = temp();
    writeTree(root, { ...smallDrawing(), 'revisions/PR-1.yaml': revisionOfSize('PR-1', MAX_FILE_BYTES) });
    const r = await load(root);
    expect(r.errors).toEqual([]);
    expect(Object.keys(r.model!.revisions)).toEqual(['PR-1']);
  });

  test('a drawing of exactly 8 MiB on disk is read', async () => {
    const root = temp();
    const files: Record<string, string> = { ...smallDrawing() };
    const used = Object.values(files).reduce((n, t) => n + t.length, 0);
    for (let i = 1; i <= 7; i++) files[`revisions/PR-${i}.yaml`] = revisionOfSize(`PR-${i}`, MAX_FILE_BYTES);
    files['revisions/PR-8.yaml'] = revisionOfSize('PR-8', 8 * MAX_FILE_BYTES - used - 7 * MAX_FILE_BYTES);
    writeTree(root, files);
    const r = await load(root);
    expect(r.errors).toEqual([]);
    expect(Object.keys(r.model!.revisions)).toHaveLength(8);
  });

  test('a drawing over 8 MiB on disk gives the cap error alone', async () => {
    const root = temp();
    writeTree(root, bigDrawing());
    expect(await load(root)).toEqual({ model: null, errors: [capError], warnings: [] });
  });

  test('a committed file over 1 MiB is reported, not thrown by the git buffer', async () => {
    const root = temp();
    git(root, 'init', '-q');
    writeTree(join(root, '.plannotator', 'system'), { ...smallDrawing(), 'revisions/PR-1.yaml': revisionOfSize('PR-1', MAX_FILE_BYTES + 1) });
    commit(root);
    const r = await loadCommitted({ root, ref: 'HEAD' });
    expect(r.errors).toEqual([{ file: 'revisions/PR-1.yaml', field: '', message: `is ${MAX_FILE_BYTES + 1} bytes; this Plannotator reads at most ${MAX_FILE_BYTES} bytes in one file` }]);
    expect(Object.keys(r.model!.sheets).sort()).toEqual(['C-001', 'L-101']);
    await expect(readCommitted({ root, ref: 'HEAD' })).rejects.toThrow(`revisions/PR-1.yaml: is ${MAX_FILE_BYTES + 1} bytes`);
  });

  test('a committed file of exactly 1 MiB is read', async () => {
    const root = temp();
    git(root, 'init', '-q');
    writeTree(join(root, '.plannotator', 'system'), { ...smallDrawing(), 'revisions/PR-1.yaml': revisionOfSize('PR-1', MAX_FILE_BYTES) });
    commit(root);
    expect((await loadCommitted({ root, ref: 'HEAD' })).errors).toEqual([]);
  });

  test('a committed drawing of exactly 8 MiB is read', async () => {
    const root = temp();
    git(root, 'init', '-q');
    const files: Record<string, string> = { ...smallDrawing() };
    const used = Object.values(files).reduce((n, t) => n + t.length, 0);
    for (let i = 1; i <= 7; i++) files[`revisions/PR-${i}.yaml`] = revisionOfSize(`PR-${i}`, MAX_FILE_BYTES);
    files['revisions/PR-8.yaml'] = revisionOfSize('PR-8', 8 * MAX_FILE_BYTES - used - 7 * MAX_FILE_BYTES);
    writeTree(join(root, '.plannotator', 'system'), files);
    commit(root);
    const r = await loadCommitted({ root, ref: 'HEAD' });
    expect(r.errors).toEqual([]);
    expect(Object.keys(r.model!.revisions)).toHaveLength(8);
  });

  test('a committed drawing over 8 MiB gives the cap error alone, not "system.yaml is missing"', async () => {
    const root = temp();
    git(root, 'init', '-q');
    writeTree(join(root, '.plannotator', 'system'), bigDrawing());
    commit(root);
    expect(await loadCommitted({ root, ref: 'HEAD' })).toEqual({ model: null, errors: [capError], warnings: [] });
  });
});

describe('readCommitted', () => {
  function drawn() {
    const root = temp();
    git(root, 'init', '-q');
    const dir = join(root, '.plannotator', 'system');
    writeTree(dir, { ...smallDrawing(), 'README.md': 'notes\n', 'sheets/notes.txt': 'x\n' });
    writeTree(root, { '.plannotator/other.yaml': 'format: 1\n', 'system.yaml': 'format: 1\n' });
    commit(root, 'draw');
    return { root, dir };
  }

  test('reads the drawing at a ref, not the working tree, and only its own files', async () => {
    const { root, dir } = drawn();
    writeFileSync(join(dir, 'system.yaml'), 'format: 2\n');
    const files = await readCommitted({ root, ref: 'HEAD' });
    expect(Object.keys(files).sort()).toEqual(['sheets/C-001.yaml', 'sheets/L-101.yaml', 'system.yaml']);
    expect(loadFiles(files).errors).toEqual([]);
    expect(await readCommitted({ root, ref: 'HEAD~0' })).toEqual(files);
  });

  test('a ref git could read as an option is refused', async () => {
    const { root } = drawn();
    await expect(readCommitted({ root, ref: '--output=/tmp/x' })).rejects.toThrow('is not a git ref');
    await expect(readCommitted({ root, ref: 'no-such-branch' })).rejects.toThrow('is not a commit');
  });

  test('a .yml file reaches the loader, which names it', async () => {
    const { root, dir } = drawn();
    renameSync(join(dir, 'sheets', 'L-101.yaml'), join(dir, 'sheets', 'L-101.yml'));
    commit(root);
    const r = loadFiles(await readCommitted({ root, ref: 'HEAD' }));
    expect(r.errors).toContainEqual({ file: 'sheets/L-101.yml', field: '', message: 'a drawing file ends in .yaml: rename it sheets/L-101.yaml' });
  });

  test('a committed symlink in the drawing throws from readCommitted and is an error from loadCommitted', async () => {
    const { root, dir } = drawn();
    renameSync(join(dir, 'sheets', 'L-101.yaml'), join(root, 'L-101.yaml'));
    symlinkSync(join(root, 'L-101.yaml'), join(dir, 'sheets', 'L-101.yaml'));
    commit(root);
    await expect(readCommitted({ root, ref: 'HEAD' })).rejects.toThrow('sheets/L-101.yaml: is a symlink at HEAD');
    const r = await loadCommitted({ root, ref: 'HEAD' });
    expect(r.errors[0]).toEqual({ file: 'sheets/L-101.yaml', field: '', message: 'is a symlink at HEAD; a drawing file is a plain file in the drawing folder' });
    expect(Object.keys(r.model!.sheets)).toEqual(['C-001']);
  });
});
