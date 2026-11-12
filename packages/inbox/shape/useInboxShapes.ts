import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inboxApi, type InboxShapeSummary } from '../api';

export const SHAPE_ROW_MIN_BOARDS = 3;

export interface InboxShapes {
  shapes: InboxShapeSummary[] | null;
  byThread: Map<string, InboxShapeSummary>;
  changed: number;
  rowShown: boolean;
  subscribe: (listener: (ids: string[]) => void) => () => void;
  refresh: () => void;
}

export function useInboxShapes(on: boolean, frames: (listener: (ids: string[]) => void) => () => void): InboxShapes {
  const [shapes, setShapes] = useState<InboxShapeSummary[] | null>(null);
  const listeners = useRef(new Set<(ids: string[]) => void>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reading = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (!on) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    inboxApi
      .shapes(controller.signal)
      .then((answer) => {
        if (!controller.signal.aborted) setShapes(answer.shapes);
      })
      .catch(() => {});
  }, [on]);

  useEffect(() => {
    if (!on) {
      setShapes(null);
      return;
    }
    refresh();
    const stop = frames((ids) => {
      for (const listener of listeners.current) listener(ids);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 60);
    });
    return () => {
      stop();
      reading.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [on, refresh, frames]);

  const subscribe = useCallback((listener: (ids: string[]) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return useMemo(() => {
    const byThread = new Map<string, InboxShapeSummary>();
    for (const s of shapes ?? []) if (s.thread && s.state === 'active' && !byThread.has(s.thread)) byThread.set(s.thread, s);
    const active = (shapes ?? []).filter((s) => s.state === 'active');
    return {
      shapes,
      byThread,
      changed: active.filter((s) => s.changed).length,
      rowShown: on && active.length >= SHAPE_ROW_MIN_BOARDS,
      subscribe,
      refresh,
    };
  }, [shapes, on, subscribe, refresh]);
}
