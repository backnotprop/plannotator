import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import type { DiffLayoutSource, LineSide, ScrollElementModel } from './layoutSource';
import type { RowMetrics } from './rowModel';
import type { MinimapKind } from './scene';

export const MINIMAP_LONG_SCREENS = 3;
export const MINIMAP_BIG_FILE_LINES = 1000;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

export function lastHunkLine(patch: string): number {
  let last = 0;
  for (const match of patch.matchAll(HUNK_HEADER)) {
    last = Math.max(last, Number(match[1]) + Number(match[2] ?? 1), Number(match[3]) + Number(match[4] ?? 1));
  }
  return last;
}

export function hasBigFile(patches: Iterable<string>): boolean {
  for (const patch of patches) if (lastHunkLine(patch) > MINIMAP_BIG_FILE_LINES) return true;
  return false;
}

export interface MinimapFileInput {
  id: string;
  path: string;
  patch: string;
  wholeFile?: { side: LineSide; lineCount: number };
}

export const MINIMAP_WHOLE_FILE_LINES = 400;

export interface MinimapNote {
  filePath: string;
  side: LineSide;
  lineStart: number;
  lineEnd: number;
  kind?: MinimapKind;
}

export interface DiffMinimapSlotProps {
  source: DiffLayoutSource;
  fallbackModel?: { current: ScrollElementModel | null };
  files: readonly MinimapFileInput[];
  viewedPaths: ReadonlySet<string> | undefined;
  notes: readonly MinimapNote[];
  metrics: RowMetrics;
  labelTop: number;
  split: boolean;
  expandUnchanged: boolean;
  pulseRef: React.MutableRefObject<(() => void) | null>;
  onShownChange?: (shown: boolean) => void;
}

const DiffMinimap = React.lazy(() => import('./DiffMinimap'));

export function isLongContent(contentHeight: number, viewportHeight: number, bigFile = false): boolean {
  if (viewportHeight <= 0) return false;
  return contentHeight > viewportHeight * (bigFile ? 1 : MINIMAP_LONG_SCREENS);
}

export const DiffMinimapSlot: React.FC<DiffMinimapSlotProps> = ({ pulseRef, onShownChange, ...props }) => {
  const enabled = useConfigValue('diffMinimap');
  const { source } = props;
  const bigFile = useMemo(
    () => props.files.some((file) => (file.wholeFile?.lineCount ?? 0) >= MINIMAP_WHOLE_FILE_LINES) || hasBigFile(props.files.filter((file) => !file.wholeFile).map((file) => file.patch)),
    [props.files],
  );
  const [long, setLong] = useState(false);
  const innerPulseRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(() => {
    setLong(isLongContent(source.contentHeight(), source.viewportHeight(), bigFile));
    innerPulseRef.current?.();
  }, [source, bigFile]);

  const pulse = useCallback(() => {
    if (timerRef.current != null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      check();
    }, 100);
  }, [check]);

  useEffect(() => {
    pulseRef.current = pulse;
    window.addEventListener('resize', pulse);
    let frame = 0;
    let tries = 0;
    const settle = () => {
      check();
      if (source.contentHeight() > 0 || ++tries > 60) return;
      frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => {
      if (pulseRef.current === pulse) pulseRef.current = null;
      window.removeEventListener('resize', pulse);
      cancelAnimationFrame(frame);
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [pulse, pulseRef, check, source]);

  useEffect(() => {
    innerPulseRef.current?.();
  }, [props.files, props.viewedPaths, props.notes]);

  const shown = enabled && long;
  useEffect(() => {
    onShownChange?.(shown);
  }, [shown, onShownChange]);

  if (!shown) return null;
  return (
    <Suspense fallback={null}>
      <DiffMinimap {...props} pulseRef={innerPulseRef} />
    </Suspense>
  );
};
