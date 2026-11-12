export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildHeadingSlugMap(
  blocks: Array<{ id: string; type: string; content: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.type !== 'heading') continue;
    const base = slugifyHeading(block.content);
    if (!base) continue;
    const n = counts.get(base) ?? 0;
    const slug = n === 0 ? base : `${base}-${n}`;
    counts.set(base, n + 1);
    map.set(block.id, slug);
  }
  return map;
}
