/**
 * The package changes service, against a stub host: which names a lookup may
 * send, and what a card shows when a side cannot be read.
 *
 * Privacy rule under test: a name leaves the machine only when every registry
 * setting that could route it elsewhere was read and none does. Settings come
 * from the working tree in a local review (gitignored files count), the PR
 * head in a PR review, the user's own files and the environment; anything
 * that cannot be read withholds every name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffFileStatus } from '@plannotator/core/diff-files';
import {
  createPackageChangesService,
  readLocalSettingsFile,
  REMOTE_PACKAGE_READS,
  REMOTE_SETTINGS_READS,
  type PackageChangesHost,
  type PackageChangesResponse,
  type PackageSettingsSource,
  type PackageSideRead,
} from './package-changes-service';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plannotator-pkg-svc-'));
  tempDirs.push(dir);
  return dir;
}

const manifest = (deps: Record<string, string>) => JSON.stringify({ name: 'app', version: '1.0.0', dependencies: deps }, null, 2);
const BEFORE = manifest({ pg: '^8.13.0', '@acme/billing': '^1.0.0', '@types/node': '^22.0.0' });
const AFTER = manifest({ pg: '^8.16.3', '@acme/billing': '^2.0.0', '@types/node': '^24.3.0' });

interface DiffEntry { status?: DiffFileStatus; old?: string | null | 'throw'; new?: string | null | 'throw' }

/** A host over in-memory diff files. `remote` answers settings reads at the PR head. */
function host(opts: {
  diff?: Record<string, DiffEntry>;
  settings: PackageSettingsSource;
  remote?: Record<string, PackageSideRead | 'throw'>;
  home: string;
  env?: Record<string, string>;
  reads?: string[];
}): PackageChangesHost {
  const diff = opts.diff ?? { 'package.json': { old: BEFORE, new: AFTER } };
  return {
    snapshotId: () => 's1',
    diffFiles: () => Object.entries(diff).map(([path, e]) => ({ path, status: e.status ?? 'modified' })),
    readSide: async (side, path) => {
      opts.reads?.push(`${side}:${path}`);
      const entry = diff[path];
      if (entry) {
        const v = entry[side];
        if (v === 'throw') throw new Error('gh: API rate limit exceeded');
        return v == null ? { kind: 'missing' } : { kind: 'ok', text: v };
      }
      const r = opts.remote?.[path];
      if (r === 'throw') throw new Error('gh: API rate limit exceeded');
      return r ?? { kind: 'missing' };
    },
    settings: () => opts.settings,
    homeDir: () => opts.home,
    lookupEnabled: () => false,
    // No global npmrc but the one named here: the machine's own stays out of the test.
    env: { npm_config_globalconfig: join(opts.home, 'no-global-npmrc'), PATH: '', ...opts.env },
  };
}

/** The platform API at the PR head: every read is logged as one call. */
function remoteSource(files: Record<string, PackageSideRead | 'throw'>, log: string[] = []): PackageSettingsSource {
  return {
    kind: 'remote',
    key: 'remote:head',
    read: async (path) => {
      log.push(path);
      const r = files[path];
      if (r === 'throw') throw new Error('gh: API rate limit exceeded');
      return r ?? { kind: 'missing' };
    },
  };
}

/** A local checkout holding the head commit: `files` are the commit's files. */
function commitSource(files: Record<string, string>, log: string[] = []): PackageSettingsSource {
  return {
    kind: 'commit',
    key: 'commit:head',
    list: async () => { log.push('list'); return Object.keys(files); },
    read: async (path) => { log.push(`read:${path}`); return path in files ? { kind: 'ok', text: files[path] } : { kind: 'missing' }; },
  };
}

const local = (dir: string): PackageSettingsSource => ({ kind: 'local', dirOf: async (path) => join(dir, path.split('/').slice(0, -1).join('/')) });

async function analysis(h: PackageChangesHost): Promise<PackageChangesResponse> {
  const out = await createPackageChangesService(h).get({ snapshot: null, base: undefined });
  return out.body as PackageChangesResponse;
}

const ALL = ['@acme/billing', '@types/node', 'pg'];

describe('settings: where a private registry can be configured', () => {
  test('a gitignored .npmrc in the working tree withholds its scope (local review)', async () => {
    const repo = tempDir();
    writeFileSync(join(repo, '.npmrc'), '@acme:registry=https://npm.acme.dev/\n');
    const out = await analysis(host({ settings: local(repo), home: tempDir() }));
    expect(out.cards[0].lookup).toEqual({ names: ['@types/node', 'pg'], withheld: ['@acme/billing'] });
    expect(out.lookup.total).toBe(2);
  });

  test('a .yarnrc.yml above the repository counts too', async () => {
    const parent = tempDir();
    const repo = join(parent, 'repo');
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
    writeFileSync(join(parent, '.yarnrc.yml'), 'npmScopes:\n    acme:\n        npmRegistryServer: "https://npm.acme.dev"\n');
    const out = await analysis(host({
      diff: { 'apps/web/package.json': { old: BEFORE, new: AFTER } },
      settings: local(repo),
      home: tempDir(),
    }));
    expect(out.cards[0].lookup.withheld).toEqual(['@acme/billing']);
  });

  test('a settings file that exists but cannot be read, or an unknown working tree, withholds every name', async () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.npmrc'));
    expect((await analysis(host({ settings: local(repo), home: tempDir() }))).cards[0].lookup).toEqual({ names: [], withheld: ALL });
    const unknown: PackageSettingsSource = { kind: 'local', dirOf: async () => null };
    expect((await analysis(host({ settings: unknown, home: tempDir() }))).lookup.total).toBe(0);
    expect((await analysis(host({ settings: { kind: 'none' }, home: tempDir() }))).lookup.total).toBe(0);
  });

  test('PR review: settings at the PR head count; a failed or oversized read withholds every name', async () => {
    const npmrc: PackageSideRead = { kind: 'ok', text: '@acme:registry=https://npm.acme.dev/\n' };
    const ok = await analysis(host({ settings: remoteSource({ '.npmrc': npmrc }), home: tempDir() }));
    expect(ok.cards[0].lookup).toEqual({ names: ['@types/node', 'pg'], withheld: ['@acme/billing'] });

    for (const failure of ['throw', { kind: 'unreadable', reason: 'too large' }] as const) {
      const out = await analysis(host({ settings: remoteSource({ 'bunfig.toml': failure }), home: tempDir() }));
      expect(out.cards[0].lookup).toEqual({ names: [], withheld: ALL });
    }
  });

  test('user files: NPM_CONFIG_USERCONFIG, ~/.yarnrc.yml, ~/.yarnrc, ~/.bunfig.toml, the global npmrc', async () => {
    const cases: [string, string, Record<string, string>][] = [
      ['custom-npmrc', '@acme:registry=https://npm.acme.dev/', { NPM_CONFIG_USERCONFIG: '<home>/custom-npmrc' }],
      ['.yarnrc.yml', 'npmScopes: { acme: {} }', {}],
      ['.yarnrc', '"@acme:registry" "https://npm.acme.dev"', {}],
      ['.bunfig.toml', '[install.scopes]\nacme = "https://npm.acme.dev/"', {}],
      ['global-npmrc', '@acme:registry=https://npm.acme.dev/', { npm_config_globalconfig: '<home>/global-npmrc' }],
    ];
    for (const [name, text, env] of cases) {
      const home = tempDir();
      writeFileSync(join(home, name), text);
      const resolved = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace('<home>', home)]));
      const out = await analysis(host({ settings: local(tempDir()), home, env: resolved }));
      expect([name, out.cards[0].lookup.withheld]).toEqual([name, ['@acme/billing']]);
    }
  });

  test('the global npmrc beside the node on PATH', async () => {
    const prefix = tempDir();
    mkdirSync(join(prefix, 'bin'));
    mkdirSync(join(prefix, 'etc'));
    writeFileSync(join(prefix, 'bin', 'node'), '');
    writeFileSync(join(prefix, 'etc', 'npmrc'), 'registry=https://artifactory.corp/api/npm/\n');
    const home = tempDir();
    const h = host({ settings: local(tempDir()), home });
    h.env = { PATH: join(prefix, 'bin') };
    // Only this test's own folders exist: the machine's /usr/local/etc/npmrc and the like stay out.
    const mine = [prefix, home];
    h.readLocalFile = (path) => (mine.some((d) => path.startsWith(d)) ? readLocalSettingsFile(path) : { kind: 'missing' });
    expect((await analysis(h)).lookup.total).toBe(0);
    // And without that npmrc the same setup sends the names.
    rmSync(join(prefix, 'etc', 'npmrc'));
    expect((await analysis(h)).lookup.total).toBe(3);
  });

  test('a scoped registry in the environment', async () => {
    const out = await analysis(host({ settings: local(tempDir()), home: tempDir(), env: { 'npm_config_@acme:registry': 'https://npm.acme.dev/' } }));
    expect(out.cards[0].lookup.withheld).toEqual(['@acme/billing']);
  });

  test('a package the lockfile fetches from another host is withheld on every card', async () => {
    const lock = (pg: string, acme: string) => JSON.stringify({
      name: 'app', lockfileVersion: 3,
      packages: {
        '': { name: 'app', workspaces: ['apps/*'] },
        'apps/web': { name: 'web', dependencies: { pg: `^${pg}`, '@acme/billing': `^${acme}` } },
        'apps/api': { name: 'api', dependencies: { '@acme/billing': `^${acme}` } },
        'node_modules/pg': { version: pg, resolved: `https://registry.npmjs.org/pg/-/pg-${pg}.tgz` },
        'node_modules/@acme/billing': { version: acme, resolved: `https://registry.npmjs.org/@acme/billing/-/billing-${acme}.tgz` },
        'apps/api/node_modules/@acme/billing': { version: acme, resolved: `https://npm.acme.dev/@acme/billing/-/billing-${acme}.tgz` },
      },
    });
    const web = (pg: string, acme: string) => manifest({ pg: `^${pg}`, '@acme/billing': `^${acme}` });
    const api = (acme: string) => manifest({ '@acme/billing': `^${acme}` });
    const out = await analysis(host({
      diff: {
        'package-lock.json': { old: lock('8.13.1', '1.0.0'), new: lock('8.16.3', '2.0.0') },
        'apps/web/package.json': { old: web('8.13.1', '1.0.0'), new: web('8.16.3', '2.0.0') },
        'apps/api/package.json': { old: api('1.0.0'), new: api('2.0.0') },
      },
      settings: local(tempDir()),
      home: tempDir(),
    }));
    const by = Object.fromEntries(out.cards.map((c) => [c.path, c.lookup]));
    expect(by['apps/web/package.json']).toEqual({ names: ['pg'], withheld: ['@acme/billing'] });
    expect(by['apps/api/package.json']).toEqual({ names: [], withheld: ['@acme/billing'] });
    expect(out.lookup.total).toBe(1);
  });
});

describe('consent count and reads', () => {
  test('the count is every name across all cards, once each', async () => {
    const out = await analysis(host({
      diff: {
        'apps/web/package.json': { old: BEFORE, new: AFTER },
        'apps/api/package.json': { old: manifest({ pg: '^8.13.0', zod: '^3.0.0' }), new: manifest({ pg: '^8.16.3', zod: '^4.0.0' }) },
      },
      settings: local(tempDir()),
      home: tempDir(),
    }));
    expect(out.cards.map((c) => c.lookup.names.length)).toEqual([2, 3]);
    expect(out.lookup.total).toBe(4);
  });

  test('PLANNOTATOR_PACKAGE_LOOKUP=0: no settings are read at all', async () => {
    const reads: string[] = [];
    let asked = false;
    const out = await analysis(host({
      settings: { kind: 'local', dirOf: async () => { asked = true; return null; } },
      home: tempDir(),
      env: { PLANNOTATOR_PACKAGE_LOOKUP: '0' },
      reads,
    }));
    expect(asked).toBe(false);
    expect(reads).toEqual(['old:package.json', 'new:package.json']);
    expect(out.lookup.total).toBe(0);
  });

});

describe('PR reviews: platform calls for settings, per head commit', () => {
  /** A PR with `n` changed manifests: one at the root, or `n` under packages/. */
  const prDiff = (n: number): Record<string, DiffEntry> => n === 1
    ? { 'package.json': { old: BEFORE, new: AFTER } }
    : Object.fromEntries(Array.from({ length: n }, (_, i) => [`packages/p${i}/package.json`, { old: BEFORE, new: AFTER }]));

  for (const [n, calls, sent] of [[1, 4, 3], [5, 0, 0], [30, 0, 0]] as const) {
    test(`no checkout, ${n} card${n === 1 ? '' : 's'}: ${calls} API calls; over the cap every name is withheld`, async () => {
      const log: string[] = [];
      let snapshot = 's1';
      const h = host({ diff: prDiff(n), settings: remoteSource({}, log), home: tempDir() });
      h.snapshotId = () => snapshot;
      const service = createPackageChangesService(h);
      const first = (await service.get({ snapshot: null, base: undefined })).body as PackageChangesResponse;
      expect(log).toHaveLength(calls);
      expect(log.length).toBeLessThanOrEqual(REMOTE_SETTINGS_READS);
      expect(first.lookup.total).toBe(sent);
      // A new snapshot of the same head commit reads nothing again.
      snapshot = 's2';
      await service.get({ snapshot: null, base: undefined });
      expect(log).toHaveLength(calls);
    });

    test(`a checkout holding the head commit, ${n} card${n === 1 ? '' : 's'}: no API call, one listing, only existing files read`, async () => {
      const log: string[] = [];
      const local: string[] = [];
      const out = await analysis(host({
        diff: prDiff(n),
        settings: commitSource({ '.npmrc': '@acme:registry=https://npm.acme.dev/\n', 'README.md': '' }, local),
        remote: {},
        home: tempDir(),
        reads: log,
      }));
      expect(log.filter((r) => !r.endsWith('package.json'))).toEqual([]);
      expect(local).toEqual(['list', 'read:.npmrc']);
      expect(out.lookup.total).toBe(2);
    });
  }

  test('without a checkout, package files cost at most the budget: the cards that fit show, nothing is offered', async () => {
    const reads: string[] = [];
    const h = host({ diff: prDiff(15), settings: remoteSource({}), home: tempDir(), reads });
    h.prepare = async () => ({ final: true, remote: { key: 'base:head', budget: REMOTE_PACKAGE_READS } });
    const service = createPackageChangesService(h);
    const out = (await service.get({ snapshot: null, base: undefined })).body as PackageChangesResponse;
    expect(reads).toHaveLength(REMOTE_PACKAGE_READS);
    expect(out.cards).toHaveLength(REMOTE_PACKAGE_READS / 2);
    expect(out.lookup.total).toBe(0);
    expect(out.cards.every((c) => c.lookup.names.length === 0)).toBe(true);
    // The same head commit, a new snapshot: no read again, the budget stays spent.
    h.snapshotId = () => 's2';
    await service.get({ snapshot: null, base: undefined });
    expect(reads).toHaveLength(REMOTE_PACKAGE_READS);
  });

  test('a result read while the checkout was still being prepared is not kept', async () => {
    let ready = false;
    const log: string[] = [];
    const h = host({ settings: remoteSource({}, log), home: tempDir() });
    h.prepare = async () => (ready ? { final: true } : { final: false, remote: { key: 'base:head', budget: REMOTE_PACKAGE_READS } });
    const service = createPackageChangesService(h);
    await service.get({ snapshot: null, base: undefined });
    ready = true;
    h.settings = () => commitSource({ '.npmrc': '@acme:registry=https://npm.acme.dev/' });
    const out = (await service.get({ snapshot: null, base: undefined })).body as PackageChangesResponse;
    expect(out.lookup.total).toBe(2);
    // The second look read through the checkout, not the API.
    expect(log).toHaveLength(4);
  });

  test('a lockfile-only PR at the root stays at 4 calls', async () => {
    const lock = (pg: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { pg: '^8.0.0' } }, 'node_modules/pg': { version: pg } } });
    const log: string[] = [];
    const out = await analysis(host({
      diff: { 'package-lock.json': { old: lock('8.13.1'), new: lock('8.16.3') }, 'package.json': { status: 'modified', old: manifest({ pg: '^8.0.0' }), new: manifest({ pg: '^8.0.0' }) } },
      settings: remoteSource({}, log),
      home: tempDir(),
    }));
    expect(log).toHaveLength(4);
    expect(out.lookup.total).toBe(1);
  });
});

describe('a side that cannot be read', () => {
  test('a lockfile the diff changed but the server could not read is an error row, not every package removed', async () => {
    const out = await analysis(host({
      diff: {
        'package-lock.json': { old: JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { pg: '^8.13.0' } }, 'node_modules/pg': { version: '8.13.1' } } }), new: null },
      },
      settings: local(tempDir()),
      home: tempDir(),
    }));
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]).toMatchObject({ path: 'package-lock.json', changes: [], error: { side: 'new' } });
  });

  test('a failed platform read is an error row; a deleted file reads as removed', async () => {
    const failed = await analysis(host({ diff: { 'package.json': { old: BEFORE, new: 'throw' } }, settings: local(tempDir()), home: tempDir() }));
    expect(failed.cards[0]).toMatchObject({ changes: [], error: { side: 'new' } });

    const deleted = await analysis(host({ diff: { 'package.json': { status: 'deleted', old: BEFORE, new: null } }, settings: local(tempDir()), home: tempDir() }));
    expect(deleted.cards[0].error).toBeUndefined();
    expect(deleted.cards[0].changes.every((c) => c.kind === 'removed')).toBe(true);
  });
});
