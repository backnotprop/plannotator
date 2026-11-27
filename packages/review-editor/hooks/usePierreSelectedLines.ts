import { useLayoutEffect, useState } from 'react';
import type { SelectedLineRange } from '@plannotator/ui/types';

/**
 * The `selectedLines` to hand Pierre's React `FileDiff` for the host's range.
 *
 * Pierre applies `selectedLines` only when it is defined
 * (`useFileDiffInstance`: `if (selectedLines !== undefined)
 * instance.setSelectedLines(selectedLines)`), and `undefined` is also how a
 * host leaves the selection to Pierre. A range followed straight by
 * `undefined` (Add, Cancel or Escape on the composer) therefore leaves Pierre's
 * last range in place: its highlight stays painted, the gutter "+" stays on its
 * last line whatever line the pointer is on
 * (`InteractionManager.placeUtilityFromSelection`), and the next press on the
 * "+" starts from that old range.
 *
 * So for the one render after the host's range goes away this returns `null`,
 * which clears Pierre's range, and `undefined` again from the next render, so
 * a fresh drag stays Pierre's own and paints as it goes.
 */
export function usePierreSelectedLines(
  range: SelectedLineRange | null,
): SelectedLineRange | null | undefined {
  const [previous, setPrevious] = useState(range);
  const [clearing, setClearing] = useState(false);
  if (range !== previous) {
    setPrevious(range);
    setClearing(range == null && previous != null);
  }
  useLayoutEffect(() => {
    if (clearing) setClearing(false);
  }, [clearing]);
  return range ?? (clearing ? null : undefined);
}
