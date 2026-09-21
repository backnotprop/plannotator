import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  AutoViewedTracker,
  createViewedSyncBatcher,
  type ViewedSyncBatcher,
} from '../utils/autoViewed';

/**
 * Binds the pure auto-mark-viewed core to the review app.
 *
 * Owns: the dwell clock, the suppression set (which rides the draft), the
 * scope gates, the retry that lets a file parked at the bottom of the diff
 * mature its dwell, and the batching of platform (GitHub) viewed sync.
 *
 * Applies nothing itself — marking is `onMark`, which the App turns into
 * add-only viewed state.
 */
export interface UseAutoViewedOptions {
  /** The `reviewAutoViewed` setting. */
  enabled: boolean;
  /**
   * Scope gate (Rule 4). True while the reviewer is somewhere that is not the
   * review target: the Guided Review takeover, or a `commit:<sha>` detour.
   * Dwell stops accruing and nothing marks.
   */
  suspended: boolean;
  /** Current viewed set — a file already checked off is never re-marked. */
  viewedFiles: Set<string>;
  /**
   * Files the reviewer manually un-viewed (Rule 3). Owned by the App because
   * it also rides the review draft; mirrored into the core on every change.
   */
  suppressedFiles: Set<string>;
  /** Apply the marks (add-only). */
  onMark: (paths: string[]) => void;
  /**
   * Optional platform sync for PR sessions. Called with a BATCH of paths, so
   * a read-through of a 40-file PR is a handful of requests, not 40.
   */
  onSyncPlatformViewed?: (paths: string[]) => void;
  /**
   * Called after every auto-mark. The first-time notice rides this: the marker
   * always marks, and the owner decides whether the toast can be shown right
   * now (deferred behind a takeover or a first-run dialog, retried on the next
   * fire) rather than losing it.
   */
  onAutoView?: () => void;
  /** The single-file diff panel's file while that panel is active, else null. */
  singleFileReadingFile: string | null;
  /**
   * Identity of the diff snapshot on screen. Dwell is per-snapshot: a change
   * clears it so a file read in the previous diff cannot mark itself the
   * instant it is passed in the new one. Suppression survives.
   */
  snapshotKey: string;
  /** Override the batch window (tests). */
  syncBatchMs?: number;
  /** Override the dwell floor (tests). */
  dwellMs?: number;
}

export interface UseAutoViewedResult {
  /** Feed `AllFilesCodeView`'s `onVisibleFileChange`. */
  handleReadingFileChange: (filePath: string | null, info?: { collapsed: boolean }) => void;
  /** Feed `AllFilesCodeView`'s `onFileScrolledPast`. */
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

  // Everything the mark path needs, read through refs so the callbacks handed
  // to AllFilesCodeView stay stable across renders (it holds them for the life
  // of a scroll session).
  const viewedRef = useRef(viewedFiles);
  viewedRef.current = viewedFiles;
  const onMarkRef = useRef(onMark);
  onMarkRef.current = onMark;
  const onAutoViewRef = useRef(onAutoView);
  onAutoViewRef.current = onAutoView;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  /** Collapsed flag of the file the all-files surface last reported. */
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

  // A file parked at the bottom of the diff is still accruing dwell, but
  // reportVisibleFile only runs on scroll — without this the last file would
  // never mature. Retries the pass once the remaining dwell has elapsed.
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
      // The all-files surface reports through this; a suspended session still
      // records WHICH file is on screen but never accrues its time (the
      // tracker's countable flag is what stops the clock).
      readingCollapsedRef.current = info?.collapsed === true;
      tracker.readingFileChanged(filePath, Date.now(), {
        countable: !suspendedRef.current && !readingCollapsedRef.current,
      });
      clearRetry();
    },
    [clearRetry, tracker],
  );

  // Keep the core's copy of the switch in step. Committing on the way through
  // means flipping the setting mid-read neither loses nor invents dwell.
  useEffect(() => {
    tracker.setEnabled(enabled, Date.now());
  }, [enabled, tracker]);

  // Suspension stops the clock without losing the reading file: re-entering
  // the review resumes accruing from now, not from when the detour started.
  useEffect(() => {
    const reading = tracker.getReadingFile();
    tracker.readingFileChanged(reading, Date.now(), {
      countable: !suspended && !readingCollapsedRef.current,
    });
    if (suspended) clearRetry();
  }, [suspended, tracker, clearRetry]);

  // The App owns the suppression set (it rides the draft); mirror it in.
  useEffect(() => {
    tracker.setSuppressed(suppressedFiles);
  }, [suppressedFiles, tracker]);

  // A new diff snapshot: dwell is meaningless across it.
  useEffect(() => {
    tracker.resetSnapshot(Date.now());
    clearRetry();
  }, [snapshotKey, tracker, clearRetry]);

  // Rule 2 — the single-file panel. Opening a file never marks it; moving off
  // it after the dwell floor does. Also owns the reading file while that panel
  // is the active one, so keyboard file navigation gets the same treatment.
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
