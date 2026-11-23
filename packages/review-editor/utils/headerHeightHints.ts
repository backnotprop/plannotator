export type HeaderHeightHint = (itemId: string, path: string) => number | undefined;

export function collectHeaderHeightHints(
  items: Iterable<readonly [itemId: string, path: string]>,
  hint: HeaderHeightHint | undefined,
): Map<string, number> {
  const hints = new Map<string, number>();
  if (!hint) return hints;
  for (const [itemId, path] of items) {
    const height = hint(itemId, path);
    if (height != null && Number.isFinite(height) && height > 0) hints.set(itemId, Math.ceil(height));
  }
  return hints;
}

export function headerHeightFor(
  itemId: string,
  sources: {
    measured: ReadonlyMap<string, number>;
    measuredOnce: ReadonlySet<string>;
    hints: ReadonlyMap<string, number>;
    baseHeight: number;
  },
): number {
  const measured = sources.measured.get(itemId);
  if (measured != null) return measured;
  if (sources.measuredOnce.has(itemId)) return sources.baseHeight;
  return sources.hints.get(itemId) ?? sources.baseHeight;
}
