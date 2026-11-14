/**
 * Image diffs read both sides in every local Git mode and in a PR review,
 * in both runtimes (Bun + Pi): staged (index vs HEAD), a branch compared
 * with main (merge base vs the branch), and a GitHub PR with no checkout,
 * whose bytes come from the contents API. The `gh` commands go to a fake
 * runtime (tests/helpers/fake-pr-runtime.ts) answered from a local
 * repository; nothing reaches GitHub. Temp data dir and HOME.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, PRMetadata } from '@plannotator/shared/pr-types';
import { NO_BROWSER } from '../../tests/helpers/no-browser';
import { createFakePRRuntime, type FakePRCommand } from '../../tests/helpers/fake-pr-runtime';
import { startReviewServer as startBunReviewServer } from './review';
import { setPRCommandRuntimeForTests as setBunPRRuntime } from './pr';
import { startReviewServer as startPiReviewServer } from '../../apps/pi-extension/server/serverReview';
import { setPRCommandRuntimeForTests as setPiPRRuntime } from '../../apps/pi-extension/server/pr';
import { getVcsContext, runVcsDiff } from './vcs';

const SAVED_ENV = ['PLANNOTATOR_AI', 'PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_PORT', 'PLANNOTATOR_REMOTE', 'PLANNOTATOR_BROWSER', 'HOME'] as const;
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

function png(width: number, height: number, seed: number): Uint8Array {
  const out = new Uint8Array(33 + 64);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let i = 33; i < out.length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const MAIN = png(4, 4, 1);
const BRANCH = png(6, 4, 2);
const STAGED = png(8, 4, 3);
const WORKTREE = png(9, 4, 4);

function buildRepo(): { repo: string; base: string; head: string } {
  const repo = tempDir('plannotator-image-modes-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'shot.png'), MAIN);
  writeFileSync(join(repo, 'notes.txt'), 'one\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'main']);
  const base = git(repo, ['rev-parse', 'HEAD']).trim();
  git(repo, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(repo, 'shot.png'), BRANCH);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'feature']);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(repo, 'shot.png'), STAGED);
  git(repo, ['add', 'shot.png']);
  writeFileSync(join(repo, 'shot.png'), WORKTREE);
  return { repo, base, head };
}

function contentsFrom(repo: string) {
  return (command: FakePRCommand): CommandResult | undefined => {
    const target = command.args.find((a) => a.startsWith('repos/acme/widgets/contents/'));
    if (!target) return undefined;
    const m = /^repos\/acme\/widgets\/contents\/([^?]+)\?ref=(.+)$/.exec(target);
    if (!m) return undefined;
    const blob = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${m[2]}:${decodeURIComponent(m[1])}`], { cwd: repo, encoding: 'utf-8' });
    if (blob.status !== 0) return { stdout: '', stderr: 'gh: Not Found (HTTP 404)\n', exitCode: 1 };
    const bytes = spawnSync('git', ['cat-file', 'blob', blob.stdout.trim()], { cwd: repo }).stdout as Buffer;
    return {
      stdout: JSON.stringify({ type: 'file', sha: blob.stdout.trim(), size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }),
      stderr: '',
      exitCode: 0,
    };
  };
}

describe('image diffs read both sides in each review mode', () => {
  for (const [runtime, start, setRuntime] of [
    ['Bun', startBunReviewServer, setBunPRRuntime],
    ['Pi', startPiReviewServer, setPiPRRuntime],
  ] as const) {
    async function environment() {
      process.env.PLANNOTATOR_AI = 'disabled';
      process.env.PLANNOTATOR_REMOTE = '0';
      process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
      process.env.PLANNOTATOR_DATA_DIR = tempDir('plannotator-image-modes-data-');
      process.env.HOME = tempDir('plannotator-image-modes-home-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      else delete process.env.PLANNOTATOR_PORT;
    }

    const read = async (url: string, snapshot: string, side: 'old' | 'new') =>
      new Uint8Array(await (await fetch(`${url}/api/review-image?path=shot.png&side=${side}&snapshot=${encodeURIComponent(snapshot)}`)).arrayBuffer());

    test(`${runtime}: staged reads HEAD and the index; the branch compare reads main and the branch tip`, async () => {
      await environment();
      const { repo } = buildRepo();
      const diff = await runVcsDiff('staged', 'main', repo);
      const server = await start({
        rawPatch: diff.patch,
        gitRef: diff.label,
        diffType: 'staged',
        gitContext: await getVcsContext(repo, 'git'),
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<html></html>',
      });
      stops.push(() => server.stop());
      const staged = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as { snapshotId: string };
      expect(await read(server.url, staged.snapshotId, 'old')).toEqual(BRANCH);
      expect(await read(server.url, staged.snapshotId, 'new')).toEqual(STAGED);

      const switched = (await fetch(`${server.url}/api/diff/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diffType: 'branch', base: 'main' }),
      }).then((r) => r.json())) as { snapshotId: string };
      expect(await read(server.url, switched.snapshotId, 'old')).toEqual(MAIN);
      expect(await read(server.url, switched.snapshotId, 'new')).toEqual(BRANCH);
    }, 30_000);

    test(`${runtime}: a GitHub PR with no checkout reads both sides through the contents API`, async () => {
      await environment();
      const { repo, base, head } = buildRepo();
      const fake = createFakePRRuntime(contentsFrom(repo));
      setRuntime(fake.runtime);
      const prMetadata: PRMetadata = {
        platform: 'github',
        host: 'github.invalid',
        owner: 'acme',
        repo: 'widgets',
        number: 7,
        title: 'New screenshot',
        author: 'someone',
        baseBranch: 'main',
        headBranch: 'feature',
        baseSha: base,
        headSha: head,
        mergeBaseSha: base,
        url: 'https://github.invalid/acme/widgets/pull/7',
      };
      const server = await start({
        rawPatch: git(repo, ['diff', base, head]),
        gitRef: 'PR #7',
        htmlContent: '<html></html>',
        prMetadata,
      });
      stops.push(() => server.stop());
      const payload = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as { snapshotId: string; imagePreviewSupported?: boolean };
      expect(payload.imagePreviewSupported).toBe(true);
      expect(await read(server.url, payload.snapshotId, 'old')).toEqual(MAIN);
      expect(await read(server.url, payload.snapshotId, 'new')).toEqual(BRANCH);
      expect(fake.calls.some((c) => c.args.some((a) => a.includes(`/contents/shot.png?ref=${head}`)))).toBe(true);
    }, 30_000);
  }
});
