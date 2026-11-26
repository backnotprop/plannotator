import type { GuideSection } from '@plannotator/shared/guide';

/**
 * Guided Review (#1786): which files ticking section `index` "Reviewed" marks
 * viewed.
 *
 * A file is marked only once EVERY section that shows it is ticked. A chapter
 * can show just part of a file (the guide may place one file in several
 * chapters), and "Viewed" means the whole file was read, so ticking the first
 * chapter of a split file must not check it off while its other hunks are
 * still ahead. Ticking the last of its chapters does.
 *
 * Only paths in `filesInDiff` (the diff on screen) are returned: guide refs go
 * stale when the diff changes after generation, and viewed state is keyed by
 * the files of the current review. Already viewed files are returned too; the
 * caller's mark is idempotent.
 *
 * Un-ticking marks nothing and unmarks nothing: the files stay as they are
 * (the approved behavior), so this returns [] when the section is already
 * ticked.
 */
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

export function sectionsWithAllFilesViewed(
  sections: readonly GuideSection[],
  filesInDiff: ReadonlySet<string>,
  viewedFiles: ReadonlySet<string>,
): Set<number> {
  const complete = new Set<number>();
  sections.forEach((section, index) => {
    const currentRefs = section.diffs.filter(({ file }) => filesInDiff.has(file));
    if (currentRefs.length > 0 && currentRefs.every(({ file }) => viewedFiles.has(file))) {
      complete.add(index);
    }
  });
  return complete;
}
