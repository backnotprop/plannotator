import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export function filesToHide(viewedFiles: ReadonlySet<string>, keptFrom: ReadonlySet<string> | null): ReadonlySet<string> {
  if (keptFrom == null) return viewedFiles;
  const hidden = new Set<string>();
  for (const path of viewedFiles) if (keptFrom.has(path)) hidden.add(path);
  return hidden;
}

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

  useEffect(() => {
    release();
    if (insideRef.current) hold();
  }, [hideViewedFiles, hold, release]);

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
