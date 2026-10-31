import { useCallback, useState } from 'react';
import type { Block } from '@plannotator/ui/types';
import { hasContentsRailHeadings } from '@plannotator/ui/utils/annotationHelpers';
import { storage } from '@plannotator/ui/utils/storage';

/**
 * An open document's Contents (AttachmentPane.tsx, ContentsPanel.tsx). On a
 * desktop: ui's contents rail (`MarkdownContentsRail`, the ticks in the
 * page's right gutter). Where the rail yields (a gutter under 68 px, a pane
 * under 480 px), until it has measured, and on a phone: a Contents button and
 * a sheet (ui's `DocumentContents`: the rail's headings and scroll math). A
 * Markdown file has Contents when the rail would: 4 or more headings of levels
 * 1 to 4 (`hasContentsRailHeadings`, over ui's `tocHeadings`); the sheet lists
 * those same headings.
 */
export function showsContents(blocks: readonly Block[]): boolean {
  return hasContentsRailHeadings(blocks);
}

/** Whether the rail is shown or hidden, remembered across files and windows (the comments drawer's way). */
export const CONTENTS_COOKIE = 'plannotator-inbox-contents';

/**
 * The rail: shown until hidden (its Hide, in the open Contents panel). Hidden, a Contents button over the file
 * shows it again. Its own cookie: plan review's "Auto-open sidebar" (`plannotator-toc-enabled`) is untouched.
 */
export function useContentsShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShownState] = useState(() => storage.getItem(CONTENTS_COOKIE) !== 'hidden');
  const setShown = useCallback((next: boolean) => {
    setShownState(next);
    storage.setItem(CONTENTS_COOKIE, next ? 'shown' : 'hidden');
  }, []);
  return [shown, setShown];
}
