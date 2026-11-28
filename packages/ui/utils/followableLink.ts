/**
 * Which links a plain click follows while Pinpoint is armed.
 *
 * Mirrors the HTML viewer bridge's `isFollowableHref` / `navigableLinkHref`
 * (`components/html-viewer/bridge-script.ts`), which runs inside the iframe as
 * a string and so cannot import this module. The two definitions are kept in
 * step by `followableLink.test.ts`. Owner's ruling `html-link-click`
 * (2026-10-20): a plain click on a link follows it, Cmd/Ctrl-click pins it.
 */

/**
 * A link with a real destination. No href, `""`, `"#"` and `javascript:` go
 * nowhere, so a click on them pins the element as on any other.
 */
export function isFollowableHref(raw: string | null | undefined): boolean {
  const href = typeof raw === 'string' ? raw.trim() : '';
  return !!href && href !== '#' && !/^javascript:/i.test(href);
}

/** The nearest `<a>` / `<area>` around `node` when it is followable, else null. */
export function followableLinkOf(node: Node | null | undefined): Element | null {
  const el = node && node.nodeType === 1 ? (node as Element) : node?.parentElement;
  if (!el || typeof el.closest !== 'function') return null;
  const link = el.closest('a,area');
  if (!link) return null;
  let raw = link.getAttribute('href');
  // SVG anchors may only carry xlink:href.
  if (typeof raw !== 'string') raw = link.getAttribute('xlink:href');
  return isFollowableHref(raw) ? link : null;
}
