import type { SavedGuideListEntry, SavedGuideWhere } from '@plannotator/shared/guide';

export const GUIDE_SEARCH_THRESHOLD = 8;

export interface GuideGroup {
  key: SavedGuideWhere;
  label: string;
  entries: SavedGuideListEntry[];
}

export function guideGroupLabel(key: SavedGuideWhere, prMode: boolean): string {
  if (key === 'diff') return 'This diff';
  if (key === 'target') return prMode ? 'This PR' : 'This branch';
  return 'Earlier';
}

export function groupSavedGuides(
  entries: readonly SavedGuideListEntry[],
  { prMode, query = '' }: { prMode: boolean; query?: string },
): GuideGroup[] {
  const q = query.trim().toLowerCase();
  const matching = q
    ? entries.filter((e) => e.title.toLowerCase().includes(q) || e.label.toLowerCase().includes(q))
    : entries;
  const order: SavedGuideWhere[] = ['diff', 'target', 'other'];
  return order
    .map((key) => ({
      key,
      label: guideGroupLabel(key, prMode),
      entries: matching.filter((e) => (e.where ?? 'other') === key).sort((a, b) => b.savedAt - a.savedAt),
    }))
    .filter((group) => group.entries.length > 0);
}

export function guideProgressText(progress: SavedGuideListEntry['progress']): string {
  if (progress.total === 0) return '';
  if (progress.reviewed === 0) return `${progress.total} chapters, not started`;
  if (progress.reviewed >= progress.total) return `All ${progress.total} chapters read`;
  return `${progress.reviewed} of ${progress.total} read`;
}

export function guideMismatchText(entry: Pick<SavedGuideListEntry, 'moved' | 'where'>): string | null {
  if (entry.where === 'diff') return null;
  if (entry.moved || entry.where === 'target') return 'Written for an earlier version of this diff';
  return null;
}

export function savedAgo(savedAt: number, now = Date.now()): string {
  if (!savedAt) return '';
  const minutes = Math.floor((now - savedAt) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function resumeFile(
  sections: ReadonlyArray<{ diffs: ReadonlyArray<{ file: string }> }>,
  reviewed: readonly boolean[],
  filesInDiff: ReadonlySet<string>,
): string | null {
  if (!reviewed.some(Boolean)) return null;
  for (let i = 0; i < sections.length; i++) {
    if (reviewed[i]) continue;
    const file = sections[i].diffs.find((d) => filesInDiff.has(d.file))?.file;
    if (file) return file;
  }
  return null;
}
