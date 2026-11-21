import { useCallback, useEffect, useState } from 'react';
import type { Block } from '@plannotator/ui/types';
import type { ContentsButtonMode } from './components/ContentsPanel';
import { hasContentsRailHeadings } from '@plannotator/ui/utils/annotationHelpers';
import { storage } from '@plannotator/ui/utils/storage';

/**
 * An open document's Contents (AttachmentPane.tsx, ContentsPanel.tsx). On a
 * desktop: ui's contents rail (`MarkdownContentsRail`, the ticks in the
 * page's right gutter). Where the rail yields (a gutter under 68 px, a pane
 * under 480 px), until it has measured, and on a phone: a Contents button and
 * a sheet (ui's `DocumentContents`: the rail's headings and scroll math). A
 * Markdown file has Contents when it has 2 or more headings of levels 1 to 4
 * (`INBOX_CONTENTS_MIN_HEADINGS`, which the Inbox passes the rail as its
 * `minHeadings`: ui's default of 4 left a short plan with none;
 * `hasContentsRailHeadings`, over ui's `tocHeadings`). The sheet lists those
 * same headings.
 */
export function showsContents(blocks: readonly Block[]): boolean {
  return hasContentsRailHeadings(blocks, INBOX_CONTENTS_MIN_HEADINGS);
}

/** The fewest headings an open document in the Inbox shows Contents for (the rail's `minHeadings`). */
export const INBOX_CONTENTS_MIN_HEADINGS = 2;

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

/** How long a rail may take to load and measure before the Contents button stands in for it. */
export const CONTENTS_RAIL_WAIT_MS = 2500;

/**
 * Whether the rail has had its time for this key (a document, and whether the rail is shown): while it may still be
 * on its way no stand-in shows (no button flashes before the rail); past that, a rail that never drew leaves the
 * Contents button and sheet. The wait starts again for each key.
 */
export function useContentsRailWaited(enabled: boolean, key: string): boolean {
  const [waited, setWaited] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => setWaited(key), CONTENTS_RAIL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [enabled, key]);
  return waited === key;
}

/**
 * The Contents button over a document (ContentsPanel.tsx): on a phone, the sheet; hidden, Show wherever the rail
 * would fit (by the layout, `sideFits`, or by the rail's own measure), else the sheet; shown, nothing while the rail
 * is there or on its way, and the sheet where it does not fit or never drew. Null: no button.
 */
export function contentsButtonMode(state: { hasContents: boolean; phone: boolean; shown: boolean; sideFits: boolean; railFits: boolean | null; waited: boolean }): ContentsButtonMode | null {
  const { hasContents, phone, shown, sideFits, railFits, waited } = state;
  if (!hasContents) return null;
  if (phone) return 'sheet';
  if (!shown) return sideFits || railFits === true ? 'show' : railFits === false || waited ? 'sheet' : null;
  return railFits === true ? null : (railFits === false && !sideFits) || waited ? 'sheet' : null;
}
