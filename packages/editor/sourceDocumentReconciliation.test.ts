import { describe, expect, test } from 'bun:test';
import type { SourceDocumentSnapshotResult } from './sourceDocumentClient';
import {
  reconcileSourceDocuments,
  type OpenSourceDocumentRecord,
} from './sourceDocumentReconciliation';
import type { EditableDocumentRecord, EnabledSourceSaveCapability } from './editableDocuments';

function sourceSave(hash: string, text = 'after\n'): EnabledSourceSaveCapability {
  return {
    enabled: true,
    kind: 'local-text-file',
    scope: 'folder-file',
    path: '/repo/docs/a.md',
    basename: 'a.md',
    language: 'markdown',
    hash,
    mtimeMs: hash === 'sha256:after' ? 1000 : 2000,
    size: text.length,
    eol: 'lf',
  };
}

function record(source = sourceSave('sha256:after'), text = 'after\n'): OpenSourceDocumentRecord {
  return {
    key: 'file:/repo/docs/a.md',
    path: source.path,
    basename: source.basename,
    sourceSave: source,
    sessionOpenText: text,
    sessionOpenHash: source.hash,
    diskBaseline: text,
    currentText: text,
    editMountText: text,
    saveStatus: 'clean',
    lastKnownHash: source.hash,
    lastKnownMtimeMs: source.mtimeMs,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('reconcileSourceDocuments', () => {
  test('ignores an older disk read after a newer reconcile starts', async () => {
    let current: EditableDocumentRecord = record();
    const oldFetch = deferred<SourceDocumentSnapshotResult>();
    const newSource = sourceSave('sha256:new', 'new\n');
    const fetches = [
      oldFetch.promise,
      Promise.resolve<SourceDocumentSnapshotResult>({
        status: 'ok',
        snapshot: { markdown: 'new\n', sourceSave: newSource },
      }),
    ];
    const applied: string[] = [];
    const sequenceByKey = new Map<string, number>();
    const options = {
      documents: [current as OpenSourceDocumentRecord],
      sequenceByKey,
      getDocument: () => current,
      fetchSnapshot: () => fetches.shift() ?? Promise.reject(new Error('unexpected fetch')),
      markFileMissing: () => null,
      reconcileDiskSnapshot: () => {
        applied.push(newSource.hash);
        current = record(newSource, 'new\n');
        return { type: 'clean-updated' as const, record: current, clearedSavedChange: false };
      },
      onEvent: () => {},
    };

    const first = reconcileSourceDocuments(options);
    const second = reconcileSourceDocuments(options);

    await expect(second).resolves.toBe(true);
    oldFetch.resolve({
      status: 'ok',
      snapshot: { markdown: 'old\n', sourceSave: sourceSave('sha256:old', 'old\n') },
    });
    await expect(first).resolves.toBe(false);

    expect(applied).toEqual(['sha256:new']);
    expect(current.sourceSave.hash).toBe('sha256:new');
  });

  test('ignores a disk read when the document changed while fetch was pending', async () => {
    let current: EditableDocumentRecord = record();
    const staleFetch = deferred<SourceDocumentSnapshotResult>();
    let applied = false;
    const reconcile = reconcileSourceDocuments({
      documents: [current as OpenSourceDocumentRecord],
      sequenceByKey: new Map(),
      getDocument: () => current,
      fetchSnapshot: () => staleFetch.promise,
      markFileMissing: () => null,
      reconcileDiskSnapshot: () => {
        applied = true;
        return { type: 'clean-updated' as const, record: current, clearedSavedChange: false };
      },
      onEvent: () => {},
    });

    current = record(sourceSave('sha256:newer', 'newer\n'), 'newer\n');
    staleFetch.resolve({
      status: 'ok',
      snapshot: { markdown: 'old\n', sourceSave: sourceSave('sha256:old', 'old\n') },
    });

    await expect(reconcile).resolves.toBe(false);
    expect(applied).toBe(false);
    expect(current.sourceSave.hash).toBe('sha256:newer');
  });
});
