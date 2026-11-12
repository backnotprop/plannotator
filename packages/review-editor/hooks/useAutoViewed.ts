import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  AutoViewedTracker,
  createViewedSyncBatcher,
  type ViewedSyncBatcher,
} from '../utils/autoViewed';

export interface UseAutoViewedOptions {
  enabled: boolean;
  suspended: boolean;
  /** Current viewed set — a file already checked off is never re-marked. */
  viewedFiles: Set<string>;
  suppressedFiles: Set<string>;
  onMark: (paths: string[]) => void;
  onSyncPlatformViewed?: (paths: string[]) => void;
  onAutoView?: () => void;
  singleFileReadingFile: string | null;
  snapshotKey: string;
  syncBatchMs?: number;
  dwellMs?: number;
}

export interface UseAutoViewedResult {
  handleReadingFileChange: (filePath: string | null, info?: { collapsed: boolean }) => void;
  handleFileScrolledPast: (filePath: string) => void;
}

export function useAutoViewed({
  enabled,
  suspended,
  viewedFiles,
  suppressedFiles,
  onMark,
  onSyncPlatformViewed,
  onAutoView,
  singleFileReadingFile,
  snapshotKey,
  syncBatchMs,
  dwellMs,
}: UseAutoViewedOptions): UseAutoViewedResult {
  const trackerRef = useRef<AutoViewedTracker | null>(null);
  if (trackerRef.current === null) trackerRef.current = new AutoViewedTracker({ enabled, dwellMs });
  const tracker = trackerRef.current;

  const viewedRef = useRef(viewedFiles);
  viewedRef.current = viewedFiles;
  const onMarkRef = useRef(onMark);
  onMarkRef.current = onMark;
  const onAutoViewRef = useRef(onAutoView);
  onAutoViewRef.current = onAutoView;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const readingCollapsedRef = useRef(false);

  const syncRef = useRef(onSyncPlatformViewed);
  syncRef.current = onSyncPlatformViewed;
  const batcherRef = useRef<ViewedSyncBatcher | null>(null);
  if (batcherRef.current === null) {
    batcherRef.current = createViewedSyncBatcher(
      (paths) => syncRef.current?.(paths),
      syncBatchMs === undefined ? {} : { windowMs: syncBatchMs },
    );
  }
  useEffect(() => () => batcherRef.current?.dispose(), []);

  // A file parked at the bottom keeps accruing dwell but reportVisibleFile only runs on scroll: retry once the dwell has elapsed.
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRetry = useCallback(() => {
    if (retryRef.current !== null) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
  }, []);
  useEffect(() => clearRetry, [clearRetry]);

  const applyMark = useCallback((filePath: string) => {
    onMarkRef.current([filePath]);
    if (syncRef.current) batcherRef.current?.add([filePath]);
    onAutoViewRef.current?.();
  }, []);

  const attemptMark = useCallback((filePath: string) => {
    if (suspendedRef.current) return;
    if (viewedRef.current.has(filePath)) return;
    const outcome = tracker.filePassed(filePath, Date.now());
    if (outcome === 'marked') {
      clearRetry();
      applyMark(filePath);
      return;
    }
    if (outcome !== 'dwell') return;
    // Only worth retrying while the file is STILL the one being read — dwell
    // accrues nowhere else, so a file already left behind can never mature.
    if (tracker.getReadingFile() !== filePath) return;
    clearRetry();
    const remaining = tracker.remainingDwell(filePath);
    retryRef.current = setTimeout(() => {
      retryRef.current = null;
      if (suspendedRef.current) return;
      if (viewedRef.current.has(filePath)) return;
      if (tracker.getReadingFile() !== filePath) return;
      if (tracker.filePassed(filePath, Date.now()) === 'marked') applyMark(filePath);
    }, remaining + 16);
  }, [applyMark, clearRetry, tracker]);

  const handleFileScrolledPast = useCallback((filePath: string) => {
    attemptMark(filePath);
  }, [attemptMark]);

  const handleReadingFileChange = useCallback(
    (filePath: string | null, info?: { collapsed: boolean }) => {
      readingCollapsedRef.current = info?.collapsed === true;
      tracker.readingFileChanged(filePath, Date.now(), {
        countable: !suspendedRef.current && !readingCollapsedRef.current,
      });
      clearRetry();
    },
    [clearRetry, tracker],
  );

  useEffect(() => {
    tracker.setEnabled(enabled, Date.now());
  }, [enabled, tracker]);

  useEffect(() => {
    const reading = tracker.getReadingFile();
    tracker.readingFileChanged(reading, Date.now(), {
      countable: !suspended && !readingCollapsedRef.current,
    });
    if (suspended) clearRetry();
  }, [suspended, tracker, clearRetry]);

  useEffect(() => {
    tracker.setSuppressed(suppressedFiles);
  }, [suppressedFiles, tracker]);

  useEffect(() => {
    tracker.resetSnapshot(Date.now());
    clearRetry();
  }, [snapshotKey, tracker, clearRetry]);

  const previousSingleFileRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousSingleFileRef.current;
    previousSingleFileRef.current = singleFileReadingFile;
    if (previous === singleFileReadingFile) return;
    if (previous !== null) {
      tracker.readingFileChanged(singleFileReadingFile, Date.now(), {
        countable: !suspendedRef.current,
      });
      if (!suspendedRef.current && !viewedRef.current.has(previous)) {
        if (tracker.fileNavigatedAway(previous, Date.now()) === 'marked') applyMark(previous);
      }
      return;
    }
    if (singleFileReadingFile !== null) {
      tracker.readingFileChanged(singleFileReadingFile, Date.now(), {
        countable: !suspendedRef.current,
      });
    }
  }, [singleFileReadingFile, applyMark, tracker]);

  return useMemo(
    () => ({ handleReadingFileChange, handleFileScrolledPast }),
    [handleReadingFileChange, handleFileScrolledPast],
  );
}
