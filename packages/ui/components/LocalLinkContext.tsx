import { createContext, useContext } from "react";

/**
 * What a host makes of a link to a local path (`[the mock](mock.html)`):
 *
 * - `open`: draw a link (Enter and a click call `open`, the browser never
 *   follows the href). `title` is its tooltip. `href`, when given, replaces
 *   the link's own target as its href, so "Open in new tab", a modified
 *   click (Cmd/Ctrl/Shift, middle button), drag and copy use it: a host's
 *   own address for the same thing. Without it, a modified click also calls
 *   `open` and the middle button does nothing.
 * - `unavailable`: draw the link text as inert text with `title` as its
 *   tooltip: no href, so nothing is fetched or navigated.
 * - `null` from the resolver: the renderer's default for that link.
 */
export type LocalLinkResolution =
  | { kind: "open"; open: () => void; title?: string; href?: string }
  | { kind: "unavailable"; title: string };

/** Called with the link target as written (fragment and query included). */
export type LocalLinkResolver = (href: string) => LocalLinkResolution | null;

/**
 * Provided by `Viewer` from its optional `resolveLocalLink` prop. Absent
 * (null), every link renders exactly as it always has.
 */
export const LocalLinkContext = createContext<LocalLinkResolver | null>(null);

export function useLocalLinkResolver(): LocalLinkResolver | null {
  return useContext(LocalLinkContext);
}

/** A click the browser would open in a new tab or window: Cmd/Ctrl/Shift, or not the main button. */
export function isNewTabClick(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0;
}

/**
 * Whether a link target names a local path a host resolver is asked about:
 * not an in-page `#anchor`, not protocol-relative (`//host`), and no URL
 * scheme (`https:`, `mailto:`, `file:` …). A Windows drive path (`C:\x`,
 * `C:/x`) is a path.
 */
export function isLocalLinkTarget(href: string): boolean {
  const target = href.trim();
  if (target === "" || target.startsWith("#") || target.startsWith("//")) return false;
  if (/^[a-z]:[\\/]/i.test(target)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(target);
}
