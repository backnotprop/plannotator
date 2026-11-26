/**
 * Click to pin a ref card (`components/RefHoverCard`): with it on, a plain click, tap, Enter or Space on an issue /
 * PR / MR reference written in prose opens its card pinned instead of following the link.
 *
 * Which links: only those the prose renderer marks (`REF_CARD_PROSE_ATTR`, set where `InlineMarkdown` draws a `#12`,
 * an `owner/repo#12` or a bare pasted URL), and only when the URL names the issue or PR page itself (no path after
 * the number, no `#fragment`: a comment permalink or a PR's Files tab goes where it says). Every other link, an
 * "Open on GitHub" button included, follows its href as before; a new one is safe by default.
 *
 * A host seam in the `configurePlannotatorUI` style (`refCardClick`). Default off: a click follows the link, as
 * before. Plannotator's own windows turn it on.
 */

import { parseForgeRefUrl } from '@plannotator/core/forge-ref-card';
import { refCardTarget } from './refCard';

/** The prose renderer's mark on a reference written in the text. */
export const REF_CARD_PROSE_ATTR = 'data-ref-card-prose';

let clickPins = false;

export function setRefCardClick(on: boolean): void {
  clickPins = on;
}

export function refCardClickOn(): boolean {
  return clickPins;
}

/**
 * True when `href` is the issue / PR page itself: for a forge link, the number is the path's last part and there is
 * no fragment; for a provider's link (Linear), no fragment. A query (`?notification_referrer_id=…`) still opens the
 * page itself.
 */
export function refUrlIsWhole(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.hash.length > 1) return false;
  const forge = parseForgeRefUrl(href);
  if (!forge) return true;
  const parts = url.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] === String(forge.number);
}

/** A marked prose ref with click to pin on, whose URL is the page itself: a click opens its card. */
export function refCardClickPins(a: Element): boolean {
  if (!clickPins || !a.hasAttribute(REF_CARD_PROSE_ATTR)) return false;
  const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
  return refUrlIsWhole(href) && refCardTarget(href) !== null;
}

/**
 * The attributes the prose renderer puts on a ref's link: the mark, and, when a click opens its card, that it has
 * one (`aria-haspopup`, `aria-expanded`; the card's controller sets `aria-controls` and the expanded state).
 */
export function proseRefLinkProps(href: string | null | undefined): Record<string, string | boolean> {
  const props: Record<string, string | boolean> = { [REF_CARD_PROSE_ATTR]: '' };
  if (clickPins && href && refUrlIsWhole(href) && refCardTarget(href)) {
    props['aria-haspopup'] = 'dialog';
    props['aria-expanded'] = false;
  }
  return props;
}
