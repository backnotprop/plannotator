import { afterEach, describe, expect, test } from 'bun:test';
import { fetchSourceDocumentSnapshot, probeSourceSave } from './sourceDocumentClient';

const originalFetch = globalThis.fetch;

function mockFetch(response: Response | Error) {
  globalThis.fetch = (async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('source document client', () => {
  test('probes source-save metadata from /api/doc', async () => {
    mockFetch(Response.json({
      sourceSave: {
        enabled: true,
        kind: 'local-text-file',
        scope: 'folder-file',
        path: '/repo/docs/a.md',
        basename: 'a.md',
        language: 'markdown',
        hash: 'sha256:after',
        mtimeMs: 1000,
        size: 6,
        eol: 'lf',
      },
    }));

    expect(await probeSourceSave('/repo/docs/a.md')).toEqual({
      status: 'ok',
      sourceSave: {
        enabled: true,
        kind: 'local-text-file',
        scope: 'folder-file',
        path: '/repo/docs/a.md',
        basename: 'a.md',
        language: 'markdown',
        hash: 'sha256:after',
        mtimeMs: 1000,
        size: 6,
        eol: 'lf',
      },
    });
  });

  test('distinguishes missing and unavailable source probes', async () => {
    mockFetch(new Response('missing', { status: 404 }));
    expect(await probeSourceSave('/repo/docs/missing.md')).toEqual({ status: 'missing' });

    mockFetch(new Error('network'));
    expect(await probeSourceSave('/repo/docs/a.md')).toEqual({ status: 'unavailable' });
  });

  test('fetches markdown source snapshots and rejects html documents', async () => {
    mockFetch(Response.json({
      markdown: 'after\n',
      sourceSave: {
        enabled: true,
        kind: 'local-text-file',
        scope: 'folder-file',
        path: '/repo/docs/a.md',
        basename: 'a.md',
        language: 'markdown',
        hash: 'sha256:after',
        mtimeMs: 1000,
        size: 6,
        eol: 'lf',
      },
    }));
    expect(await fetchSourceDocumentSnapshot('/repo/docs/a.md')).toEqual({
      status: 'ok',
      snapshot: {
        markdown: 'after\n',
        sourceSave: {
          enabled: true,
          kind: 'local-text-file',
          scope: 'folder-file',
          path: '/repo/docs/a.md',
          basename: 'a.md',
          language: 'markdown',
          hash: 'sha256:after',
          mtimeMs: 1000,
          size: 6,
          eol: 'lf',
        },
      },
    });

    mockFetch(Response.json({ markdown: '<p>after</p>', renderAs: 'html' }));
    expect(await fetchSourceDocumentSnapshot('/repo/docs/a.html')).toEqual({ status: 'unavailable' });
  });

  test('distinguishes missing and unavailable source snapshots', async () => {
    mockFetch(new Response('missing', { status: 404 }));
    expect(await fetchSourceDocumentSnapshot('/repo/docs/missing.md')).toEqual({ status: 'missing' });

    mockFetch(new Error('network'));
    expect(await fetchSourceDocumentSnapshot('/repo/docs/a.md')).toEqual({ status: 'unavailable' });
  });
});
