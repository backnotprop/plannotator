import { useEffect, useRef, useState } from 'react';

export const ONE_SIDE_PANEL_WIDTH = 900;

export function sidePanelToClose(narrow: boolean, tree: boolean, panel: boolean, openedLast: 'tree' | 'panel'): 'tree' | 'panel' | null {
  if (!narrow || !tree || !panel) return null;
  return openedLast === 'tree' ? 'panel' : 'tree';
}

function useNarrowWindow(): boolean {
  const query = `(max-width: ${ONE_SIDE_PANEL_WIDTH - 1}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return narrow;
}

export function useOneSidePanelWhenNarrow(tree: boolean, panel: boolean, closeTree: () => void, closePanel: () => void): void {
  const narrow = useNarrowWindow();
  const openedLast = useRef<'tree' | 'panel'>('panel');
  const before = useRef({ tree, panel });
  if (tree && !before.current.tree) openedLast.current = 'tree';
  if (panel && !before.current.panel) openedLast.current = 'panel';
  before.current = { tree, panel };
  useEffect(() => {
    const close = sidePanelToClose(narrow, tree, panel, openedLast.current);
    if (close === 'tree') closeTree();
    if (close === 'panel') closePanel();
  }, [narrow, tree, panel, closeTree, closePanel]);
}
