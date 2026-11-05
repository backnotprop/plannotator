/**
 * Where the bar selected lines open goes (`SelectionChooser`): under the last
 * line, at the start of its code, so the lines stay readable; above the first
 * when the viewport has no room below; on screen whatever happens.
 */

/** Selected lines on screen: their top and bottom, and where their code starts. */
export interface SelectedLinesBox {
  top: number;
  bottom: number;
  left: number;
}

/** The selection as the diff reports it; split paints both columns, so its side says which. */
export interface SelectionRange {
  start: number;
  end: number;
  side?: 'deletions' | 'additions';
  endSide?: 'deletions' | 'additions';
}

const GAP = 6;
const EDGE = 8;

const within = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

export function placeChooser(
  lines: SelectedLinesBox,
  bar: { width: number; height: number },
  bounds: { top: number; bottom: number; left: number; right: number },
): { top: number; left: number } {
  const highest = bounds.top + EDGE;
  const lowest = bounds.bottom - EDGE - bar.height;
  const below = lines.bottom + GAP;
  const above = lines.top - GAP - bar.height;
  // Neither fits (more lines than the screen holds): the viewport's bottom edge, the one case it may cover them.
  const top = below <= lowest ? below : above >= highest ? above : lowest;
  return { top: within(top, highest, lowest), left: within(lines.left, bounds.left + EDGE, bounds.right - EDGE - bar.width) };
}

/** One diff's selected lines, on the side the selection ends on; `own` says whether they hold this selection's last line. */
function boxOf(painted: HTMLElement[], range: SelectionRange): SelectedLinesBox & { own: boolean } {
  const side = range.endSide ?? range.side ?? 'additions';
  const onSide = painted.filter((el) => el.closest('[data-code]')?.hasAttribute(`data-${side}`));
  const lines = onSide.length ? onSide : painted;
  const rects = lines.map((el) => el.getBoundingClientRect());
  // The gutter stays put when the code scrolls sideways; the code's own left does not.
  const gutter = lines.find((el) => el.hasAttribute('data-column-number'));
  return {
    own: lines.some((el) => el.getAttribute('data-line') === String(range.end)),
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
    left: gutter ? gutter.getBoundingClientRect().right : Math.min(...rects.map((r) => r.left)),
  };
}

/**
 * The selected lines from the diff's shadow DOM. Another diff may have lines
 * painted too (a picture's part landed there), so a diff holding this selection's
 * last line comes first, and the nearest to the pointer settles the rest. With
 * none holding it, `ownOnly` gives nothing (a new selection is painted a frame or
 * two after it opens), and otherwise the nearest of what is painted (the diff
 * draws only some of a long selection).
 */
export function readSelectedLines(range: SelectionRange, pointer: { top: number }, ownOnly = true): SelectedLinesBox | null {
  const away = (box: SelectedLinesBox) => Math.abs((box.top + box.bottom) / 2 - pointer.top);
  const boxes: (SelectedLinesBox & { own: boolean })[] = [];
  for (const host of document.querySelectorAll('diffs-container')) {
    const painted = [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-selected-line]') ?? [])];
    if (painted.length) boxes.push(boxOf(painted, range));
  }
  const own = boxes.filter((box) => box.own);
  const from = own.length || ownOnly ? own : boxes;
  return from.reduce<SelectedLinesBox | null>((nearest, box) => (!nearest || away(box) < away(nearest) ? box : nearest), null);
}
