/**
 * generatedFiles sidecar on /api/diff (#1317) — dual-runtime (Bun + Pi).
 *
 * Guards three behaviors:
 *  1. A plain local git session resolves `linguist-generated` through git's
 *     own attribute machinery, so stacked and negated `.gitattributes` rules
 *     land exactly as git resolves them — refining the built-in name defaults
 *     in both directions.
 *  2. Sessions without local git access (piped patches, and by the same gate
 *     workspace/PR/jj/GitButler/P4) still emit the sidecar from the built-in
 *     name defaults alone (name matching needs no git), and omit it when no
 *     served path matches.
 *  3. The built-in defaults apply in git sessions with no `.gitattributes`
 *     at all — the industry-standard lockfile experience needs zero setup.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer as startBunReviewServer } from './review';
import { startReviewServer as startPiReviewServer } from '../../apps/pi-extension/server';
import { getVcsContext } from './vcs';

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

function initRepo(): string {
  const repoDir = makeTempDir('plannotator-generated-endpoint-');
  git(repoDir, ['init', '-q']);
  git(repoDir, ['branch', '-M', 'main']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  writeFileSync(join(repoDir, 'README.md'), '# repo\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  return repoDir;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function fileChunk(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
}

const RAW_PATCH = [
  fileChunk('gen/schema.sql'),
  fileChunk('gen/keep.ts'),
  fileChunk('docs/api.md'),
  fileChunk('src/app.ts'),
].join('\n');

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('generatedFiles sidecar (#1317)', () => {
  for (const [runtime, startServer] of [
    ['Bun', startBunReviewServer],
    ['Pi', startPiReviewServer],
  ] as const) {
    test(`${runtime} resolves linguist-generated via git, honoring negated rules`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-generated-data-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const repoDir = initRepo();
      writeFileSync(
        join(repoDir, '.gitattributes'),
        [
          'gen/** linguist-generated',
          // Negated rule stacked after the glob — must win, exactly as git
          // resolves it (a naive first-match parser would mark it generated).
          'gen/keep.ts -linguist-generated',
          'docs/api.md linguist-generated=true',
        ].join('\n') + '\n',
      );
      mkdirSync(join(repoDir, 'gen'), { recursive: true });
      const gitContext = await getVcsContext(repoDir, 'git');

      const server = await startServer({
        rawPatch: RAW_PATCH,
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        gitContext,
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        const data = await fetch(`${server.url}/api/diff`).then((r) => r.json()) as {
          rawPatch: string;
          generatedFiles?: string[];
        };
        expect(data.generatedFiles).toEqual(['gen/schema.sql', 'docs/api.md']);
        // Presentation-layer contract: the diff itself is never filtered —
        // every generated file's content still ships in full.
        expect(data.rawPatch).toBe(RAW_PATCH);
      } finally {
        server.stop();
      }
    });

    test(`${runtime} without local git access emits the sidecar from name defaults alone`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-generated-data-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const server = await startServer({
        rawPatch: [fileChunk('bun.lock'), fileChunk('src/app.ts')].join('\n'),
        gitRef: 'Piped diff',
        diffType: 'uncommitted',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        const data = await fetch(`${server.url}/api/diff`).then((r) => r.json()) as {
          generatedFiles?: string[];
        };
        expect(data.generatedFiles).toEqual(['bun.lock']);
      } finally {
        server.stop();
      }
    });

    test(`${runtime} omits the sidecar without git when no path matches a default`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-generated-data-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const server = await startServer({
        rawPatch: RAW_PATCH,
        gitRef: 'Piped diff',
        diffType: 'uncommitted',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        const data = await fetch(`${server.url}/api/diff`).then((r) => r.json()) as {
          generatedFiles?: string[];
        };
        expect(data.generatedFiles).toBeUndefined();
      } finally {
        server.stop();
      }
    });

    test(`${runtime} applies built-in defaults with no .gitattributes and honors -linguist-generated un-marks`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-generated-data-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const repoDir = initRepo();
      // No .gitattributes: bun.lock collapses from the built-in list alone.
      // Then the second half: an explicit un-mark beats the built-in list.
      const gitContext = await getVcsContext(repoDir, 'git');
      const patch = [fileChunk('bun.lock'), fileChunk('yarn.lock'), fileChunk('src/app.ts')].join('\n');

      const bare = await startServer({
        rawPatch: patch,
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        gitContext,
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        const data = await fetch(`${bare.url}/api/diff`).then((r) => r.json()) as {
          generatedFiles?: string[];
        };
        expect(data.generatedFiles).toEqual(['bun.lock', 'yarn.lock']);
      } finally {
        bare.stop();
      }

      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      writeFileSync(join(repoDir, '.gitattributes'), 'yarn.lock -linguist-generated\n');
      const unmarked = await startServer({
        rawPatch: patch,
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        gitContext,
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        const data = await fetch(`${unmarked.url}/api/diff`).then((r) => r.json()) as {
          generatedFiles?: string[];
        };
        expect(data.generatedFiles).toEqual(['bun.lock']);
      } finally {
        unmarked.stop();
      }
    });

    test(`${runtime} omits the sidecar when neither attributes nor defaults mark anything`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-generated-data-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const repoDir = initRepo();
      const gitContext = await getVcsContext(repoDir, 'git');
      const server = await startServer({
        rawPatch: RAW_PATCH,
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        gitContext,
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        const data = await fetch(`${server.url}/api/diff`).then((r) => r.json()) as {
          generatedFiles?: string[];
        };
        expect(data.generatedFiles).toBeUndefined();
      } finally {
        server.stop();
      }
    });
  }
});
