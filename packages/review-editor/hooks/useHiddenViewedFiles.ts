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
 * that holds the list. Turning Hide viewed on (or off and on) while the pointer
 * is in the panel hides everything viewed: the person asked for it.
 */
export function useHiddenViewedFiles(viewedFiles: Set<string>, hideViewedFiles: boolean) {
  const [keptFrom, setKeptFrom] = useState<ReadonlySet<string> | null>(null);
  const viewedRef = useRef(viewedFiles);
  viewedRef.current = viewedFiles;
  const insideRef = useRef(false);

  const onPointerEnter = useCallback(() => {
    insideRef.current = true;
    setKeptFrom(new Set(viewedRef.current));
  }, []);
  const onPointerLeave = useCallback(() => {
    insideRef.current = false;
    setKeptFrom(null);
  }, []);

  useEffect(() => {
    if (insideRef.current) setKeptFrom(new Set(viewedRef.current));
  }, [hideViewedFiles]);

  const hiddenFiles = useMemo(() => filesToHide(viewedFiles, keptFrom), [viewedFiles, keptFrom]);
  return { hiddenFiles, panelPointerProps: { onPointerEnter, onPointerLeave } };
}
