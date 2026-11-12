import type { GuideSection } from '@plannotator/shared/guide';

export function filesViewedByTickingSection(
  sections: readonly GuideSection[],
  reviewed: readonly boolean[],
  index: number,
  filesInDiff: ReadonlySet<string>,
): string[] {
  const section = sections[index];
  if (!section || reviewed[index]) return [];
  const ticked = (i: number) => i === index || !!reviewed[i];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const ref of section.diffs) {
    const path = ref.file;
    if (seen.has(path) || !filesInDiff.has(path)) continue;
    seen.add(path);
    const everyChapterTicked = sections.every(
      (other, i) => ticked(i) || !other.diffs.some((d) => d.file === path),
    );
    if (everyChapterTicked) paths.push(path);
  }
  return paths;
}
