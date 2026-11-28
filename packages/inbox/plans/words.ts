/**
 * A plan's words, pure. On screen the page is "Spaces", one item "a plan"; its files are "Artifacts" (the home's own
 * words are in spacesModel.ts). A decision reads from the plan's decision record: "Approved" (with or without notes),
 * "Changes asked" (denied, or feedback sent; both local to this computer), or "No decision".
 */
import { isPlanPictureType, planMediaType, PLAN_PERSON, type PlanApprovalMoved, type PlanApprovalState, type PlanDecisionKind, type PlanVersion } from '@plannotator/core/plans';

export type PlanDecisionTone = 'approved' | 'changes' | 'none';

export function decisionTone(decision: PlanDecisionKind | null | undefined): PlanDecisionTone {
  if (decision === 'approved' || decision === 'approved-with-notes') return 'approved';
  if (decision === 'denied' || decision === 'feedback') return 'changes';
  return 'none';
}

export function decisionLabel(decision: PlanDecisionKind | null | undefined): string {
  if (decision === 'approved-with-notes') return 'Approved with notes';
  const tone = decisionTone(decision);
  return tone === 'approved' ? 'Approved' : tone === 'changes' ? 'Changes asked' : 'No decision';
}

// Approval "plans-editing": an approval belongs to the current version only. A new version holds none (unless the
// person's own edit carried theirs), and the page says so in one line; history keeps the past approval on its row.

/** "You" for the person on this computer, else the recorded name. */
export const approverName = (name: string) => (name === PLAN_PERSON ? 'You' : name);

/** "You", "You and Dana", "You, Dana and Lee". */
export function approverList(names: readonly string[]): string {
  const shown = names.map(approverName);
  return shown.length <= 1 ? (shown[0] ?? 'You') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** The newest version holds no approval: "v4 is new and not approved. You approved v3, and that does not carry over." */
export function approvalClearedLine(state: { version_number: number; from_version_number: number; names: readonly string[] }): string {
  return `v${state.version_number} is new and not approved. ${approverList(state.names)} approved v${state.from_version_number}, and that does not carry over.`;
}

/** The person's own edit carried their approval: "Your approval moved to v4." */
export function approvalMovedLine(moved: Pick<PlanApprovalMoved, 'name' | 'version_number'>): string {
  return moved.name === PLAN_PERSON ? `Your approval moved to v${moved.version_number}.` : `${moved.name}’s approval moved to v${moved.version_number}.`;
}

/** Where a plan's approval stands, in a few words (a list row, the rail head). Never an old approval as current. */
export function approvalWords(state: PlanApprovalState): string {
  switch (state.kind) {
    case 'approved':
      return state.notes ? 'Approved with notes' : 'Approved';
    case 'changes':
      return 'Changes asked';
    case 'cleared':
      return `v${state.version_number} is new and not approved`;
    case 'undecided':
      return `No decision on v${state.version_number}`;
    default:
      return 'No decision';
  }
}

export function approvalTone(state: PlanApprovalState): PlanDecisionTone {
  return state.kind === 'approved' ? 'approved' : state.kind === 'changes' ? 'changes' : 'none';
}

/** A version's author as a display name only (never an email or a user id); null when none was recorded. */
export function authorOf(version: Pick<PlanVersion, 'author_label' | 'agent_name'>): string | null {
  return version.author_label?.trim() || version.agent_name?.trim() || null;
}

/**
 * A plan's left panel (the names agreed with Workspaces' space panel): "Pages" (the plan's documents, its main page
 * first and marked "Main"), then "Artifacts" (its other files) only when it has some.
 */
export const PLAN_FILES_WORDS = {
  panel: 'Files',
  pages: 'Pages',
  artifacts: 'Artifacts',
  main: 'Main',
  filter: 'Filter files',
  show: 'Show files',
  hide: 'Hide files',
  back: 'Back to Spaces',
  noPages: 'No pages',
  width: 'Files width',
  noVersions: 'Artifacts have no versions: this file is kept as it is.',
} as const;

export const noFileMatches = (query: string) => `No files match “${query}”.`;

export type PlanArtifactKind = 'image' | 'svg' | 'html' | 'pdf' | 'video' | 'other';

/**
 * What an artifact is, by its media type (an SVG is drawn as a picture, from its text). A picture only for the types
 * the server serves as pictures (`PLAN_PICTURE_TYPES`); another image type (BMP, TIFF, HEIC) is a file to download.
 */
export function artifactKind(contentType: string): PlanArtifactKind {
  const type = planMediaType(contentType);
  if (type === 'image/svg+xml') return 'svg';
  if (isPlanPictureType(type)) return 'image';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('video/')) return 'video';
  return 'other';
}

const ARTIFACT_KIND_WORDS: Record<PlanArtifactKind, string> = { image: 'Picture', svg: 'Picture (SVG)', html: 'HTML page', pdf: 'PDF', video: 'Video', other: 'File' };
export const artifactKindLabel = (contentType: string) => ARTIFACT_KIND_WORDS[artifactKind(contentType)];

/** A file's size for a person: "820 bytes", "14 KB", "2.4 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** An artifact's name on screen: its title, else the last part of its path. */
export const artifactName = (artifact: { title: string | null; asset_path: string }) => artifact.title?.trim() || artifact.asset_path.split('/').pop()!;

/** Names in the order a person expects: case ignored, numbers as numbers ("v2" before "v10"). */
export const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
