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

/**
 * Whether a drawing's own commit (`sources.repos.self.at`) is in a clone, and how it got there. CI clones one
 * commit, so `at` is usually absent: one depth-limited fetch of exactly that commit is tried (depth 1 in a shallow
 * clone, so the clone stays shallow; a plain fetch of the one commit in a full clone, so a full clone does not
 * become shallow). It runs only when the commit is missing, with no prompt and a time bound. When it cannot get
 * the commit, `reason` says why, for the test to print as its skip reason.
 */
export type AtState = { ok: true; at: string; how: 'present' | 'fetched' } | { ok: false; at: string; reason: string };

export function commitAt(root: string, at: string, o: { timeoutMs?: number } = {}): AtState {
  const run = (args: string[], timeout?: number) =>
    execFileSync('git', ['-C', root, ...args], {
      // no prompt, and no global or system git config: a CI checkout keeps its auth in the clone's own config
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
  const has = () => {
    try {
      run(['cat-file', '-e', `${at}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (!/^[0-9a-f]{7,40}$/.test(at)) return { ok: false, at, reason: `${at} is not a commit id` };
  if (has()) return { ok: true, at, how: 'present' };
  let remote = '';
  try {
    remote = run(['remote', 'get-url', 'origin']).trim();
  } catch {
    return { ok: false, at, reason: `${at} is not in this clone, and it has no origin to fetch it from` };
  }
  const shallow = run(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  try {
    run(['fetch', '--quiet', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', at], o.timeoutMs ?? 30_000);
  } catch (e) {
    const err = e as { stderr?: string; code?: string; message?: string };
    const why = err.code === 'ETIMEDOUT' ? 'timed out' : (err.stderr || err.message || '').trim().split('\n').at(-1) || 'failed';
    return { ok: false, at, reason: `${at} is not in this clone, and git fetch${shallow ? ' --depth=1' : ''} origin ${at} from ${remote} ${why.startsWith('timed') ? why : `failed: ${why}`}` };
  }
  return has() ? { ok: true, at, how: 'fetched' } : { ok: false, at, reason: `${at} is not in this clone, and fetching it from ${remote} did not bring it` };
}
