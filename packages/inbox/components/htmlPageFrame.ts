import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { LinkedPageView } from '../api';

/** The query and fragment an attached HTML page opens with (`?variant=2`, `#step-2`, both), for that attachment only. */
export type PageStart = { id: string; start: string };

/** A link's `?…#…` as the start an HTML page opens with ('' when it named neither). */
function pageStartOf(search: string | undefined, hash: string): string {
  return `${search ?? ''}${hash ? `#${hash}` : ''}`;
}

/** The start a link gives an attached HTML page, or null when it named no query or fragment. */
export function pageStartAt(id: string, search: string | undefined, hash: string): PageStart | null {
  const start = pageStartOf(search, hash);
  return start ? { id, start } : null;
}

/**
 * The start the HTML page on screen opens with, as a tab opens `mock.html?variant=2`: the one `given` (a link in a
 * message), or one the pane sets (a link in another page). It holds while that attachment shows.
 */
export function usePageStart(given: PageStart | null | undefined, attachmentId: string) {
  const [pageStart, setPageStart] = useState<PageStart | null>(given ?? null);
  useEffect(() => {
    if (given) setPageStart(given);
  }, [given]);
  useEffect(() => {
    setPageStart((was) => (was && was.id !== attachmentId ? null : was));
  }, [attachmentId]);
  return [pageStart, setPageStart] as const;
}

/**
 * Full screen on a phone: its toolbar sits in the bottom right corner in both states (so a pinch's tuck never
 * resizes the page), over an HTML page's own controls there (a prototype's "1 2 3 4"). The page stops above it:
 * `--ib-pageclear` is the room it takes at the view's foot, measured from the bar's layout box. A desktop gives
 * none: its page runs to the window's foot and the gathered tools' 32 px corner control floats over it, as the
 * toolbar does at the top (a band the width of the window under the page read as broken).
 */
export function usePageClear(sectionRef: RefObject<HTMLElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!on || !section) return;
    const place = () => {
      const dock = section.querySelector<HTMLElement>('[data-full-view-dock]');
      const control = dock?.querySelector<HTMLElement>('[data-full-view-bar]') ?? null;
      const clear = dock && control ? Math.max(0, Math.ceil(dock.clientHeight - control.offsetTop) + 8) : 0;
      section.style.setProperty('--ib-pageclear', `${clear}px`);
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(section);
    return () => {
      observer?.disconnect();
      section.style.removeProperty('--ib-pageclear');
    };
  }, [sectionRef, on]);
}

/** A page an attached HTML page links to, shown read-only over it: its path in the page's folder and the fragment its link named. */
export type LinkedPage = LinkedPageView & { relative: string; hash: string; attachmentId: string };

/** The route's `linked=` value: the page's path in the folder, then `#fragment`. */
export function linkedValue(relative: string, hash: string): string {
  return hash ? `${relative}#${hash}` : relative;
}

export function splitLinked(value: string): { relative: string; hash: string } {
  const at = value.indexOf('#');
  return at < 0 ? { relative: value, hash: '' } : { relative: value.slice(0, at), hash: value.slice(at + 1) };
}
