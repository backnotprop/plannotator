/**
 * GET /api/review-file — full-file serving for the code-review file viewer,
 * plus the hardening retrofit on GET /api/code-nav/file. Dual-runtime.
 *
 * What can regress here:
 *  1. The endpoint hands out a file it must not. The review side's only
 *     traversal defense was a lexical `..`/leading-slash check, which a
 *     symlink walks straight past. These tests put a real escaping symlink in
 *     a real repo and assert the bytes never come back.
 *  2. The 5 MiB cap stops applying, making one request a memory bomb.
 *  3. Bun and Pi drift — every case runs against both servers.
 *  4. The code-nav retrofit gets reverted. `/api/code-nav/file` had NO size
 *     cap and the same lexical-only guard; the last block asserts it now
 *     answers like the new endpoint.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer as startBunReviewServer } from './review';
import { startReviewServer as startPiReviewServer } from '../../apps/pi-extension/server';
import { getVcsContext } from './vcs';
import { MAX_REPO_FILE_BYTES } from '@plannotator/shared/repo-file';

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  // realpath so containment comparisons see the same canonical prefix the
  // server does (/tmp is a symlink to /private/tmp on macOS).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

const SECRET = 'SUPER-SECRET-OUTSIDE-THE-REPO';

/**
 * A repo with the shapes that matter: an ordinary file, a symlink that leaves
 * the repo, a directory symlink that leaves it, and a symlink that stays in.
 */
function initRepo(): { repoDir: string; outsideDir: string } {
  const base = makeTempDir('plannotator-review-file-');
  const repoDir = join(base, 'repo');
  const outsideDir = join(base, 'outside');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  writeFileSync(join(outsideDir, 'secret.txt'), `${SECRET}\n`);
  writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(join(repoDir, 'README.md'), '# repo\n');
  symlinkSync(join(outsideDir, 'secret.txt'), join(repoDir, 'escape.txt'));
  symlinkSync(outsideDir, join(repoDir, 'escape-dir'));
  symlinkSync(join(repoDir, 'src', 'app.ts'), join(repoDir, 'inside-link.ts'));

  git(repoDir, ['init', '-q']);
  git(repoDir, ['branch', '-M', 'main']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  return { repoDir, outsideDir };
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

const RAW_PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-export const app = 0;',
  '+export const app = 1;',
].join('\n');

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/review-file', () => {
  for (const [runtime, startServer] of [
    ['Bun', startBunReviewServer],
    ['Pi', startPiReviewServer],
  ] as const) {
    async function withServer(
      repoDir: string,
      body: (url: string) => Promise<void>,
    ): Promise<void> {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-review-file-data-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const gitContext = await getVcsContext(repoDir, 'git');
      const server = await startServer({
        rawPatch: RAW_PATCH,
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        gitContext,
        agentCwd: repoDir,
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        await body(server.url);
      } finally {
        server.stop();
      }
    }

    test(`${runtime} serves a file from the review root`, async () => {
      const { repoDir } = initRepo();
      await withServer(repoDir, async (url) => {
        const response = await fetch(`${url}/api/review-file?path=src/app.ts`);
        expect(response.status).toBe(200);
        const data = (await response.json()) as {
          content: string;
          filePath: string;
          size: number;
        };
        expect(data.content).toBe('export const app = 1;\n');
        expect(data.filePath).toBe('src/app.ts');
        expect(data.size).toBe('export const app = 1;\n'.length);
      });
    });

    test(`${runtime} serves a file that is not in the diff at all`, async () => {
      // The whole point of the feature: open a file the patch never mentions.
      const { repoDir } = initRepo();
      await withServer(repoDir, async (url) => {
        const response = await fetch(`${url}/api/review-file?path=README.md`);
        expect(response.status).toBe(200);
        expect(((await response.json()) as { content: string }).content).toBe('# repo\n');
      });
    });

    test(`${runtime} rejects path traversal`, async () => {
      const { repoDir } = initRepo();
      await withServer(repoDir, async (url) => {
        for (const candidate of [
          '../outside/secret.txt',
          'src/../../outside/secret.txt',
          '/etc/passwd',
        ]) {
          const response = await fetch(
            `${url}/api/review-file?path=${encodeURIComponent(candidate)}`,
          );
          expect(response.status).toBe(400);
          expect(await response.text()).not.toContain(SECRET);
        }
      });
    });

    test(`${runtime} refuses a symlink that escapes the review root`, async () => {
      // Lexically clean (no ".."), so the old validateFilePath allowed it.
      const { repoDir } = initRepo();
      await withServer(repoDir, async (url) => {
        for (const candidate of ['escape.txt', 'escape-dir/secret.txt']) {
          const response = await fetch(
            `${url}/api/review-file?path=${encodeURIComponent(candidate)}`,
          );
          expect(response.status).toBe(403);
          expect(await response.text()).not.toContain(SECRET);
        }
      });
    });

    test(`${runtime} still follows a symlink that stays inside the root`, async () => {
      // Containment must not be so blunt that ordinary in-repo links break.
      const { repoDir } = initRepo();
      await withServer(repoDir, async (url) => {
        const response = await fetch(`${url}/api/review-file?path=inside-link.ts`);
        expect(response.status).toBe(200);
        expect(((await response.json()) as { content: string }).content).toBe(
          'export const app = 1;\n',
        );
      });
    });

    test(`${runtime} answers 404 for a missing file and 400 for a directory`, async () => {
      const { repoDir } = initRepo();
      await withServer(repoDir, async (url) => {
        expect((await fetch(`${url}/api/review-file?path=src/nope.ts`)).status).toBe(404);
        expect((await fetch(`${url}/api/review-file?path=src`)).status).toBe(400);
        expect((await fetch(`${url}/api/review-file`)).status).toBe(400);
      });
    });

    test(`${runtime} caps the response at ${MAX_REPO_FILE_BYTES} bytes`, async () => {
      const { repoDir } = initRepo();
      writeFileSync(
        join(repoDir, 'huge.txt'),
        Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 0x61),
      );
      await withServer(repoDir, async (url) => {
        const response = await fetch(`${url}/api/review-file?path=huge.txt`);
        expect(response.status).toBe(413);
        const data = (await response.json()) as { reason: string; size: number };
        expect(data.reason).toBe('too-large');
        expect(data.size).toBe(MAX_REPO_FILE_BYTES + 1);
      });
    });

    // --- The retrofit -----------------------------------------------------
    // /api/code-nav/file shipped with no size cap and the same lexical-only
    // guard. It must now behave exactly like the new endpoint.

    test(`${runtime} /api/code-nav/file refuses an escaping symlink`, async () => {
      const { repoDir } = initRepo();
      await withServer(repoDir, async (url) => {
        const response = await fetch(`${url}/api/code-nav/file?path=escape.txt`);
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(SECRET);
      });
    });

    test(`${runtime} /api/code-nav/file now enforces the size cap`, async () => {
      const { repoDir } = initRepo();
      writeFileSync(
        join(repoDir, 'huge.txt'),
        Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 0x61),
      );
      await withServer(repoDir, async (url) => {
        const response = await fetch(`${url}/api/code-nav/file?path=huge.txt`);
        expect(response.status).toBe(413);
      });
    });

    test(`${runtime} /api/code-nav/file still serves ordinary files`, async () => {
      // The retrofit must not break the peek preview it guards.
      const { repoDir } = initRepo();
      await withServer(repoDir, async (url) => {
        const response = await fetch(`${url}/api/code-nav/file?path=src/app.ts`);
        expect(response.status).toBe(200);
        expect(((await response.json()) as { content: string }).content).toBe(
          'export const app = 1;\n',
        );
      });
    });
  }
});
