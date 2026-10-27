/**
 * Package changes in a PR review, both runtimes (Bun + Pi): how many GitHub
 * API calls the card costs before anyone consents to a lookup.
 *
 * GitHub's hourly quota is shared with everything else the reviewer runs, so:
 *  - with a local checkout that holds the head commit, settings are read
 *    there and the card makes no `contents` call at all;
 *  - the checkout is usually still being prepared on first load: the card
 *    waits for it rather than spending calls;
 *  - without one, package files cost at most REMOTE_PACKAGE_READS calls and
 *    settings at most REMOTE_SETTINGS_READS per head commit; past either,
 *    every name is withheld (and past the first, the cards that do not fit
 *    are left out).
 *
 * The `gh` commands go to a fake runtime (tests/helpers/fake-pr-runtime.ts)
 * that serves the contents API from a local git repository; nothing reaches
 * GitHub. Temp data dir and HOME; the machine's npm settings stay out.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import type { CommandResult } from '@plannotator/shared/pr-types';
import { REMOTE_PACKAGE_READS, REMOTE_SETTINGS_READS } from '@plannotator/shared/package-changes-service';
import type { PoolEntry, WorktreePool } from '@plannotator/shared/worktree-pool';
import { NO_BROWSER } from '../../tests/helpers/no-browser';
import { startReviewServer as startBunReviewServer } from './review';
import { setPRCommandRuntimeForTests as setBunPRRuntime } from './pr';
import { startReviewServer as startPiReviewServer } from '../../apps/pi-extension/server/serverReview';
import { setPRCommandRuntimeForTests as setPiPRRuntime } from '../../apps/pi-extension/server/pr';
import { createFakePRRuntime, type FakePRCommand } from '../../tests/helpers/fake-pr-runtime';

const SAVED_ENV = ['PLANNOTATOR_AI', 'PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_PORT', 'PLANNOTATOR_REMOTE', 'PLANNOTATOR_BROWSER', 'HOME', 'XDG_CONFIG_HOME', 'npm_config_globalconfig', 'npm_config_userconfig', 'npm_config_registry', 'NPM_CONFIG_REGISTRY'] as const;
const original = Object.fromEntries(SAVED_ENV.map((k) => [k, process.env[k]]));
const tempDirs: string[] = [];
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  setBunPRRuntime(null);
  setPiPRRuntime(null);
  for (const k of SAVED_ENV) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
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

const manifest = (deps: Record<string, string>) => JSON.stringify({ name: 'app', version: '1.0.0', dependencies: deps }, null, 2) + '\n';

/** A repository whose head commit bumps `n` manifests: one at the root, or `n` under packages/. */
function makePRRepo(n: number): { repo: string; base: string; head: string; patch: string } {
  const repo = tempDir('plannotator-pkg-pr-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  const dirs = n === 1 ? [''] : Array.from({ length: n }, (_, i) => `packages/p${i}`);
  const write = (deps: Record<string, string>) => {
    for (const dir of dirs) {
      if (dir) mkdirSync(join(repo, dir), { recursive: true });
      writeFileSync(join(repo, dir, 'package.json'), manifest(deps));
    }
  };
  write({ pg: '^8.13.0', zod: '^3.23.0' });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']).trim();
  write({ pg: '^8.16.3', zod: '^4.1.0' });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'head']);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  return { repo, base, head, patch: git(repo, ['diff', base, head]) };
}

/** `gh api repos/acme/widgets/contents/<path>?ref=<sha>` answered from the repository, like GitHub would. */
function contentsFrom(repo: string) {
  return (command: FakePRCommand): CommandResult | undefined => {
    const target = command.args.find((a) => a.startsWith('repos/acme/widgets/contents/'));
    if (!target) return undefined;
    const m = /^repos\/acme\/widgets\/contents\/([^?]+)\?ref=(.+)$/.exec(target);
    if (!m) return undefined;
    const spec = `${m[2]}:${decodeURIComponent(m[1])}`;
    const blob = spawnSync('git', ['rev-parse', '--verify', '--quiet', spec], { cwd: repo, encoding: 'utf-8' });
    if (blob.status !== 0) return { stdout: '', stderr: 'gh: Not Found (HTTP 404)\n', exitCode: 1 };
    const bytes = spawnSync('git', ['cat-file', 'blob', blob.stdout.trim()], { cwd: repo }).stdout as Buffer;
    return {
      stdout: JSON.stringify({ type: 'file', sha: blob.stdout.trim(), size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }),
      stderr: '',
      exitCode: 0,
    };
  };
}

type Analysis = { cards: { path: string; lookup: { names: string[] } }[]; lookup: { total: number } };

describe('package changes in a PR review: GitHub API calls before consent', () => {
  for (const [runtime, start, setRuntime] of [
    ['Bun', startBunReviewServer, setBunPRRuntime],
    ['Pi', startPiReviewServer, setPiPRRuntime],
  ] as const) {
    async function review(n: number, checkout: boolean | 'late') {
      process.env.PLANNOTATOR_AI = 'disabled';
      process.env.PLANNOTATOR_REMOTE = '0';
      process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
      process.env.PLANNOTATOR_DATA_DIR = tempDir('plannotator-pkg-pr-data-');
      process.env.HOME = tempDir('plannotator-pkg-pr-home-');
      process.env.npm_config_globalconfig = join(process.env.HOME, 'no-global-npmrc');
      process.env.XDG_CONFIG_HOME = join(process.env.HOME, '.config');
      delete process.env.npm_config_userconfig;
      delete process.env.npm_config_registry;
      delete process.env.NPM_CONFIG_REGISTRY;
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      else delete process.env.PLANNOTATOR_PORT;

      const { repo, base, head, patch } = makePRRepo(n);
      const fake = createFakePRRuntime(contentsFrom(repo));
      setRuntime(fake.runtime);
      const prMetadata: PRMetadata = {
        platform: 'github',
        host: 'github.invalid',
        owner: 'acme',
        repo: 'widgets',
        number: 42,
        title: 'Bump',
        author: 'someone',
        baseBranch: 'main',
        headBranch: 'bump',
        baseSha: base,
        headSha: head,
        mergeBaseSha: base,
        url: 'https://github.invalid/acme/widgets/pull/42',
      };
      const server = await start({
        rawPatch: patch,
        gitRef: 'PR #42',
        htmlContent: '<!doctype html><html><body>review</body></html>',
        prMetadata,
        ...(checkout === true ? { agentCwd: repo } : {}),
        ...(checkout === 'late' ? { worktreePool: latePool(prMetadata.url, repo, 400) } : {}),
      });
      stops.push(() => server.stop());
      const contentsCalls = () => fake.calls.filter((c) => c.args.some((a) => a.includes('/contents/'))).length;
      const get = async () => {
        const res = await fetch(`${server.url}/api/package-changes`);
        expect(res.status).toBe(200);
        return (await res.json()) as Analysis;
      };
      return { contentsCalls, get };
    }

    // Package files: two reads per changed manifest, at most REMOTE_PACKAGE_READS (10 cards).
    // Settings: 4 for a root package; over the cap, none.
    for (const [n, calls, cards, sends] of [[1, 2 + 4, 1, true], [5, 10, 5, false], [30, REMOTE_PACKAGE_READS, 10, false]] as const) {
      test(`${runtime}: no checkout, ${n} card${n === 1 ? '' : 's'}: ${calls} contents calls`, async () => {
        const { contentsCalls, get } = await review(n, false);
        const body = await get();
        expect(body.cards).toHaveLength(cards);
        expect(contentsCalls()).toBe(calls);
        expect(contentsCalls()).toBeLessThanOrEqual(REMOTE_PACKAGE_READS + REMOTE_SETTINGS_READS);
        // Over a cap nothing is offered: every name is withheld.
        expect(body.lookup.total > 0).toBe(sends);
        // A second look at the same head commit costs nothing.
        await get();
        expect(contentsCalls()).toBe(calls);
      });

      test(`${runtime}: a local checkout, ${n} card${n === 1 ? '' : 's'}: no contents call`, async () => {
        const { contentsCalls, get } = await review(n, true);
        const body = await get();
        expect(body.cards).toHaveLength(n);
        expect(contentsCalls()).toBe(0);
        expect(body.lookup.total).toBe(2);
      });
    }

    test(`${runtime}: a checkout still being prepared: the card waits for it and makes no contents call`, async () => {
      const { contentsCalls, get } = await review(5, 'late');
      const body = await get();
      expect(body.cards).toHaveLength(5);
      expect(contentsCalls()).toBe(0);
      expect(body.lookup.total).toBe(2);
    });
  }
});

/** A pool whose checkout of the PR is still being prepared: it is ready `ms` after the first ensure(). */
function latePool(url: string, path: string, ms: number): WorktreePool {
  const entry: PoolEntry = { path, prUrl: url, number: 42, ready: false };
  let pending: Promise<PoolEntry> | null = null;
  return {
    get: (u) => (u === url ? entry : undefined),
    has: (u) => u === url,
    resolve: (u) => (u === url && entry.ready ? entry.path : undefined),
    ensure: () => (pending ??= new Promise((resolve) => setTimeout(() => { entry.ready = true; resolve(entry); }, ms))),
    entries: () => [entry][Symbol.iterator](),
    cleanup: async () => {},
  };
}
