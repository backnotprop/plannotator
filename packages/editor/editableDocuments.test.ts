import { describe, expect, test } from 'bun:test';
import {
  canApplyEditableDocumentDiskSnapshot,
  canRestoreEditableDocumentDraft,
  getEditableDocumentKnownDiskHash,
  markEditableDocumentSaved,
  markEditableDocumentFileMissing,
  reconcileEditableDocumentDiskSnapshot,
  type EditableDocumentRecord,
  type EnabledSourceSaveCapability,
} from './editableDocuments';

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

function record(overrides: Partial<EditableDocumentRecord> = {}): EditableDocumentRecord {
  const source = sourceSave('sha256:after');
  return {
    key: 'file:/repo/docs/a.md',
    path: source.path,
    basename: source.basename,
    sourceSave: source,
    sessionOpenText: 'before\n',
    sessionOpenHash: 'sha256:before',
    diskBaseline: 'after\n',
    currentText: 'after\n',
    editMountText: 'after\n',
    saveStatus: 'saved',
    lastKnownHash: source.hash,
    lastKnownMtimeMs: source.mtimeMs,
    savedChange: {
      key: 'file:/repo/docs/a.md',
      path: source.path,
      basename: source.basename,
      beforeText: 'before\n',
      afterText: 'after\n',
      beforeHash: 'sha256:before',
      afterHash: source.hash,
    },
    ...overrides,
  };
}

describe('reconcileEditableDocumentDiskSnapshot', () => {
  test('known disk hash follows an active disk-conflict snapshot', () => {
    const nextSource = sourceSave('sha256:external', 'external\n');
    const doc = record({
      currentText: 'after\nunsaved\n',
      saveStatus: 'conflict',
      diskConflict: {
        text: 'external\n',
        sourceSave: nextSource,
      },
    });

    expect(getEditableDocumentKnownDiskHash(doc)).toBe('sha256:external');
  });

  test('disk snapshots only apply to the record version that requested them', () => {
    const doc = record();

    expect(canApplyEditableDocumentDiskSnapshot(doc, 'sha256:after')).toBe(true);
    expect(canApplyEditableDocumentDiskSnapshot(doc, 'sha256:before')).toBe(false);
    expect(canApplyEditableDocumentDiskSnapshot({ ...doc, saveStatus: 'saving' }, 'sha256:after')).toBe(false);
    expect(canApplyEditableDocumentDiskSnapshot(null, 'sha256:after')).toBe(false);
  });

  test('clean files adopt disk changes and clear stale saved edit cards', () => {
    const doc = record();
    const nextSource = sourceSave('sha256:external', 'external\n');

    const result = reconcileEditableDocumentDiskSnapshot(doc, {
      key: doc.key,
      text: 'external\n',
      sourceSave: nextSource,
    });

    expect(result.type).toBe('clean-updated');
    if (result.type !== 'clean-updated') throw new Error('expected clean update');
    expect(result.clearedSavedChange).toBe(true);
    expect(result.record.currentText).toBe('external\n');
    expect(result.record.diskBaseline).toBe('external\n');
    expect(result.record.sessionOpenText).toBe('external\n');
    expect(result.record.saveStatus).toBe('clean');
    expect(result.record.savedChange).toBeUndefined();
    expect(result.record.diskConflict).toBeUndefined();
  });

  test('dirty files keep the user buffer and enter disk-conflict state', () => {
    const doc = record({
      currentText: 'after\nunsaved\n',
      editMountText: 'after\n',
      saveStatus: 'dirty',
    });
    const nextSource = sourceSave('sha256:external', 'external\n');

    const result = reconcileEditableDocumentDiskSnapshot(doc, {
      key: doc.key,
      text: 'external\n',
      sourceSave: nextSource,
    });

    expect(result.type).toBe('conflict');
    if (result.type !== 'conflict') throw new Error('expected conflict');
    expect(result.record.currentText).toBe('after\nunsaved\n');
    expect(result.record.diskBaseline).toBe('after\n');
    expect(result.record.saveStatus).toBe('conflict');
    expect(result.record.sourceSave).toEqual(sourceSave('sha256:after'));
    expect(result.record.savedChange).toBeUndefined();
    expect(result.record.diskConflict).toEqual({
      text: 'external\n',
      sourceSave: nextSource,
    });
  });

  test('saving dirty files can still reconcile an explicit save-conflict snapshot', () => {
    const doc = record({
      currentText: 'local save\n',
      editMountText: 'after\n',
      saveStatus: 'saving',
    });
    const nextSource = sourceSave('sha256:external', 'external\n');

    const result = reconcileEditableDocumentDiskSnapshot(doc, {
      key: doc.key,
      text: 'external\n',
      sourceSave: nextSource,
    });

    expect(result.type).toBe('conflict');
    if (result.type !== 'conflict') throw new Error('expected conflict');
    expect(result.record.currentText).toBe('local save\n');
    expect(result.record.sourceSave).toEqual(sourceSave('sha256:after'));
    expect(result.record.diskConflict).toEqual({
      text: 'external\n',
      sourceSave: nextSource,
    });
  });

  test('same disk-conflict snapshot does not report a new conflict again', () => {
    const doc = record({
      currentText: 'after\nunsaved\n',
      editMountText: 'after\n',
      saveStatus: 'dirty',
    });
    const nextSource = sourceSave('sha256:external', 'external\n');

    const first = reconcileEditableDocumentDiskSnapshot(doc, {
      key: doc.key,
      text: 'external\n',
      sourceSave: nextSource,
    });
    const second = reconcileEditableDocumentDiskSnapshot(doc, {
      key: doc.key,
      text: 'external\n',
      sourceSave: nextSource,
    });

    expect(first.type).toBe('conflict');
    expect(second.type).toBe('unchanged');
    if (second.type !== 'unchanged') throw new Error('expected unchanged');
    expect(second.record.saveStatus).toBe('conflict');
    expect(second.record.sourceSave).toEqual(sourceSave('sha256:after'));
    expect(second.record.diskConflict).toEqual({
      text: 'external\n',
      sourceSave: nextSource,
    });
  });

  test('same-hash snapshots refresh metadata without clearing saved edit context', () => {
    const doc = record();
    const nextSource = {
      ...sourceSave('sha256:after'),
      mtimeMs: 3000,
    };

    const result = reconcileEditableDocumentDiskSnapshot(doc, {
      key: doc.key,
      text: 'after\n',
      sourceSave: nextSource,
    });

    expect(result.type).toBe('unchanged');
    if (result.type !== 'unchanged') throw new Error('expected unchanged');
    expect(result.record.lastKnownMtimeMs).toBe(3000);
    expect(result.record.savedChange).toEqual({
      key: 'file:/repo/docs/a.md',
      path: '/repo/docs/a.md',
      basename: 'a.md',
      beforeText: 'before\n',
      afterText: 'after\n',
      beforeHash: 'sha256:before',
      afterHash: 'sha256:after',
    });
  });

  test('same-hash snapshots clear missing state without resetting a dirty buffer', () => {
    const doc = record({
      currentText: 'after\nlocal\n',
      editMountText: 'after\n',
      saveStatus: 'missing',
      missingOnDisk: true,
    });
    const nextSource = {
      ...sourceSave('sha256:after'),
      mtimeMs: 3000,
    };

    const result = reconcileEditableDocumentDiskSnapshot(doc, {
      key: doc.key,
      text: 'after\n',
      sourceSave: nextSource,
    });

    expect(result.type).toBe('status-updated');
    if (result.type !== 'status-updated') throw new Error('expected status update');
    expect(result.record.currentText).toBe('after\nlocal\n');
    expect(result.record.diskBaseline).toBe('after\n');
    expect(result.record.saveStatus).toBe('dirty');
    expect(result.record.missingOnDisk).toBeUndefined();
  });

  test('missing files keep the buffer and clear stale saved edit context', () => {
    const doc = record({
      currentText: 'after\nlocal\n',
      editMountText: 'after\n',
      saveStatus: 'dirty',
    });

    const result = markEditableDocumentFileMissing(doc);

    expect(result.type).toBe('file-missing');
    if (result.type !== 'file-missing') throw new Error('expected file missing');
    expect(result.clearedSavedChange).toBe(true);
    expect(result.record.currentText).toBe('after\nlocal\n');
    expect(result.record.diskBaseline).toBe('after\n');
    expect(result.record.saveStatus).toBe('missing');
    expect(result.record.missingOnDisk).toBe(true);
    expect(result.record.savedChange).toBeUndefined();
    expect(result.record.diskConflict).toBeUndefined();
  });
});

describe('canRestoreEditableDocumentDraft', () => {
  test('allows restoring over the initial clean file snapshot', () => {
    const source = sourceSave('sha256:after');
    const doc = record({
      saveStatus: 'clean',
      savedChange: undefined,
      sessionOpenText: 'after\n',
      sessionOpenHash: source.hash,
    });

    expect(canRestoreEditableDocumentDraft(doc, source, 'after\n')).toBe(true);
  });

  test('does not restore over newer session state', () => {
    const source = sourceSave('sha256:after');
    const cleanDoc = record({
      saveStatus: 'clean',
      savedChange: undefined,
      sessionOpenText: 'after\n',
      sessionOpenHash: source.hash,
    });

    expect(canRestoreEditableDocumentDraft({ ...cleanDoc, currentText: 'live\n' }, source, 'after\n')).toBe(false);
    expect(canRestoreEditableDocumentDraft({ ...cleanDoc, diskBaseline: 'newer\n', currentText: 'newer\n' }, source, 'after\n')).toBe(false);
    expect(canRestoreEditableDocumentDraft({ ...cleanDoc, saveStatus: 'missing', missingOnDisk: true }, source, 'after\n')).toBe(false);
    expect(canRestoreEditableDocumentDraft({ ...cleanDoc, saveStatus: 'saved', savedChange: record().savedChange }, source, 'after\n')).toBe(false);
    expect(canRestoreEditableDocumentDraft({ ...cleanDoc, sourceSave: sourceSave('sha256:external') }, source, 'after\n')).toBe(false);
  });
});

describe('markEditableDocumentSaved', () => {
  test('carries a conflict overwrite base forward for later saved edit diffs', () => {
    const doc = record({
      sessionOpenText: 'original\n',
      sessionOpenHash: 'sha256:original',
      diskBaseline: 'local\n',
      currentText: 'local\n',
      savedChange: undefined,
    });
    const overwriteSource = sourceSave('sha256:overwrite', 'local\n');

    markEditableDocumentSaved(doc, {
      key: doc.key,
      text: 'local\n',
      sourceSave: overwriteSource,
      savedChangeBaseText: 'external\n',
      savedChangeBaseHash: 'sha256:external',
    });

    expect(doc.savedChange).toEqual({
      key: doc.key,
      path: overwriteSource.path,
      basename: overwriteSource.basename,
      beforeText: 'external\n',
      afterText: 'local\n',
      beforeHash: 'sha256:external',
      afterHash: 'sha256:overwrite',
    });

    doc.currentText = 'second\n';
    const secondSource = sourceSave('sha256:second', 'second\n');
    markEditableDocumentSaved(doc, {
      key: doc.key,
      text: 'second\n',
      sourceSave: secondSource,
    });

    expect(doc.savedChange).toEqual({
      key: doc.key,
      path: secondSource.path,
      basename: secondSource.basename,
      beforeText: 'external\n',
      afterText: 'second\n',
      beforeHash: 'sha256:external',
      afterHash: 'sha256:second',
    });
  });
});
