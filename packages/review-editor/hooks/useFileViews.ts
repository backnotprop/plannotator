import { useCallback, useState } from 'react';
import type { ChangedFileView } from '../components/FileViewSwitch';

export function useFileViews(): [(path: string) => ChangedFileView, (path: string, view: ChangedFileView) => void] {
  const [views, setViews] = useState<ReadonlyMap<string, ChangedFileView>>(() => new Map());
  const viewOf = useCallback((path: string): ChangedFileView => views.get(path) ?? 'changes', [views]);
  const setView = useCallback((path: string, view: ChangedFileView) => {
    setViews((current) => {
      if ((current.get(path) ?? 'changes') === view) return current;
      const next = new Map(current);
      if (view === 'changes') next.delete(path);
      else next.set(path, view);
      return next;
    });
  }, []);
  return [viewOf, setView];
}
