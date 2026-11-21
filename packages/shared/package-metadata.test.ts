import { beforeEach, describe, expect, test } from 'bun:test';
import { clearPackageMetadataCache, isSendable, lookupPackages, packageRouting } from './package-metadata';

const none = { npmrc: [], yarnrc: [], bunfig: [] };

describe('packageRouting: which names may leave the machine', () => {
  test('.npmrc: a scope on another registry is withheld, a scope pinned to npm is not', () => {
    const r = packageRouting({ ...none, npmrc: ['@acme:registry=https://npm.acme.dev/\n@types:registry=https://registry.npmjs.org/\n//npm.acme.dev/:_authToken=x'] });
    expect(isSendable('@acme/billing', r)).toBe(false);
    expect(isSendable('@types/node', r)).toBe(true);
    expect(isSendable('react', r)).toBe(true);
  });

  test('a default registry other than npm withholds every name, from any of the four places it can be set', () => {
    for (const r of [
      packageRouting({ ...none, npmrc: ['registry=https://artifactory.corp/api/npm/'] }),
      packageRouting({ ...none, yarnrc: ['npmRegistryServer: "https://verdaccio.corp"\n'] }),
      packageRouting({ ...none, bunfig: ['[install]\nregistry = { url = "https://bun.corp/", token = "x" }\n'] }),
      packageRouting(none, { npm_config_registry: 'https://mirror.corp/' }),
    ]) {
      expect(isSendable('react', r)).toBe(false);
      expect(isSendable('@types/node', r)).toBe(false);
    }
  });

  test('Yarn and Bun scopes count as private whatever their registry; npm mirrors stay public', () => {
    const r = packageRouting({
      npmrc: ['registry=https://registry.yarnpkg.com'],
      yarnrc: ['npmScopes:\n  acme:\n    npmRegistryServer: "https://npm.acme.dev"\n'],
      bunfig: ['[install.scopes]\n"@ledger" = { token = "$TOKEN", url = "https://npm.ledger.dev/" }\n'],
    });
    expect(isSendable('react', r)).toBe(true);
    expect(isSendable('@acme/ui', r)).toBe(false);
    expect(isSendable('@ledger/shared', r)).toBe(false);
  });

  test('.yarnrc.yml npmScopes at any indent, in flow style, with quoted keys and comments', () => {
    for (const yarnrc of [
      'npmScopes:\n    acme:\n        npmRegistryServer: "https://npm.acme.dev"\n    "@ledger":\n        npmAlwaysAuth: true\n',
      'npmScopes: { acme: { npmRegistryServer: "https://npm.acme.dev" }, "@ledger": {} }\n',
      'npmScopes:\n  {acme: {npmRegistryServer: "https://npm.acme.dev"},\n   ledger: {}}\n',
      '# settings\nnpmScopes:  # private\n\t\n  acme:\n    npmRegistryServer: https://npm.acme.dev # ours\n  ledger:\n    npmAlwaysAuth: true\n',
    ]) {
      const r = packageRouting({ ...none, yarnrc: [yarnrc] });
      expect(isSendable('@acme/ui', r)).toBe(false);
      expect(isSendable('@ledger/shared', r)).toBe(false);
      expect(isSendable('react', r)).toBe(true);
    }
  });

  test('an npmScopes this cannot read withholds every name', () => {
    for (const yarnrc of ['npmScopes: *anchor\n', 'npmScopes: { acme: {\n', 'npmScopes:\n  - acme\n']) {
      expect(isSendable('react', packageRouting({ ...none, yarnrc: [yarnrc] }))).toBe(false);
    }
  });

  test('Yarn classic .yarnrc and Bun sub-tables and inline scopes', () => {
    const classic = packageRouting({ ...none, yarnrcClassic: ['"@acme:registry" "https://npm.acme.dev/"\nregistry "https://registry.yarnpkg.com"\n'] });
    expect(isSendable('@acme/ui', classic)).toBe(false);
    expect(isSendable('react', classic)).toBe(true);
    expect(isSendable('react', packageRouting({ ...none, yarnrcClassic: ['registry "https://verdaccio.corp"'] }))).toBe(false);

    for (const bunfig of [
      '[install.scopes.acme]\nurl = "https://npm.acme.dev/"\n',
      '[install]\nscopes = { acme = "https://npm.acme.dev/", "@ledger" = { url = "https://x" } }\n',
      'install.scopes.acme = "https://npm.acme.dev/"\n',
    ]) {
      const r = packageRouting({ ...none, bunfig: [bunfig] });
      expect(isSendable('@acme/ui', r)).toBe(false);
      expect(isSendable('react', r)).toBe(true);
    }
  });

  test('environment: npm reads any npm_config_ key case-insensitively, scoped ones included', () => {
    expect(isSendable('@acme/ui', packageRouting(none, { 'npm_config_@acme:registry': 'https://npm.acme.dev/' }))).toBe(false);
    expect(isSendable('@acme/ui', packageRouting(none, { 'NPM_CONFIG_@ACME:REGISTRY': 'https://npm.acme.dev/' }))).toBe(false);
    expect(isSendable('react', packageRouting(none, { YARN_NPM_REGISTRY_SERVER: 'https://verdaccio.corp' }))).toBe(false);
    expect(isSendable('react', packageRouting(none, { YARN_NPM_SCOPES: '{}' }))).toBe(false);
    expect(isSendable('react', packageRouting(none, { npm_config_registry: 'https://registry.npmjs.org/', npm_config_user_agent: 'bun' }))).toBe(true);
  });

  test('a settings file that could not be read withholds every name', () => {
    expect(isSendable('react', packageRouting({ ...none, unreadable: true }))).toBe(false);
  });
});

function stubNpm(seen: string[], opts: { offline?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (opts.offline) throw new TypeError('fetch failed');
    if (url.includes('/downloads/point/last-week/')) {
      const names = decodeURIComponent(url.split('/last-week/')[1]).split(',');
      const one = (n: string) => (n === 'pg' ? { downloads: 43_200_837, package: 'pg' } : n === '@types/node' ? { downloads: 9, package: n } : null);
      return Response.json(names.length > 1 ? Object.fromEntries(names.map((n) => [n, one(n)])) : one(names[0]));
    }
    if (url.endsWith('/pg')) {
      return Response.json({
        'dist-tags': { latest: '8.16.3' },
        license: 'MIT',
        time: { '8.16.3': '2025-06-27T14:52:44.894Z' },
        versions: { '8.16.3': {}, '8.0.0': { deprecated: 'old' } },
      });
    }
    if (url.endsWith('/@types%2Fnode')) return Response.json({ license: 'MIT', time: {}, versions: {} });
    return Response.json({ error: 'Not found' }, { status: 404 });
  }) as typeof fetch;
}

describe('lookupPackages', () => {
  beforeEach(() => clearPackageMetadataCache());

  test('one bulk downloads request for unscoped names, one each for scoped; 404 is not-found', async () => {
    const seen: string[] = [];
    const out = await lookupPackages(
      [{ name: 'pg', version: '8.16.3' }, { name: 'left-pad-nope', version: '1.0.0' }, { name: '@types/node', version: '24.3.0' }],
      { fetchImpl: stubNpm(seen) },
    );
    expect(seen.filter((u) => u.includes('/downloads/')).sort()).toEqual([
      'https://api.npmjs.org/downloads/point/last-week/@types/node',
      'https://api.npmjs.org/downloads/point/last-week/pg,left-pad-nope',
    ]);
    const by = Object.fromEntries(out.packages.map((p) => [p.name, p]));
    expect(by.pg).toMatchObject({ status: 'ok', license: 'MIT', weeklyDownloads: 43_200_837, publishedAt: '2025-06-27T14:52:44.894Z', deprecated: null });
    expect(by['left-pad-nope'].status).toBe('not-found');
    expect(by['@types/node']).toMatchObject({ status: 'ok', weeklyDownloads: 9, publishedAt: null });
    expect(out.offline).toBe(false);
  });

  test('two versions of one package share a single packument request', async () => {
    const seen: string[] = [];
    const out = await lookupPackages([{ name: 'pg', version: '8.16.3' }, { name: 'pg', version: '8.0.0' }], { fetchImpl: stubNpm(seen) });
    expect(seen.filter((u) => u.startsWith('https://registry.npmjs.org/'))).toEqual(['https://registry.npmjs.org/pg']);
    expect(out.packages.map((p) => p.deprecated)).toEqual([null, 'old']);
  });

  test('the registry knobs accept only this machine; anything else falls back to npm', async () => {
    const seen: string[] = [];
    await lookupPackages([{ name: 'pg', version: '8.16.3' }], {
      fetchImpl: stubNpm(seen),
      env: { PLANNOTATOR_PACKAGE_REGISTRY_URL: 'https://evil.example/', PLANNOTATOR_PACKAGE_DOWNLOADS_URL: 'http://127.0.0.1:9/' },
    });
    expect(seen.sort()).toEqual(['http://127.0.0.1:9/downloads/point/last-week/pg', 'https://registry.npmjs.org/pg']);
  });

  test('no network: every row errors and the result says offline', async () => {
    const out = await lookupPackages([{ name: 'pg', version: '8.16.3' }], { fetchImpl: stubNpm([], { offline: true }) });
    expect(out).toMatchObject({ offline: true, failure: 'offline' });
    expect(out.packages[0].status).toBe('error');
  });
});
