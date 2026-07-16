import { describe, expect, test } from 'bun:test';
import type { EnabledSourceSaveCapability, SavedFileChangeDraftData } from './editableDocuments';
import { validateSavedFileChanges } from './savedFileChangeValidation';
import type { SourceSaveProbeResult } from './sourceDocumentClient';

function sourceSave(hash: string): EnabledSourceSaveCapability {
  return {
    enabled: true,
    kind: 'local-text-file',
    scope: 'folder-file',
    path: '/repo/docs/a.md',
    basename: 'a.md',
    language: 'markdown',
    hash,
    mtimeMs: hash === 'sha256:after' ? 1000 : 2000,
    size: 12,
    eol: 'lf',
  };
}

function change(overrides: Partial<SavedFileChangeDraftData> = {}): SavedFileChangeDraftData {
  return {
    key: 'file:/repo/docs/a.md',
    path: '/repo/docs/a.md',
    basename: 'a.md',
    beforeText: 'before\n',
    afterText: 'after\n',
    beforeHash: 'sha256:before',
    afterHash: 'sha256:after',
    sourceSave: sourceSave('sha256:after'),
    ...overrides,
  };
}

describe('validateSavedFileChanges', () => {
  test('keeps a saved edit only when disk still matches the saved hash', async () => {
    const freshSource = sourceSave('sha256:after');
    const result = await validateSavedFileChanges([change({ afterHash: undefined })], async () => ({
      status: 'ok',
      sourceSave: freshSource,
    }));

    expect(result.dropped).toEqual([]);
    expect(result.unverified).toEqual([]);
    expect(result.valid).toEqual([{
      ...change({ afterHash: undefined }),
      sourceSave: freshSource,
      afterHash: freshSource.hash,
    }]);
  });

  test('drops confirmed stale, missing, and no-op edits without dropping unverified edits', async () => {
    const stale = change({ key: 'stale' });
    const missing = change({ key: 'missing' });
    const noop = change({ key: 'noop', afterText: 'before\n' });
    const unavailable = change({ key: 'unavailable' });
    const probes = new Map<string, SourceSaveProbeResult>([
      ['stale', { status: 'ok', sourceSave: sourceSave('sha256:external') }],
      ['missing', { status: 'missing' }],
      ['unavailable', { status: 'unavailable' }],
    ]);
    const probed: string[] = [];

    const result = await validateSavedFileChanges(
      [stale, missing, noop, unavailable],
      async (entry) => {
        probed.push(entry.key);
        return probes.get(entry.key) ?? { status: 'unavailable' };
      },
    );

    expect(result.valid).toEqual([]);
    expect(result.unverified).toEqual([unavailable]);
    expect(result.dropped).toEqual([
      { change: stale, reason: 'changed' },
      { change: missing, reason: 'missing' },
      { change: noop, reason: 'noop' },
    ]);
    expect(probed).toEqual(['stale', 'missing', 'unavailable']);
  });
});
