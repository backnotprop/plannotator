import { useCallback, useMemo, useRef, useState } from 'react';
import type { SourceSaveCapability } from '@plannotator/shared/source-save';

type EnabledSourceSaveCapability = Extract<SourceSaveCapability, { enabled: true }>;

export type EditableDocumentSaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';

export interface SavedFileChange {
  key: string;
  path: string;
  basename: string;
  beforeText: string;
  afterText: string;
  beforeHash?: string;
  afterHash?: string;
}

export interface EditableDocumentRecord {
  key: string;
  path?: string;
  basename: string;
  sourceSave: SourceSaveCapability | null;
  sessionOpenText: string;
  sessionOpenHash?: string;
  diskBaseline: string;
  currentText: string;
  editMountText: string;
  saveStatus: EditableDocumentSaveStatus;
  lastKnownHash?: string;
  lastKnownMtimeMs?: number;
  savedChange?: SavedFileChange;
  error?: string;
}

export interface EditableDocumentStatus {
  key: string;
  path?: string;
  status: EditableDocumentSaveStatus;
  dirty: boolean;
}

export interface EditableDocumentDraftData {
  key: string;
  sourceSave: EnabledSourceSaveCapability;
  sessionOpenText: string;
  diskBaseline: string;
  currentText: string;
  savedChange?: SavedFileChange;
}

export interface SavedFileChangeDraftData extends SavedFileChange {
  sourceSave: EnabledSourceSaveCapability;
}

interface OpenEditableDocumentInput {
  key: string;
  text: string;
  sourceSave: SourceSaveCapability | null;
}

interface MarkSavedInput {
  key: string;
  text: string;
  sourceSave: EnabledSourceSaveCapability;
}

interface UpdateActiveTextOptions {
  forceNotify?: boolean;
}

function normalizeDocumentText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function basenameForCapability(sourceSave: SourceSaveCapability | null, fallbackKey: string): string {
  if (sourceSave?.enabled) return sourceSave.basename;
  const normalized = fallbackKey.replace(/\\/g, '/');
  return normalized.split('/').pop() || fallbackKey;
}

function recordIsDirty(record: EditableDocumentRecord): boolean {
  return record.currentText !== record.diskBaseline;
}

function cleanOrDirty(record: EditableDocumentRecord): EditableDocumentSaveStatus {
  return recordIsDirty(record) ? 'dirty' : 'clean';
}

function cloneRecord(record: EditableDocumentRecord): EditableDocumentRecord {
  return { ...record, savedChange: record.savedChange ? { ...record.savedChange } : undefined };
}

export function editableDocumentKey(sourceSave: SourceSaveCapability | null | undefined, fallback: string): string {
  return sourceSave?.enabled ? `file:${sourceSave.path}` : fallback;
}

export function useEditableDocuments() {
  const docsRef = useRef<Map<string, EditableDocumentRecord>>(new Map());
  const activeKeyRef = useRef<string | null>(null);
  const [version, setVersion] = useState(0);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const openDocument = useCallback(({ key, text, sourceSave }: OpenEditableDocumentInput) => {
    const normalized = normalizeDocumentText(text);
    const existing = docsRef.current.get(key);
    activeKeyRef.current = key;

    if (!existing) {
      docsRef.current.set(key, {
        key,
        path: sourceSave?.enabled ? sourceSave.path : undefined,
        basename: basenameForCapability(sourceSave, key),
        sourceSave,
        sessionOpenText: normalized,
        sessionOpenHash: sourceSave?.enabled ? sourceSave.hash : undefined,
        diskBaseline: normalized,
        currentText: normalized,
        editMountText: normalized,
        saveStatus: 'clean',
        lastKnownHash: sourceSave?.enabled ? sourceSave.hash : undefined,
        lastKnownMtimeMs: sourceSave?.enabled ? sourceSave.mtimeMs : undefined,
      });
      bump();
      return;
    }

    if (!recordIsDirty(existing) && existing.saveStatus !== 'conflict') {
      existing.sourceSave = sourceSave;
      existing.path = sourceSave?.enabled ? sourceSave.path : existing.path;
      existing.basename = basenameForCapability(sourceSave, existing.basename);
      existing.lastKnownHash = sourceSave?.enabled ? sourceSave.hash : existing.lastKnownHash;
      existing.lastKnownMtimeMs = sourceSave?.enabled ? sourceSave.mtimeMs : existing.lastKnownMtimeMs;
      // Clean documents can follow fresh disk reads. Dirty documents keep the
      // user's unsaved buffer and old hash so save conflicts are not masked.
      existing.diskBaseline = normalized;
      existing.currentText = normalized;
      existing.editMountText = normalized;
      if (!existing.savedChange) {
        existing.sessionOpenText = normalized;
        existing.sessionOpenHash = sourceSave?.enabled ? sourceSave.hash : undefined;
      }
      existing.saveStatus = existing.savedChange ? 'saved' : 'clean';
    } else if (sourceSave?.enabled) {
      existing.path = sourceSave.path;
      existing.basename = sourceSave.basename;
    }

    bump();
  }, [bump]);

  const setActiveKey = useCallback((key: string | null) => {
    if (activeKeyRef.current === key) return;
    activeKeyRef.current = key;
    bump();
  }, [bump]);

  const getActiveKey = useCallback((): string | null => activeKeyRef.current, []);

  const getDocument = useCallback((key: string): EditableDocumentRecord | null => {
    const record = docsRef.current.get(key);
    return record ? cloneRecord(record) : null;
  }, []);

  const getActiveDocument = useCallback((): EditableDocumentRecord | null => {
    const key = activeKeyRef.current;
    if (!key) return null;
    const record = docsRef.current.get(key);
    return record ? cloneRecord(record) : null;
  }, []);

  const getActiveDocumentLive = useCallback((): EditableDocumentRecord | null => {
    const key = activeKeyRef.current;
    return key ? docsRef.current.get(key) ?? null : null;
  }, []);

  const getCurrentText = useCallback((key: string): string | null => {
    return docsRef.current.get(key)?.currentText ?? null;
  }, []);

  const beginEdit = useCallback((text: string) => {
    const record = getActiveDocumentLive();
    if (!record) return;
    const normalized = normalizeDocumentText(text);
    record.editMountText = normalized;
    record.currentText = normalized;
    const nextStatus = cleanOrDirty(record);
    if (record.saveStatus !== nextStatus) {
      record.saveStatus = nextStatus;
      bump();
    }
  }, [bump, getActiveDocumentLive]);

  const updateActiveText = useCallback((text: string, options?: UpdateActiveTextOptions) => {
    const record = getActiveDocumentLive();
    if (!record) return;
    const normalized = normalizeDocumentText(text);
    const previousStatus = record.saveStatus;
    const previousText = record.currentText;
    record.currentText = normalized;
    record.saveStatus = previousStatus === 'saving' ? 'saving' : cleanOrDirty(record);
    if (previousStatus !== record.saveStatus || (options?.forceNotify && previousText !== normalized)) bump();
  }, [bump, getActiveDocumentLive]);

  const markSaving = useCallback((key: string) => {
    const record = docsRef.current.get(key);
    if (!record) return;
    record.saveStatus = 'saving';
    record.error = undefined;
    bump();
  }, [bump]);

  const markSaved = useCallback(({ key, text, sourceSave }: MarkSavedInput) => {
    const record = docsRef.current.get(key);
    if (!record) return;
    const normalized = normalizeDocumentText(text);
    record.diskBaseline = normalized;
    record.sourceSave = sourceSave;
    record.path = sourceSave.path;
    record.basename = sourceSave.basename;
    record.lastKnownHash = sourceSave.hash;
    record.lastKnownMtimeMs = sourceSave.mtimeMs;
    if (record.currentText === normalized) {
      record.editMountText = normalized;
      record.saveStatus = 'saved';
    } else {
      record.saveStatus = cleanOrDirty(record);
    }
    record.error = undefined;
    record.savedChange = normalized === record.sessionOpenText
      ? undefined
      : {
          key,
          path: sourceSave.path,
          basename: sourceSave.basename,
          beforeText: record.sessionOpenText,
          afterText: normalized,
          beforeHash: record.sessionOpenHash,
          afterHash: sourceSave.hash,
        };
    bump();
  }, [bump]);

  const markConflict = useCallback((key: string, message: string) => {
    const record = docsRef.current.get(key);
    if (!record) return;
    record.saveStatus = 'conflict';
    record.error = message;
    bump();
  }, [bump]);

  const markError = useCallback((key: string, message: string) => {
    const record = docsRef.current.get(key);
    if (!record) return;
    record.saveStatus = 'error';
    record.error = message;
    bump();
  }, [bump]);

  const clearDocument = useCallback((key: string) => {
    docsRef.current.delete(key);
    if (activeKeyRef.current === key) activeKeyRef.current = null;
    bump();
  }, [bump]);

  const discardDocument = useCallback((key: string): EditableDocumentRecord | null => {
    const record = docsRef.current.get(key);
    if (!record || !recordIsDirty(record)) return null;
    record.currentText = record.diskBaseline;
    record.editMountText = record.diskBaseline;
    record.saveStatus = record.savedChange ? 'saved' : 'clean';
    record.error = undefined;
    const discarded = cloneRecord(record);
    bump();
    return discarded;
  }, [bump]);

  const restoreDraftDocuments = useCallback((documents: EditableDocumentDraftData[]) => {
    if (documents.length === 0) return;

    for (const doc of documents) {
      const sessionOpenText = normalizeDocumentText(doc.sessionOpenText);
      const diskBaseline = normalizeDocumentText(doc.diskBaseline);
      const currentText = normalizeDocumentText(doc.currentText);
      const savedChange = doc.savedChange
        ? {
            ...doc.savedChange,
            beforeText: normalizeDocumentText(doc.savedChange.beforeText),
            afterText: normalizeDocumentText(doc.savedChange.afterText),
          }
        : undefined;
      docsRef.current.set(doc.key, {
        key: doc.key,
        path: doc.sourceSave.path,
        basename: doc.sourceSave.basename,
        sourceSave: doc.sourceSave,
        sessionOpenText,
        sessionOpenHash: doc.sourceSave.hash,
        diskBaseline,
        currentText,
        editMountText: currentText,
        saveStatus: currentText === diskBaseline ? 'clean' : 'dirty',
        lastKnownHash: doc.sourceSave.hash,
        lastKnownMtimeMs: doc.sourceSave.mtimeMs,
        savedChange,
      });
    }

    bump();
  }, [bump]);

  const restoreSavedFileChanges = useCallback((changes: SavedFileChangeDraftData[]) => {
    if (changes.length === 0) return;

    for (const change of changes) {
      if (change.beforeText === change.afterText) continue;
      const existing = docsRef.current.get(change.key);
      // A dirty restored buffer is more specific than a saved-change card.
      // restoreDraftDocuments carries savedChange too, so do not overwrite it.
      if (existing && recordIsDirty(existing)) continue;

      const beforeText = normalizeDocumentText(change.beforeText);
      const afterText = normalizeDocumentText(change.afterText);
      docsRef.current.set(change.key, {
        key: change.key,
        path: change.sourceSave.path,
        basename: change.sourceSave.basename,
        sourceSave: change.sourceSave,
        sessionOpenText: beforeText,
        sessionOpenHash: change.beforeHash,
        diskBaseline: afterText,
        currentText: afterText,
        editMountText: afterText,
        saveStatus: 'saved',
        lastKnownHash: change.sourceSave.hash,
        lastKnownMtimeMs: change.sourceSave.mtimeMs,
        savedChange: {
          key: change.key,
          path: change.sourceSave.path,
          basename: change.sourceSave.basename,
          beforeText,
          afterText,
          beforeHash: change.beforeHash,
          afterHash: change.afterHash ?? change.sourceSave.hash,
        },
      });
    }

    bump();
  }, [bump]);

  const getUnsavedDocuments = useCallback((): EditableDocumentRecord[] => {
    return Array.from(docsRef.current.values())
      .filter(recordIsDirty)
      .map(cloneRecord);
  }, []);

  const getSavedFileChanges = useCallback((): SavedFileChange[] => {
    return Array.from(docsRef.current.values())
      .map((record) => record.savedChange)
      .filter((change): change is SavedFileChange => !!change);
  }, []);

  const getDraftDocuments = useCallback((): EditableDocumentDraftData[] => {
    return Array.from(docsRef.current.values())
      .filter((record): record is EditableDocumentRecord & { sourceSave: EnabledSourceSaveCapability } =>
        record.sourceSave?.enabled === true && recordIsDirty(record)
      )
      .map((record) => ({
        key: record.key,
        sourceSave: record.sourceSave,
        sessionOpenText: record.sessionOpenText,
        diskBaseline: record.diskBaseline,
        currentText: record.currentText,
        savedChange: record.savedChange ? { ...record.savedChange } : undefined,
      }));
  }, []);

  const getDraftSavedFileChanges = useCallback((): SavedFileChangeDraftData[] => {
    return Array.from(docsRef.current.values())
      .filter((record): record is EditableDocumentRecord & { sourceSave: EnabledSourceSaveCapability; savedChange: SavedFileChange } =>
        record.sourceSave?.enabled === true && !!record.savedChange
      )
      .map((record) => ({
        ...record.savedChange,
        sourceSave: record.sourceSave,
      }));
  }, []);

  const getFileEditStatuses = useCallback((): Map<string, EditableDocumentStatus> => {
    const statuses = new Map<string, EditableDocumentStatus>();
    for (const record of docsRef.current.values()) {
      if (!record.path) continue;
      statuses.set(record.path, {
        key: record.key,
        path: record.path,
        status: record.saveStatus,
        dirty: recordIsDirty(record),
      });
    }
    return statuses;
  }, []);

  const activeDocument = useMemo(() => getActiveDocument(), [getActiveDocument, version]);
  const fileEditStatuses = useMemo(() => getFileEditStatuses(), [getFileEditStatuses, version]);

  return {
    version,
    activeDocument,
    fileEditStatuses,
    openDocument,
    setActiveKey,
    getActiveKey,
    getDocument,
    getActiveDocument,
    getActiveDocumentLive,
    getCurrentText,
    beginEdit,
    updateActiveText,
    markSaving,
    markSaved,
    markConflict,
    markError,
    clearDocument,
    discardDocument,
    restoreDraftDocuments,
    restoreSavedFileChanges,
    getUnsavedDocuments,
    getSavedFileChanges,
    getDraftDocuments,
    getDraftSavedFileChanges,
  };
}
