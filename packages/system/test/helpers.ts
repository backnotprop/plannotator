import { afterAll, beforeAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SystemFiles } from '../src/index.ts';

export const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const drawingDir = join(repoRoot, '.plannotator', 'system');
export const fixturesDir = join(import.meta.dir, 'fixtures');

/** A temp folder removed by the returned cleanup. */
export function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'plannotator-system-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** git in a temp repo, with a fixed identity and no signing, and no global or system config read. */
export function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=Maya Chen', '-c', 'user.email=maya@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' },
  );
}

/** For the package's own git calls in this file's tests: no global or system git config, restored after. */
export function isolateGitConfig(): void {
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
  const before = keys.map((k) => process.env[k]);
  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });
  afterAll(() =>
    keys.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    }),
  );
}

/** Write files (text or bytes) under `root`, making folders as needed. */
export function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
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

/** A revision file that loads clean and is exactly `bytes` long (ASCII, padded with a comment). */
export function revisionOfSize(id: string, bytes: number): string {
  const head = `revision: ${id}\n# `;
  return head + 'x'.repeat(bytes - head.length - 1) + '\n';
}
