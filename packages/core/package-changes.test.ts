import { describe, expect, test } from 'bun:test';
import {
  analyzePackageChanges,
  packageChangeReads,
  packageFileKind,
  type PackageChangeCard,
  type PackageFileSide,
  type PackageSourceFile,
} from './package-changes';
import { classifyNpmSpec, compareSemver, rangeFloor, readBunLock, readPnpmLock, readYarnLock } from './package-changes-npm';

const manifest = (o: Record<string, Record<string, string>>) => JSON.stringify({ name: 'app', version: '1.0.0', ...o }, null, 2);
const file = (path: string, old: PackageFileSide, next: PackageFileSide, inDiff = true): PackageSourceFile => ({ path, old, new: next, inDiff });
const rows = (card: PackageChangeCard | undefined) => Object.fromEntries((card?.changes ?? []).map((c) => [c.workspace ? `${c.workspace}:${c.name}` : c.name, c]));

describe('manifest only (no lockfile in the diff)', () => {
  test('reads every kind of change, breaking steps first', () => {
    const before = manifest({
      dependencies: { pg: '^8.13.0', zod: '^3.23.8', lodash: '^4.17.21', react: '^18.3.1', 'left-pad': '1.3.0' },
      devDependencies: { typescript: '~5.6.2' },
    });
    const after = manifest({
      dependencies: { pg: '^8.16.3', zod: '^4.0.5', react: '^18.3.1', 'left-pad': '1.1.0', kysely: '^0.28.2' },
      devDependencies: { typescript: '~5.6.2', lodash: '^4.17.21' },
    });
    const [card] = analyzePackageChanges([file('package.json', before, after)]);
    const by = rows(card);
    expect(card.lockfile).toBeNull();
    expect(by.pg).toMatchObject({ kind: 'upgraded', beforeVersion: '8.13.0', afterVersion: '8.16.3', major: false });
    expect(by.zod).toMatchObject({ kind: 'upgraded', major: true });
    expect(by['left-pad']).toMatchObject({ kind: 'downgraded' });
    expect(by.kysely).toMatchObject({ kind: 'added', afterVersion: '0.28.2' });
    expect(by.lodash).toMatchObject({ kind: 'moved', section: 'devDependencies', previousSection: 'dependencies' });
    expect(by.react).toBeUndefined();
    expect(card.changes[0].name).toBe('zod');
  });

  test('non-registry specs get no version and no lookup name; an alias looks up its target', () => {
    const [card] = analyzePackageChanges([file('package.json',
      manifest({ dependencies: { a: '^0.27.0', b: 'workspace:*', c: 'github:me/c', d: 'npm:real-d@^1.0.0' } }),
      manifest({ dependencies: { a: '^0.28.0', b: 'workspace:^', c: 'github:me/c#v2', d: 'npm:real-d@^2.0.0' } }),
    )]);
    const by = rows(card);
    expect(by.a).toMatchObject({ kind: 'upgraded', major: true });
    expect(by.b).toMatchObject({ kind: 'changed', registryName: null, afterVersion: null });
    expect(by.c).toMatchObject({ kind: 'changed', registryName: null });
    expect(by.d).toMatchObject({ registryName: 'real-d', afterVersion: '2.0.0', major: true });
  });

  test('a manifest that is not JSON yields an error card, an unchanged dependency list yields none', () => {
    const cards = analyzePackageChanges([
      file('a/package.json', manifest({}), '{ nope'),
      file('b/package.json', manifest({ dependencies: { x: '1.0.0' } }), JSON.stringify({ name: 'renamed', dependencies: { x: '1.0.0' } })),
    ]);
    expect(cards.map((c) => c.path)).toEqual(['a/package.json']);
    expect(cards[0].error).toEqual({ side: 'new', reason: 'not valid JSON' });
  });

  test('an added manifest lists every dependency as added', () => {
    const [card] = analyzePackageChanges([file('tools/package.json', null, manifest({ dependencies: { tsx: '^4.20.0' } }))]);
    expect(rows(card).tsx).toMatchObject({ kind: 'added', afterVersion: '4.20.0' });
  });
});

const packageLock = (root: Record<string, Record<string, string>>, installed: Record<string, string | { version: string; link?: boolean }>, extra: Record<string, unknown> = {}) => JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', ...root },
    ...extra,
    ...Object.fromEntries(Object.entries(installed).map(([k, v]) => [k, typeof v === 'string' ? { version: v } : v])),
  },
}, null, 2);

describe('package.json with package-lock.json', () => {
  test('rows show the locked versions, a bump inside the same range is still a row, and indirect packages are counted', () => {
    const oldManifest = manifest({ dependencies: { pg: '^8.13.0', zod: '^3.23.8' } });
    const newManifest = manifest({ dependencies: { pg: '^8.16.3', zod: '^3.23.8', kysely: '^0.28.0' } });
    const oldLock = packageLock({ dependencies: { pg: '^8.13.0', zod: '^3.23.8' } }, {
      'node_modules/pg': '8.13.1', 'node_modules/zod': '3.23.8', 'node_modules/pg-pool': '3.7.0', 'node_modules/buffer-writer': '2.0.0',
    });
    const newLock = packageLock({ dependencies: { pg: '^8.16.3', zod: '^3.23.8', kysely: '^0.28.0' } }, {
      'node_modules/pg': '8.16.3', 'node_modules/zod': '3.25.76', 'node_modules/kysely': '0.28.5', 'node_modules/pg-pool': '3.10.1',
    });
    const cards = analyzePackageChanges([
      file('package.json', oldManifest, newManifest),
      file('package-lock.json', oldLock, newLock),
    ]);
    expect(cards.map((c) => c.path)).toEqual(['package.json']);
    const [card] = cards;
    expect(card.lockfile).toBe('package-lock.json');
    const by = rows(card);
    expect(by.pg).toMatchObject({ beforeVersion: '8.13.1', afterVersion: '8.16.3', kind: 'upgraded' });
    expect(by.zod).toMatchObject({ before: '^3.23.8', after: '^3.23.8', beforeVersion: '3.23.8', afterVersion: '3.25.76', kind: 'upgraded' });
    expect(by.kysely).toMatchObject({ kind: 'added', afterVersion: '0.28.5' });
    expect(card.indirect).toEqual([
      { name: 'buffer-writer', before: ['2.0.0'], after: [] },
      { name: 'pg-pool', before: ['3.7.0'], after: ['3.10.1'] },
    ]);
  });

  test('a lockfile-only diff (a Dependabot bump) gets its own card on the lockfile', () => {
    const root = { dependencies: { express: '^4.21.0' } };
    const cards = analyzePackageChanges([
      file('package-lock.json',
        packageLock(root, { 'node_modules/express': '4.21.0', 'node_modules/qs': '6.13.0' }),
        packageLock(root, { 'node_modules/express': '4.21.2', 'node_modules/qs': '6.13.1' })),
      file('package.json', manifest(root), manifest(root), false),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ path: 'package-lock.json', role: 'lockfile', lockfile: 'package-lock.json' });
    expect(rows(cards[0]).express).toMatchObject({ kind: 'upgraded', beforeVersion: '4.21.0', afterVersion: '4.21.2' });
    expect(cards[0].indirect.map((i) => i.name)).toEqual(['qs']);
  });

  test('workspaces: a changed workspace manifest resolves through the root lockfile; other workspaces land on the closest card', () => {
    const oldLock = packageLock({ workspaces: ['apps/*'] as unknown as Record<string, string> }, {
      'node_modules/react': '18.3.1', 'node_modules/next': '14.2.3', 'apps/web/node_modules/zod': '3.23.8',
    }, {
      'apps/web': { name: 'web', dependencies: { react: '^18.3.1', next: '^14.2.0', zod: '^3.23.0' } },
      'apps/api': { name: 'api', dependencies: { hono: '^4.6.0' } },
      'node_modules/hono': { version: '4.6.0' },
    });
    const newLock = packageLock({ workspaces: ['apps/*'] as unknown as Record<string, string> }, {
      'node_modules/react': '19.1.0', 'node_modules/next': '15.5.2', 'apps/web/node_modules/zod': '3.23.8',
    }, {
      'apps/web': { name: 'web', dependencies: { react: '^19.1.0', next: '^15.5.0', zod: '^3.23.0' } },
      'apps/api': { name: 'api', dependencies: { hono: '^4.6.0' } },
      'node_modules/hono': { version: '4.9.1' },
    });
    const cards = analyzePackageChanges([
      file('apps/web/package.json',
        manifest({ dependencies: { react: '^18.3.1', next: '^14.2.0', zod: '^3.23.0' } }),
        manifest({ dependencies: { react: '^19.1.0', next: '^15.5.0', zod: '^3.23.0' } })),
      file('package-lock.json', oldLock, newLock),
    ]);
    expect(cards.map((c) => c.path)).toEqual(['apps/web/package.json']);
    const by = rows(cards[0]);
    expect(by.react).toMatchObject({ afterVersion: '19.1.0', major: true });
    expect(by.zod).toBeUndefined();
    expect(by['apps/api:hono']).toMatchObject({ kind: 'upgraded', beforeVersion: '4.6.0', afterVersion: '4.9.1', workspace: 'apps/api' });
  });

  test('a workspace package the lockfile links is never a registry name, whatever its spec', () => {
    const root = (shared: string) => ({ dependencies: { '@ledger/shared': shared } });
    const [card] = analyzePackageChanges([
      file('package.json', manifest({ dependencies: {} }), manifest(root('*'))),
      file('package-lock.json',
        packageLock({}, {}, { 'packages/shared': { name: '@ledger/shared', version: '0.1.0' } }),
        packageLock(root('*'), { 'node_modules/@ledger/shared': { version: '0.1.0', link: true } }, { 'packages/shared': { name: '@ledger/shared', version: '0.1.0' } })),
    ]);
    expect(rows(card)['@ledger/shared']).toMatchObject({ kind: 'added', registryName: null, source: 'workspace' });
  });

  test('a lockfile that does not parse leaves the manifest on its ranges and says so under itself', () => {
    const cards = analyzePackageChanges([
      file('package.json', manifest({ dependencies: { pg: '^8.13.0' } }), manifest({ dependencies: { pg: '^8.16.3' } })),
      file('package-lock.json', '{}', '<<<<<<< HEAD'),
    ]);
    const card = cards.find((c) => c.path === 'package.json')!;
    expect(card.lockfile).toBeNull();
    expect(rows(card).pg).toMatchObject({ afterVersion: '8.16.3' });
    expect(cards.find((c) => c.path === 'package-lock.json')).toMatchObject({ role: 'lockfile', changes: [], error: { side: 'new' } });
  });
});

describe('bun.lock', () => {
  const bunLock = (deps: Record<string, string>, packages: Record<string, string>, web?: { deps: Record<string, string>; own?: Record<string, string> }) => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": ${JSON.stringify(deps)},
    },${web ? `
    "apps/web": {
      "name": "web",
      "dependencies": ${JSON.stringify(web.deps)},
    },` : ''}
  },
  "packages": {
${Object.entries({ ...packages, ...(web?.own ?? {}) }).map(([k, v]) => `    "${k}": ["${v}", "", {}, "sha512-x,y"],`).join('\n')}
    "web": ["web@workspace:apps/web"],
  },
}
`;

  test('reads trailing commas, workspace-own copies and indirect changes', () => {
    const oldLock = bunLock({ zod: '^3.23.0' }, { zod: 'zod@3.23.8', tslib: 'tslib@2.6.0' }, { deps: { react: '^18.3.1' }, own: { react: 'react@18.3.1' } });
    const newLock = bunLock({ zod: '^4.1.0' }, { zod: 'zod@4.1.5', tslib: 'tslib@2.8.1' }, { deps: { react: '^18.3.1' }, own: { 'web/react': 'react@18.3.2', react: 'react@18.3.1' } });
    const cards = analyzePackageChanges([
      file('package.json', manifest({ dependencies: { zod: '^3.23.0' } }), manifest({ dependencies: { zod: '^4.1.0' } })),
      file('bun.lock', oldLock, newLock),
    ]);
    const by = rows(cards[0]);
    expect(by.zod).toMatchObject({ beforeVersion: '3.23.8', afterVersion: '4.1.5', major: true });
    expect(by['apps/web:react']).toMatchObject({ beforeVersion: '18.3.1', afterVersion: '18.3.2' });
    expect(cards[0].indirect).toEqual([{ name: 'tslib', before: ['2.6.0'], after: ['2.8.1'] }]);
  });
});

describe('pnpm-lock.yaml', () => {
  const pnpm = (react: string, scheduler: string) => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      react:
        specifier: ^${react.split('.')[0]}.0.0
        version: ${react}
    devDependencies:
      '@types/react':
        specifier: ^19.0.0
        version: 19.1.2(react@${react})

  packages/ui:
    dependencies:
      shared:
        specifier: workspace:*
        version: link:../shared

packages:

  '@types/react@19.1.2':
    resolution: {integrity: sha512-x}

  react@${react}:
    resolution: {integrity: sha512-x}

  scheduler@${scheduler}:
    resolution: {integrity: sha512-x}

snapshots:

  react@${react}: {}
`;

  test('importers, peer suffixes and links', () => {
    const before = readPnpmLock(pnpm('18.3.1', '0.23.2'));
    if (typeof before === 'string') throw new Error(before);
    expect(before.importers.get('')?.get('@types/react')?.get('devDependencies')).toEqual({ spec: '^19.0.0', version: '19.1.2' });
    expect(before.importers.get('packages/ui')?.get('shared')?.get('dependencies')).toEqual({ spec: 'workspace:*', version: null });
    const [card] = analyzePackageChanges([file('pnpm-lock.yaml', pnpm('18.3.1', '0.23.2'), pnpm('19.1.0', '0.26.0'))]);
    expect(card).toMatchObject({ path: 'pnpm-lock.yaml', role: 'lockfile' });
    expect(rows(card).react).toMatchObject({ kind: 'upgraded', beforeVersion: '18.3.1', afterVersion: '19.1.0', major: true });
    expect(card.indirect).toEqual([{ name: 'scheduler', before: ['0.23.2'], after: ['0.26.0'] }]);
  });

  test('a v5 lockfile is refused rather than misread', () => {
    expect(readPnpmLock('lockfileVersion: 5.4\n')).toBe('pnpm lockfile older than v6');
  });
});

describe('yarn.lock', () => {
  test('classic: direct dependencies come from the manifest beside it', () => {
    const lock = (lodash: string, ms: string) => `# THIS IS AN AUTOGENERATED FILE.
# yarn lockfile v1


"@scope/pkg@^1.0.0":
  version "1.0.0"

lodash@^4.17.0, lodash@^4.17.21:
  version "${lodash}"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-${lodash}.tgz"

ms@2.1.2:
  version "${ms}"
`;
    const pkg = manifest({ dependencies: { lodash: '^4.17.21', '@scope/pkg': '^1.0.0' } });
    const cards = analyzePackageChanges([
      file('yarn.lock', lock('4.17.20', '2.1.2'), lock('4.17.21', '2.1.3')),
      file('package.json', pkg, pkg, false),
    ]);
    expect(rows(cards[0]).lodash).toMatchObject({ beforeVersion: '4.17.20', afterVersion: '4.17.21' });
    expect(cards[0].indirect.map((i) => i.name)).toEqual(['ms']);
  });

  test('berry: quoted descriptor lists and npm: protocols', () => {
    const idx = readYarnLock(`__metadata:
  version: 8

"lodash@npm:^4.17.0, lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"

"app@workspace:.":
  version: 0.0.0-use.local
`);
    if (typeof idx === 'string') throw new Error(idx);
    expect(idx.resolve?.('lodash', '^4.17.21')).toBe('4.17.21');
    expect([...idx.packages.keys()]).toEqual(['lodash']);
  });
});

describe('unreadable sides', () => {
  const root = { dependencies: { express: '^4.21.0', pg: '^8.13.0' } };
  const lock = packageLock(root, { 'node_modules/express': '4.21.0', 'node_modules/pg': '8.13.1' });

  test('a lockfile the server could not read is an error row, never every package removed', () => {
    const cards = analyzePackageChanges([
      file('package-lock.json', lock, { unreadable: 'too large' }),
      file('package.json', manifest(root), manifest(root), false),
    ]);
    expect(cards).toEqual([expect.objectContaining({ path: 'package-lock.json', changes: [], indirect: [], error: { side: 'new', reason: 'too large' } })]);
  });

  test('a manifest side that could not be read is an error row', () => {
    const cards = analyzePackageChanges([file('package.json', { unreadable: 'could not be read' }, manifest(root))]);
    expect(cards).toEqual([expect.objectContaining({ path: 'package.json', changes: [], error: { side: 'old', reason: 'could not be read' } })]);
  });

  test('a yarn.lock whose manifest cannot be read says so instead of listing every package as indirect', () => {
    const yarn = (v: string) => `# yarn lockfile v1\n\nlodash@^4.17.0:\n  version "${v}"\n`;
    for (const companion of [file('package.json', null, null, false), file('package.json', { unreadable: 'x' }, { unreadable: 'x' }, false)]) {
      const cards = analyzePackageChanges([file('yarn.lock', yarn('4.17.20'), yarn('4.17.21')), companion]);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ path: 'yarn.lock', changes: [], indirect: [] });
      expect(cards[0].error).toBeDefined();
    }
  });
});

describe('lockfile hosts: a package fetched from anywhere but npm is marked private', () => {
  const pkg = (deps: Record<string, string>) => manifest({ dependencies: deps });

  test('package-lock.json `resolved`', () => {
    const before = { dependencies: { '@acme/ui': '^1.0.0', pg: '^8.13.0' } };
    const after = { dependencies: { '@acme/ui': '^1.1.0', pg: '^8.16.3' } };
    const cards = analyzePackageChanges([
      file('package.json', pkg(before.dependencies), pkg(after.dependencies)),
      file('package-lock.json',
        packageLock(before, {
          'node_modules/@acme/ui': { version: '1.0.0', resolved: 'https://npm.acme.dev/@acme/ui/-/ui-1.0.0.tgz' } as never,
          'node_modules/pg': { version: '8.13.1', resolved: 'https://registry.npmjs.org/pg/-/pg-8.13.1.tgz' } as never,
        }),
        packageLock(after, {
          'node_modules/@acme/ui': { version: '1.1.0', resolved: 'https://npm.acme.dev/@acme/ui/-/ui-1.1.0.tgz' } as never,
          'node_modules/pg': { version: '8.16.3', resolved: 'https://registry.npmjs.org/pg/-/pg-8.16.3.tgz' } as never,
        })),
    ]);
    const by = rows(cards[0]);
    expect(by['@acme/ui'].privateSource).toBe(true);
    expect(by.pg.privateSource).toBeUndefined();
  });

  test('yarn.lock `resolved`, pnpm `tarball`, bun.lock registry slot', () => {
    const yarn = readYarnLock(`# yarn lockfile v1\n\n"@acme/ui@^1.0.0":\n  version "1.1.0"\n  resolved "https://npm.acme.dev/@acme/ui/-/ui-1.1.0.tgz#abc"\n\nlodash@^4.17.0:\n  version "4.17.21"\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"\n`);
    if (typeof yarn === 'string') throw new Error(yarn);
    expect([...yarn.privateNames!]).toEqual(['@acme/ui']);

    const pnpm = readPnpmLock(`lockfileVersion: '9.0'\n\npackages:\n\n  '@acme/ui@1.1.0':\n    resolution: {integrity: sha512-x, tarball: https://npm.acme.dev/@acme/ui/-/ui-1.1.0.tgz}\n\n  react@19.1.0:\n    resolution: {integrity: sha512-x}\n\n  internal@1.0.0:\n    resolution:\n      tarball: https://artifactory.corp/internal-1.0.0.tgz\n`);
    if (typeof pnpm === 'string') throw new Error(pnpm);
    expect([...pnpm.privateNames!].sort()).toEqual(['@acme/ui', 'internal']);

    const bun = readBunLock(`{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "app", "dependencies": { "@acme/ui": "^1.0.0", "zod": "^4.0.0" } } },\n  "packages": {\n    "@acme/ui": ["@acme/ui@1.1.0", "https://npm.acme.dev/", {}, "sha512-x"],\n    "zod": ["zod@4.1.5", "", {}, "sha512-x"],\n  },\n}\n`);
    if (typeof bun === 'string') throw new Error(bun);
    expect([...bun.privateNames!]).toEqual(['@acme/ui']);
  });
});

describe('paths and versions', () => {
  test('which files are read', () => {
    expect(packageFileKind('node_modules/x/package.json')).toBeNull();
    expect(packageFileKind('apps/web/package.json')?.role).toBe('manifest');
    expect(packageFileKind('pnpm-lock.yaml')?.role).toBe('lockfile');
    expect(packageFileKind('src/index.ts')).toBeNull();
    expect(packageChangeReads(['yarn.lock', 'src/a.ts', 'apps/web/package.json'])).toEqual([
      { path: 'yarn.lock', inDiff: true },
      { path: 'apps/web/package.json', inDiff: true },
      { path: 'package.json', inDiff: false },
    ]);
  });

  test('semver order and range floors', () => {
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('2.0.0', '10.0.0')).toBe(-1);
    expect(rangeFloor('>=18 <20')).toBe('18');
    expect(rangeFloor('~5.6.2')).toBe('5.6.2');
    expect(classifyNpmSpec('next', 'canary')).toMatchObject({ source: 'tag', floor: null });
  });
});
