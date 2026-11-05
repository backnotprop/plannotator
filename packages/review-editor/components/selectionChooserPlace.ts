/**
 * Where the bar selected lines open goes (`SelectionChooser`): under the last
 * line, at the start of its code, so the lines stay readable; above the first
 * when the viewport has no room below; on screen whatever happens. With its
 * lines off screen, or dropped by the diff, the bar has nothing to sit by and hides.
 */

/** Selected lines on screen: their top and bottom, and where their code starts. */
export interface SelectedLinesBox {
  top: number;
  bottom: number;
  left: number;
}

/** Lines as read from a diff: which diff, whether they hold the selection's last line, and what of the screen can show them. */
export interface ReadLines extends SelectedLinesBox {
  host: Element;
  own: boolean;
  /** The part of the screen the scrollers around the lines show (lines outside it can't be seen). */
  shownTop: number;
  shownBottom: number;
  /** The top of the page's own scroller, under whatever header sits above it. */
  roof: number;
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

/** Not on screen: past the edge of a scroller around them, or of the viewport. */
export function linesOffScreen(lines: ReadLines, bounds: { top: number; bottom: number }): boolean {
  return lines.bottom <= Math.max(lines.shownTop, bounds.top) || lines.top >= Math.min(lines.shownBottom, bounds.bottom);
}

/** What the scrollers around an element show of the screen, walking out of the diff's shadow root too. */
function shownAround(start: Element): Pick<ReadLines, 'shownTop' | 'shownBottom' | 'roof'> {
  let shownTop = -Infinity;
  let shownBottom = Infinity;
  let roof = -Infinity;
  for (let el: Element | null = start; el && el !== document.body && el !== document.documentElement; ) {
    const overflow = getComputedStyle(el).overflowY;
    if (/auto|scroll|hidden|clip/.test(overflow)) {
      const rect = el.getBoundingClientRect();
      shownTop = Math.max(shownTop, rect.top);
      shownBottom = Math.min(shownBottom, rect.bottom);
      if (overflow !== 'hidden' && overflow !== 'clip' && el.scrollHeight > el.clientHeight) roof = rect.top;
    }
    el = el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null;
  }
  return { shownTop, shownBottom, roof };
}

/** One diff's selected lines, on the side the selection ends on; `own` says whether they hold this selection's last line. */
function readHost(host: Element, range: SelectionRange): ReadLines | null {
  const painted = [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-selected-line]') ?? [])];
  if (!painted.length) return null;
  const side = range.endSide ?? range.side ?? 'additions';
  const onSide = painted.filter((el) => el.closest('[data-code]')?.hasAttribute(`data-${side}`));
  const lines = onSide.length ? onSide : painted;
  const rects = lines.map((el) => el.getBoundingClientRect());
  // The gutter stays put when the code scrolls sideways; the code's own left does not.
  const gutter = lines.find((el) => el.hasAttribute('data-column-number'));
  return {
    host,
    own: lines.some((el) => el.getAttribute('data-line') === String(range.end)),
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
    left: gutter ? gutter.getBoundingClientRect().right : Math.min(...rects.map((r) => r.left)),
    ...shownAround(lines[0]!),
  };
}

/**
 * The selected lines from the diff's shadow DOM. Once the bar has found its diff
 * (`diff`) it reads only that one: line numbers can't tell two files apart. Before
 * that, another diff may have lines painted too (a picture's part landed there), so
 * a diff holding this selection's last line comes first, and the nearest to the
 * pointer settles the rest. With none holding it, `ownOnly` gives nothing (a new
 * selection is painted a frame or two after it opens), and otherwise the nearest of
 * what is painted (the diff draws only some of a long selection).
 */
export function readSelectedLines(range: SelectionRange, pointer: { top: number }, ownOnly = true, diff?: Element | null): ReadLines | null {
  if (diff) return readHost(diff, range);
  const away = (box: SelectedLinesBox) => Math.abs((box.top + box.bottom) / 2 - pointer.top);
  const boxes = [...document.querySelectorAll('diffs-container')].flatMap((host) => readHost(host, range) ?? []);
  const own = boxes.filter((box) => box.own);
  const from = own.length || ownOnly ? own : boxes;
  return from.reduce<ReadLines | null>((nearest, box) => (!nearest || away(box) < away(nearest) ? box : nearest), null);
}
