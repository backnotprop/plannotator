import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import type { DiffLayoutSource, LineSide, ScrollElementModel } from './layoutSource';
import type { RowMetrics } from './rowModel';
import type { MinimapMark } from './scene';

export const MINIMAP_LONG_SCREENS = 3;
export const MINIMAP_WIDTH = 12;

export interface MinimapFileInput {
  id: string;
  path: string;
  patch: string;
}

export interface MinimapNote {
  filePath: string;
  side: LineSide;
  lineStart: number;
  lineEnd: number;
}

export interface DiffMinimapSlotProps {
  source: DiffLayoutSource;
  fallbackModel?: { current: ScrollElementModel | null };
  files: readonly MinimapFileInput[];
  viewedPaths: ReadonlySet<string> | undefined;
  notes: readonly MinimapNote[];
  extraMarks?: readonly MinimapMark[];
  metrics: RowMetrics;
  split: boolean;
  expandUnchanged: boolean;
  pulseRef: React.MutableRefObject<(() => void) | null>;
  onShownChange?: (shown: boolean) => void;
}

const DiffMinimap = React.lazy(() => import('./DiffMinimap'));

export function isLongContent(contentHeight: number, viewportHeight: number): boolean {
  return viewportHeight > 0 && contentHeight > viewportHeight * MINIMAP_LONG_SCREENS;
}

export const DiffMinimapSlot: React.FC<DiffMinimapSlotProps> = ({ pulseRef, onShownChange, ...props }) => {
  const enabled = useConfigValue('diffMinimap');
  const { source } = props;
  const [long, setLong] = useState(false);
  const innerPulseRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(() => {
    setLong(isLongContent(source.contentHeight(), source.viewportHeight()));
    innerPulseRef.current?.();
  }, [source]);

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
