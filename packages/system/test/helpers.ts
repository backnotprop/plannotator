import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SystemFiles } from '../src/index.ts';

export const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const drawingDir = join(repoRoot, '.plannotator', 'system');
export const fixturesDir = join(import.meta.dir, 'fixtures');

/** A temp folder removed by the returned cleanup. */
export function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'plannotator-system-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** git in a temp repo, with a fixed identity and no signing, so no user config is read or needed. */
export function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=Maya Chen', '-c', 'user.email=maya@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { env: process.env, encoding: 'utf8' },
  );
}

/** The smallest drawing that loads clean: two scopes, three parts, one line, two sheets. */
export function smallDrawing(): SystemFiles {
  return {
    'system.yaml': [
      'format: 1',
      'system: Small',
      'root: C-001',
      'sources:',
      '  repos:',
      '    self: { repo: example.com/acme/small, at: 1a2b3c4 }',
      'scopes: { root: Small, app: The app }',
      'parts:',
      '  person: { name: Maya Chen, kind: people }',
      '  app: { name: The app, child: app, code: { src/main.ts: the entry } }',
      '  api: { in: app, name: API, code: { src/api: every route } }',
      'flows:',
      '  use: { from: person, to: app, says: uses it, lands: api, code: { to: src/api/index.ts } }',
      '',
    ].join('\n'),
    'sheets/C-001.yaml': 'sheet: C-001\nscope: root\nkind: conceptual\ntitle: Small\nbands:\n  - { id: all, row: [person, app] }\nshow: [use]\n',
    'sheets/L-101.yaml': 'sheet: L-101\nscope: app\nkind: logical\ntitle: The app\nbands:\n  - { id: inside, row: [api] }\n',
  };
}

/** The same drawing with one file's text changed by `edit`. */
export function edited(path: string, edit: (text: string) => string): SystemFiles {
  const files = smallDrawing();
  files[path] = edit(files[path] ?? '');
  return files;
}
