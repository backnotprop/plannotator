import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  fetchSkillCatalog,
  getCachedSkillCatalog,
  primeSkillContentsForExport,
  resetSkillCatalogCache,
  resetSkillCatalogTransport,
  resetSkillContentTransport,
  setSkillCatalogTransport,
  setSkillContentTransport,
} from './skillCatalog';
import { skillReferenceExportBlock, type SkillCatalogEntry } from './skillReferences';

const realFetch = globalThis.fetch;

function stubFetch(impl: () => Promise<Response> | Response) {
  let calls = 0;
  globalThis.fetch = ((..._args: unknown[]) => {
    calls++;
    return Promise.resolve(impl());
  }) as typeof fetch;
  return () => calls;
}

// Reset BEFORE each test as well as after: other suites in the same process
// (e.g. packages/editor mounting App, which primes the catalog) may leave a
// cached value or an outstanding request behind. The reset invalidates both,
// so these tests hold in any file order.
beforeEach(() => {
  resetSkillCatalogCache();
  resetSkillCatalogTransport();
  resetSkillContentTransport();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetSkillCatalogCache();
  resetSkillCatalogTransport();
  resetSkillContentTransport();
});

describe('fetchSkillCatalog', () => {
  test('normalizes the payload and registers the export catalog', async () => {
    stubFetch(() =>
      Response.json({
        skills: [
          { name: 'write-better', root: 'claude', description: 'Improve prose', humanOnly: false },
          { name: 'plannotator-review', root: 'claude', humanOnly: true },
          { name: '', root: 'claude', humanOnly: false }, // dropped: no name
          { name: 'weird-root', root: 'somewhere', humanOnly: false }, // root falls back
        ],
      }),
    );

    const skills = await fetchSkillCatalog();
    expect(skills.map((s) => s.name)).toEqual(['write-better', 'plannotator-review', 'weird-root']);
    expect(skills[2].root).toBe('universal');

    // The export seam sees the same catalog.
    expect(skillReferenceExportBlock('use $write-better')).toContain('`write-better`');
  });

  test('caches within the TTL — one request for many calls', async () => {
    const calls = stubFetch(() => Response.json({ skills: [{ name: 'a', root: 'claude' }] }));
    await fetchSkillCatalog();
    await fetchSkillCatalog();
    await fetchSkillCatalog();
    expect(calls()).toBe(1);
    expect(getCachedSkillCatalog().map((s) => s.name)).toEqual(['a']);
  });

  test('endpoint missing (404) → empty catalog, no throw', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    expect(await fetchSkillCatalog()).toEqual([]);
  });

  test('network failure → empty catalog, no throw', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch;
    expect(await fetchSkillCatalog()).toEqual([]);
  });

  test('malformed payload → empty catalog', async () => {
    stubFetch(() => Response.json({ nope: true }));
    expect(await fetchSkillCatalog()).toEqual([]);
  });
});

describe('resetSkillCatalogCache', () => {
  test('invalidates an outstanding request: the next fetch consults the new backend', async () => {
    // A request is left inflight (as App.tsx's primeSkillCatalog does)…
    let resolveOld!: (r: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveOld = resolve;
      })) as unknown as typeof fetch;
    const oldPromise = fetchSkillCatalog();

    // …then the cache is reset and a different backend is stubbed.
    resetSkillCatalogCache();
    stubFetch(() => Response.json({ skills: [{ name: 'fresh', root: 'claude' }] }));

    const skills = await fetchSkillCatalog();
    expect(skills.map((s) => s.name)).toEqual(['fresh']);

    // The old request finally lands: it must not overwrite the newer value
    // or the export registry.
    resolveOld(Response.json({ skills: [{ name: 'stale', root: 'claude' }] }));
    await oldPromise;
    expect(getCachedSkillCatalog().map((s) => s.name)).toEqual(['fresh']);
    expect(skillReferenceExportBlock('use $fresh')).toContain('`fresh`');
    expect(skillReferenceExportBlock('use $stale')).toBe('');
  });

  test('a request outstanding at reset resolves without reviving dead cache state', async () => {
    let resolveOld!: (r: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveOld = resolve;
      })) as unknown as typeof fetch;
    const oldPromise = fetchSkillCatalog();

    resetSkillCatalogCache();
    resolveOld(Response.json({ skills: [{ name: 'ghost', root: 'claude' }] }));
    await oldPromise;

    expect(getCachedSkillCatalog()).toEqual([]);
    expect(skillReferenceExportBlock('use $ghost')).toBe('');
  });
});

describe('skillCatalogTransport seam', () => {
  test('a host transport replaces the default fetch, with the same normalization', async () => {
    const calls = stubFetch(() => Response.json({ skills: [{ name: 'via-fetch', root: 'claude' }] }));
    setSkillCatalogTransport(async () => [
      { name: 'host-skill', root: 'claude', humanOnly: false },
      { name: '', root: 'claude', humanOnly: false } as SkillCatalogEntry, // dropped
    ]);

    const skills = await fetchSkillCatalog();
    expect(skills.map((s) => s.name)).toEqual(['host-skill']);
    expect(calls()).toBe(0); // fetch never consulted

    resetSkillCatalogTransport();
    resetSkillCatalogCache();
    expect((await fetchSkillCatalog()).map((s) => s.name)).toEqual(['via-fetch']);
  });

  test('a throwing host transport degrades to an empty catalog', async () => {
    setSkillCatalogTransport(() => Promise.reject(new Error('host boom')));
    expect(await fetchSkillCatalog()).toEqual([]);
  });
});

describe('primeSkillContentsForExport', () => {
  const HUMAN_ONLY_CATALOG = [
    { name: 'write-better', root: 'claude', humanOnly: false },
    {
      name: 'plannotator-review',
      root: 'claude',
      humanOnly: true,
      dir: '/skills/plannotator-review',
    },
  ];

  function stubCatalogAndContent() {
    setSkillCatalogTransport(async () => HUMAN_ONLY_CATALOG as SkillCatalogEntry[]);
    const requested: string[] = [];
    setSkillContentTransport(async (name) => {
      requested.push(name);
      return {
        name,
        dir: `/skills/${name}`,
        path: `/skills/${name}/SKILL.md`,
        content: `# Instructions for ${name}`,
        truncated: false,
        humanOnly: true,
      };
    });
    return requested;
  }

  test('fetches only the HUMAN-ONLY skills the texts reference, and registers them for export', async () => {
    const requested = stubCatalogAndContent();
    const changed = await primeSkillContentsForExport([
      'Use /write-better and $plannotator-review.',
      undefined,
      'plain comment',
    ]);
    expect(changed).toBe(true);
    // Lazy: the model-invocable skill is never fetched.
    expect(requested).toEqual(['plannotator-review']);

    const block = skillReferenceExportBlock('Run $plannotator-review.');
    expect(block).toContain('--- BEGIN SKILL INSTRUCTIONS: plannotator-review ---');
    expect(block).toContain('# Instructions for plannotator-review');
  });

  test('one request per skill per session, however often priming re-runs', async () => {
    const requested = stubCatalogAndContent();
    await primeSkillContentsForExport(['$plannotator-review']);
    await primeSkillContentsForExport(['$plannotator-review again']);
    await primeSkillContentsForExport(['$plannotator-review and /write-better']);
    expect(requested).toEqual(['plannotator-review']);
  });

  test('edge-triggered: a re-prime with already-registered content resolves false', async () => {
    stubCatalogAndContent();
    expect(await primeSkillContentsForExport(['$plannotator-review'])).toBe(true);
    // The content stays registered — but it is no longer news, so re-priming
    // must not signal "changed" again (a level-triggered true here re-render
    // looped App.tsx's generation-bump effect).
    expect(await primeSkillContentsForExport(['$plannotator-review'])).toBe(false);
    expect(await primeSkillContentsForExport(['$plannotator-review again'])).toBe(false);

    const block = skillReferenceExportBlock('Run $plannotator-review.');
    expect(block).toContain('# Instructions for plannotator-review');
  });

  test('edge-triggered: a later prime that lands a NEW skill reports true exactly once', async () => {
    setSkillCatalogTransport(async () => [
      { name: 'alpha', root: 'claude', humanOnly: true, dir: '/skills/alpha' },
      { name: 'beta', root: 'claude', humanOnly: true, dir: '/skills/beta' },
    ] as SkillCatalogEntry[]);
    setSkillContentTransport(async (name) => ({
      name,
      dir: `/skills/${name}`,
      path: `/skills/${name}/SKILL.md`,
      content: `# ${name}`,
      truncated: false,
      humanOnly: true,
    }));

    expect(await primeSkillContentsForExport(['$alpha'])).toBe(true);
    expect(await primeSkillContentsForExport(['$alpha'])).toBe(false);
    // beta's content landing is one new edge; alpha stays silent.
    expect(await primeSkillContentsForExport(['$alpha and $beta'])).toBe(true);
    expect(await primeSkillContentsForExport(['$alpha and $beta'])).toBe(false);
  });

  test('a cache reset re-arms the changed signal for the next session', async () => {
    stubCatalogAndContent();
    expect(await primeSkillContentsForExport(['$plannotator-review'])).toBe(true);
    resetSkillCatalogCache();
    expect(await primeSkillContentsForExport(['$plannotator-review'])).toBe(true);
    expect(await primeSkillContentsForExport(['$plannotator-review'])).toBe(false);
  });

  test('no human-only references → no requests, resolves false', async () => {
    const requested = stubCatalogAndContent();
    expect(await primeSkillContentsForExport(['Use /write-better only.'])).toBe(false);
    expect(requested).toEqual([]);
  });

  test('a failing content transport degrades to the name + directory fallback, never throws', async () => {
    setSkillCatalogTransport(async () => HUMAN_ONLY_CATALOG as SkillCatalogEntry[]);
    setSkillContentTransport(() => Promise.reject(new Error('gone')));
    expect(await primeSkillContentsForExport(['$plannotator-review'])).toBe(false);

    const block = skillReferenceExportBlock('Run $plannotator-review.');
    expect(block).toContain('read SKILL.md in /skills/plannotator-review and follow it');
    expect(block).not.toContain('BEGIN SKILL INSTRUCTIONS');
  });

  test('a malformed content payload is treated as no content', async () => {
    setSkillCatalogTransport(async () => HUMAN_ONLY_CATALOG as SkillCatalogEntry[]);
    setSkillContentTransport(async () => ({ nope: true }));
    expect(await primeSkillContentsForExport(['$plannotator-review'])).toBe(false);
    expect(skillReferenceExportBlock('$plannotator-review')).not.toContain(
      'BEGIN SKILL INSTRUCTIONS',
    );
  });

  test('a reset while a content request is outstanding keeps it from writing dead state', async () => {
    setSkillCatalogTransport(async () => HUMAN_ONLY_CATALOG as SkillCatalogEntry[]);
    let resolveContent!: (value: unknown) => void;
    setSkillContentTransport(
      () =>
        new Promise((resolve) => {
          resolveContent = resolve;
        }),
    );
    const pending = primeSkillContentsForExport(['$plannotator-review']);
    // The content request starts after the (async) catalog fetch resolves.
    while (!resolveContent) await Bun.sleep(0);

    resetSkillCatalogCache();
    resolveContent({
      name: 'plannotator-review',
      dir: '/skills/plannotator-review',
      path: '/skills/plannotator-review/SKILL.md',
      content: '# ghost',
      truncated: false,
    });
    await pending;

    // The reset cleared the export catalog, so the block is empty…
    expect(skillReferenceExportBlock('$plannotator-review')).toBe('');

    // …and after the catalog comes back, the dead request's body must NOT
    // have been revived into the content registry.
    await fetchSkillCatalog();
    const block = skillReferenceExportBlock('$plannotator-review');
    expect(block).not.toContain('# ghost');
    expect(block).toContain('read SKILL.md in /skills/plannotator-review and follow it');
  });
});
