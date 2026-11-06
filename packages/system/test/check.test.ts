import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { citations, loadFiles } from '../src/index.ts';
import { check, load, readCommitted } from '../src/node/index.ts';
import { drawingDir, git, repoRoot, smallDrawing, tempDir } from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
const temp = () => {
  const t = tempDir();
  cleanups.push(t.done);
  return t.dir;
};

/** A repo root holding an empty file (or folder) at every path the committed drawing cites. */
async function citedTree(): Promise<string> {
  const root = temp();
  const { model } = await load(drawingDir);
  for (const c of citations(model!)) {
    const full = join(root, c.path);
    if (/\.[a-z0-9]+$/i.test(c.path) || c.path.endsWith('open-in-vscode')) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, '');
    } else mkdirSync(full, { recursive: true });
  }
  return root;
}

describe('check', () => {
  test('the committed drawing is clean against this repo', async () => {
    expect(await check({ dir: drawingDir, root: repoRoot })).toEqual({ errors: [], warnings: [], missing: [] });
  });

  test('a renamed cited file is missing, by its path', async () => {
    const root = await citedTree();
    expect((await check({ dir: drawingDir, root })).missing).toEqual([]);
    renameSync(join(root, 'packages/server/inbox-relay.ts'), join(root, 'packages/server/inbox-relay-client.ts'));
    expect(await check({ dir: drawingDir, root })).toEqual({ errors: [], warnings: [], missing: ['packages/server/inbox-relay.ts'] });
  });

  test('a cited path in the wrong case is missing, on a case-blind disk too', async () => {
    const root = temp();
    const dir = join(root, '.plannotator', 'system');
    for (const [rel, text] of Object.entries(smallDrawing())) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'src', 'Main.ts'), '');
    writeFileSync(join(root, 'src', 'api', 'index.ts'), '');
    expect((await check({ dir, root })).missing).toEqual(['src/main.ts']);
  });

  test('a folder with no drawing is an error, not a clean check', async () => {
    const root = temp();
    expect((await check({ dir: join(root, '.plannotator', 'system'), root })).errors).toEqual([
      `no drawing in ${join(root, '.plannotator', 'system')} (no system.yaml)`,
    ]);
  });
});

describe('readCommitted', () => {
  test('reads the drawing at a ref, not the working tree', async () => {
    const root = temp();
    git(root, 'init', '-q');
    const dir = join(root, '.plannotator', 'system');
    for (const [rel, text] of Object.entries(smallDrawing())) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'draw');
    writeFileSync(join(dir, 'system.yaml'), 'format: 2\n');
    const files = await readCommitted({ root, ref: 'HEAD' });
    expect(Object.keys(files).sort()).toEqual(['sheets/C-001.yaml', 'sheets/L-101.yaml', 'system.yaml']);
    expect(loadFiles(files).errors).toEqual([]);
    expect(await readCommitted({ root, ref: 'HEAD~0' })).toEqual(files);
  });
});
