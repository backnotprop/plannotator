import { createTwoFilesPatch, structuredPatch } from 'diff';

const EMPTY_FEEDBACK_SENTINELS = new Set([
  '',
  'User reviewed the document and has no feedback.',
  'User reviewed the messages and has no feedback.',
]);

export interface SavedFileChangeInput {
  path: string;
  basename: string;
  beforeText: string;
  afterText: string;
}

export interface SavedFileChangePanelInput extends SavedFileChangeInput {
  key: string;
}

export interface DirectEditPanelItem {
  id: string;
  title?: string;
  label?: string;
  added: number;
  removed: number;
  description?: string;
  diffText: string;
}

export interface EditStats {
  added: number;
  removed: number;
}

export function isEmptyFeedbackSentinel(feedback: string): boolean {
  return EMPTY_FEEDBACK_SENTINELS.has(feedback);
}

export function computeEditStats(base: string, edited: string): EditStats {
  const patch = structuredPatch('plan.md', 'plan.md', base, edited, undefined, undefined, { context: 0 });
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

export function normalizeEditedMarkdown(base: string | null, current: string | null | undefined): string | null {
  if (base === null || current == null || current === base) return null;
  return current;
}

export function buildDirectEditsSection(
  base: string | null,
  current: string | null | undefined,
  sourceConverted: boolean,
): string {
  const edited = normalizeEditedMarkdown(base, current);
  if (base === null || edited === null) return '';

  const patch = createTwoFilesPatch(
    'plan.md (original)',
    'plan.md (edited)',
    base,
    edited,
    undefined,
    undefined,
    { context: 3 },
  );
  const preamble = sourceConverted
    ? 'The user edited a markdown conversion of the original source. This diff describes the desired content changes (it is not a literal patch to a file on disk):'
    : 'The user edited the document directly. Apply these exact changes — a unified diff against the version you submitted:';

  return ['# Direct Edits', '', preamble, '', '```diff', patch.trimEnd(), '```'].join('\n');
}

export function composeFeedbackWithDirectEdits(annotationsText: string, editsSection: string): string {
  if (!editsSection) return annotationsText;
  return EMPTY_FEEDBACK_SENTINELS.has(annotationsText)
    ? editsSection
    : `${editsSection}\n\n---\n\n${annotationsText}`;
}

export function buildSavedFileChangesSection(changes: SavedFileChangeInput[]): string {
  const changed = changes.filter((change) => change.beforeText !== change.afterText);
  if (changed.length === 0) return '';

  const sections = changed.map((change) => {
    const patch = createTwoFilesPatch(
      `${change.basename} (opened)`,
      `${change.basename} (saved)`,
      change.beforeText,
      change.afterText,
      undefined,
      undefined,
      { context: 3 },
    );
    return [`## ${change.path}`, '', '```diff', patch.trimEnd(), '```'].join('\n');
  });

  return [
    '# Saved File Changes',
    '',
    'The user saved these direct edits to disk during review. These changes are already applied; do not apply these patches again. Use them as context for this review.',
    '',
    ...sections,
  ].join('\n\n');
}

export function buildSavedFileChangePanelItems(changes: SavedFileChangePanelInput[]): DirectEditPanelItem[] {
  return changes.map((change) => {
    const stats = computeEditStats(change.beforeText, change.afterText);
    return {
      id: `saved:${change.key}`,
      title: 'Edits',
      label: change.path,
      added: stats.added,
      removed: stats.removed,
      description: 'Saved to disk; sent with feedback as context.',
      diffText: createTwoFilesPatch(
        `${change.basename} (opened)`,
        `${change.basename} (saved)`,
        change.beforeText,
        change.afterText,
        undefined,
        undefined,
        { context: 3 },
      ).trimEnd(),
    };
  });
}

export function buildPlanEditPanelItem(base: string, edited: string): DirectEditPanelItem {
  const stats = computeEditStats(base, edited);
  return {
    id: 'plan',
    added: stats.added,
    removed: stats.removed,
    diffText: createTwoFilesPatch('plan.md (original)', 'plan.md (edited)', base, edited, undefined, undefined, { context: 3 }),
  };
}

export function composeFeedbackWithEditSections(
  annotationsText: string,
  editsSection: string,
  savedChangesSection: string,
): string {
  const feedback = composeFeedbackWithDirectEdits(annotationsText, editsSection);
  if (!savedChangesSection) return feedback;
  if (!editsSection && isEmptyFeedbackSentinel(annotationsText)) return savedChangesSection;
  return `${savedChangesSection}\n\n---\n\n${feedback}`;
}
