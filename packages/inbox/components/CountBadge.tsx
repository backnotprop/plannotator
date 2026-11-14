/**
 * A small count over an icon's top-right corner: the list filter's picks (ListFilter.tsx), and the size the thread
 * header's PRs button draws its count at (PR linking, `.ib-prbtn .ib-prc-n`: 13 px across, 9.5 px bold, the quiet
 * text colour on the page's ground), so the two read as one badge. PR linking adopts this when it lands.
 *
 * Put the icon and the badge in a `.ib-cnt-host`; the icon is cut under the badge (a mask on the glyph, not a ring),
 * so it reads on any fill. The digits are centred both ways: tabular figures, a line as tall as the badge, no baseline
 * shift, and the badge's edges on whole pixels at every width (measured at 1x, 2x and 8x: within 0.06 px).
 */

/** The badge's words: up to 9, then "9+". */
export function countBadgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

export function CountBadge({ count, data }: { count: number; data?: Record<`data-${string}`, string> }) {
  const text = countBadgeText(count);
  // Two characters ("9+") take a fixed, whole-pixel width: a width from the text (16.28 px) put the badge's edge and
  // its digits between pixels.
  return (
    <span className="ib-cnt" aria-hidden="true" data-wide={text.length > 1 ? '' : undefined} {...data}>
      {text}
    </span>
  );
}
