/**
 * Package changes routes, both runtimes (Bun + Pi).
 *
 * Guards the privacy contract of the npm lookup:
 *  1. GET /api/package-changes works the cards out on the server, from the
 *     files behind the diff, and lists per card the names a lookup would send
 *     (private scopes withheld). It sends nothing anywhere.
 *  2. POST /api/package-changes/lookup answers 403 until config.json says
 *     yes, and PLANNOTATOR_PACKAGE_LOOKUP=0 keeps it 403 after.
 *  3. Once allowed, the names that reach the (stubbed) registry are exactly
 *     the card's `lookup.names`: the count the consent button shows.
 *  4. Registry settings come from the working tree, so a gitignored `.npmrc`
 *     withholds its scope even when the diff is of commits (HEAD has no
 *     `.npmrc` at all).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer as startBunReviewServer } from './review';
import { startReviewServer as startPiReviewServer } from '../../apps/pi-extension/server';
import { getVcsContext } from './vcs';
import { clearPackageMetadataCache } from '@plannotator/shared/package-metadata';

const SAVED_ENV = ['PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_PORT', 'HOME', 'PLANNOTATOR_PACKAGE_LOOKUP', 'PLANNOTATOR_PACKAGE_REGISTRY_URL', 'PLANNOTATOR_PACKAGE_DOWNLOADS_URL', 'npm_config_registry', 'NPM_CONFIG_REGISTRY', 'npm_config_globalconfig', 'npm_config_userconfig', 'XDG_CONFIG_HOME'] as const;
const original = Object.fromEntries(SAVED_ENV.map((k) => [k, process.env[k]]));
const tempDirs: string[] = [];
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const k of SAVED_ENV) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearPackageMetadataCache();
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

/** A local stand-in for registry.npmjs.org and api.npmjs.org that records every name asked for. */
function stubRegistry(): { url: string; names: string[] } {
  const names: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path.startsWith('/downloads/point/last-week/')) {
        const list = path.slice('/downloads/point/last-week/'.length).split(',');
        names.push(...list.map((n) => `downloads:${n}`));
        const one = (n: string) => ({ downloads: 1000, package: n });
        return Response.json(list.length > 1 ? Object.fromEntries(list.map((n) => [n, one(n)])) : one(list[0]));
      }
      const name = path.slice(1);
      names.push(`packument:${name}`);
      return Response.json({ 'dist-tags': { latest: '9.9.9' }, license: 'MIT', time: {}, versions: {} });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, names };
}

const manifest = (deps: Record<string, string>) => JSON.stringify({ name: 'app', version: '1.0.0', dependencies: deps }, null, 2) + '\n';

/** A repo whose working tree changes package.json; `committed` commits the change and keeps `.npmrc` gitignored and untracked. */
function makeRepo(npmrc: string, committed = false): string {
  const repo = tempDir('plannotator-pkg-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, '.npmrc'), npmrc);
  if (committed) writeFileSync(join(repo, '.gitignore'), '.npmrc\n');
  writeFileSync(join(repo, 'package.json'), manifest({ pg: '^8.13.0', '@acme/billing': '^1.0.0', '@types/node': '^22.0.0' }));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  writeFileSync(join(repo, 'package.json'), manifest({ pg: '^8.16.3', '@acme/billing': '^2.0.0', '@types/node': '^24.3.0', kysely: '^0.28.5' }));
  if (committed) {
    git(repo, ['add', 'package.json']);
    git(repo, ['commit', '-q', '-m', 'bump']);
  }
  return repo;
}

type Card = { path: string; changes: { name: string }[]; lookup: { names: string[]; withheld: string[] } };
type Analysis = { cards: Card[]; lookup: { total: number } };

describe('package changes routes', () => {
  for (const [runtime, startServer] of [
    ['Bun', startBunReviewServer],
    ['Pi', startPiReviewServer],
  ] as const) {
    async function start(npmrc: string, committed = false) {
      process.env.PLANNOTATOR_DATA_DIR = tempDir('plannotator-pkg-data-');
      process.env.HOME = tempDir('plannotator-pkg-home-');
      // The machine's own npm settings stay out of the test.
      process.env.npm_config_globalconfig = join(process.env.HOME, 'no-global-npmrc');
      process.env.XDG_CONFIG_HOME = join(process.env.HOME, '.config');
      delete process.env.npm_config_userconfig;
      delete process.env.npm_config_registry;
      delete process.env.NPM_CONFIG_REGISTRY;
      delete process.env.PLANNOTATOR_PACKAGE_LOOKUP;
      const registry = stubRegistry();
      process.env.PLANNOTATOR_PACKAGE_REGISTRY_URL = registry.url;
      process.env.PLANNOTATOR_PACKAGE_DOWNLOADS_URL = registry.url;
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const repo = makeRepo(npmrc, committed);
      const server = await startServer({
        rawPatch: committed ? git(repo, ['diff', 'HEAD~1', 'HEAD']) : git(repo, ['diff', 'HEAD']),
        gitRef: committed ? 'Last commit' : 'Working tree',
        diffType: committed ? 'last-commit' : 'uncommitted',
        gitContext: await getVcsContext(repo, 'git'),
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      stops.push(() => server.stop());
      const lookup = () => fetch(`${server.url}/api/package-changes/lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'package.json' }),
      });
      const allow = (on: boolean) => fetch(`${server.url}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageChanges: { lookup: on } }),
      });
      return { server, registry, lookup, allow };
    }

    test(`${runtime}: the server lists the card and what a lookup would send, and sends nothing before consent`, async () => {
      const { server, registry, lookup } = await start('@acme:registry=https://npm.acme.dev/\n');
      const res = await fetch(`${server.url}/api/package-changes`);
      expect(res.status).toBe(200);
      const body = await res.json() as Analysis;
      expect(body.cards).toHaveLength(1);
      expect(body.cards[0].changes.map((c) => c.name).sort()).toEqual(['@acme/billing', '@types/node', 'kysely', 'pg']);
      expect(body.cards[0].lookup).toEqual({ names: ['@types/node', 'kysely', 'pg'], withheld: ['@acme/billing'] });
      expect(body.lookup.total).toBe(3);

      expect((await lookup()).status).toBe(403);
      expect(registry.names).toEqual([]);
    });

    test(`${runtime}: after consent the registry sees exactly the listed names; the env hard off wins over config`, async () => {
      const { server, registry, lookup, allow } = await start('@acme:registry=https://npm.acme.dev/\n');
      expect((await allow(true)).status).toBe(200);
      const res = await lookup();
      expect(res.status).toBe(200);
      const sent = new Set(registry.names.map((n) => n.split(':')[1]));
      const listed = (await fetch(`${server.url}/api/package-changes`).then((r) => r.json()) as { cards: Card[] }).cards[0].lookup.names;
      expect([...sent].sort()).toEqual(listed);
      expect(registry.names.some((n) => n.includes('@acme'))).toBe(false);

      process.env.PLANNOTATOR_PACKAGE_LOOKUP = '0';
      const before = registry.names.length;
      expect((await lookup()).status).toBe(403);
      expect(registry.names.length).toBe(before);
    });

    test(`${runtime}: a gitignored .npmrc withholds its scope when the diff is of commits`, async () => {
      const { server, registry, lookup, allow } = await start('@acme:registry=https://npm.acme.dev/\n', true);
      const body = await fetch(`${server.url}/api/package-changes`).then((r) => r.json()) as Analysis;
      expect(body.cards[0].lookup).toEqual({ names: ['@types/node', 'kysely', 'pg'], withheld: ['@acme/billing'] });
      await allow(true);
      expect((await lookup()).status).toBe(200);
      expect(registry.names.length).toBeGreaterThan(0);
      expect(registry.names.some((n) => n.includes('@acme'))).toBe(false);
    });

    test(`${runtime}: a private default registry sends no name at all`, async () => {
      const { server, registry, lookup, allow } = await start('registry=https://artifactory.corp/api/npm/\n');
      const body = await fetch(`${server.url}/api/package-changes`).then((r) => r.json()) as { cards: Card[] };
      expect(body.cards[0].lookup.names).toEqual([]);
      await allow(true);
      expect((await lookup()).status).toBe(200);
      expect(registry.names).toEqual([]);
    });
  }
});
