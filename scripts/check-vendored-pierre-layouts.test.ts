import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { hashUpstream, manifestDifferences, parseManifest, pinnedCommit, readUpstreamMd } from './check-vendored-pierre-layouts';

describe('vendored @pierre/layouts', () => {
  test('upstream/ is byte for byte the copy UPSTREAM.md records', () => {
    const md = readUpstreamMd();
    expect(pinnedCommit(md)).toMatch(/^[0-9a-f]{40}$/);
    expect(manifestDifferences(parseManifest(md), hashUpstream())).toEqual([]);
  });

  test('an edit, a removal or an added file under upstream/ is reported', () => {
    const recorded = [
      { path: 'a.ts', sha256: '1'.repeat(64) },
      { path: 'b.ts', sha256: '2'.repeat(64) },
    ];
    const actual = [
      { path: 'a.ts', sha256: '3'.repeat(64) },
      { path: 'c.ts', sha256: '4'.repeat(64) },
    ];
    expect(manifestDifferences(recorded, actual)).toEqual(['changed: a.ts', 'missing: b.ts', 'not in the manifest: c.ts']);
  });

  test('code outside the vendor folder imports the wrapper, never upstream/', () => {
    const grep = spawnSync('git', ['grep', '-n', '-E', 'vendor-pierre-layouts/upstream', '--', ':!packages/vendor-pierre-layouts', ':!scripts/check-vendored-pierre-layouts*'], { encoding: 'utf8' });
    expect(grep.stdout).toBe('');
  });
});
