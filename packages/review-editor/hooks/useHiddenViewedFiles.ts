import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The viewed files that "Hide viewed" takes out of the list (#2713).
 *
 * Opening a file auto-marks the one you left as viewed. With Hide viewed on,
 * that row used to go at once, and every row under it (and the list, scrolled
 * to the bottom) moved under the pointer: the next click hit another file.
 * While the pointer is in the panel, only what was already viewed when it came
 * in is hidden (`keptFrom`); what becomes viewed meanwhile stays until it leaves.
 * A file un-viewed meanwhile shows again at once: that only adds its own row.
 */
export function filesToHide(viewedFiles: ReadonlySet<string>, keptFrom: ReadonlySet<string> | null): ReadonlySet<string> {
  if (keptFrom == null) return viewedFiles;
  const hidden = new Set<string>();
  for (const path of viewedFiles) if (keptFrom.has(path)) hidden.add(path);
  return hidden;
}

/**
 * `hiddenFiles` for the hide checks, and the pointer handlers for the panel
 * that holds the list.
 *
 * The hold is only for a pointer that is aiming at a row:
 *  - a key press (j/k, the arrows, Home/End, ⌘P) releases it, so a keyboard
 *    user resting the mouse over the panel still sees viewed files go; the
 *    pointer's next move in the panel holds again from what is viewed then;
 *  - turning Hide viewed on (or off and on) in the panel hides everything
 *    viewed: the person asked for it;
 *  - with Hide viewed off there is nothing to hold, so crossing the panel edge
 *    costs no state change and no redraw.
 */
export function useHiddenViewedFiles(viewedFiles: Set<string>, hideViewedFiles: boolean) {
  const [keptFrom, setKeptFrom] = useState<ReadonlySet<string> | null>(null);
  const viewedRef = useRef(viewedFiles);
  viewedRef.current = viewedFiles;
  const hideRef = useRef(hideViewedFiles);
  hideRef.current = hideViewedFiles;
  const insideRef = useRef(false);
  const heldRef = useRef(false);

  const hold = useCallback(() => {
    if (!hideRef.current || heldRef.current) return;
    heldRef.current = true;
    setKeptFrom(new Set(viewedRef.current));
  }, []);
  const release = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    setKeptFrom(null);
  }, []);

  const onPointerEnter = useCallback(() => {
    insideRef.current = true;
    hold();
  }, [hold]);
  const onPointerMove = useCallback(() => {
    if (insideRef.current) hold();
  }, [hold]);
  const onPointerLeave = useCallback(() => {
    insideRef.current = false;
    release();
  }, [release]);

  // A toggle in the panel re-takes the hold from what is viewed now.
  useEffect(() => {
    release();
    if (insideRef.current) hold();
  }, [hideViewedFiles, hold, release]);

  // Keyboard navigation moves the active file without aiming at a row.
  useEffect(() => {
    if (!hideViewedFiles) return;
    const onKeyDown = () => {
      if (insideRef.current) release();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [hideViewedFiles, release]);

  const hiddenFiles = useMemo(
    () => (hideViewedFiles ? filesToHide(viewedFiles, keptFrom) : viewedFiles),
    [hideViewedFiles, viewedFiles, keptFrom],
  );
  return { hiddenFiles, panelPointerProps: { onPointerEnter, onPointerMove, onPointerLeave } };
}
