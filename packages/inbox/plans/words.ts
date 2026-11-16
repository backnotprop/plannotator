/**
 * Plans' words and the list's shape, pure. On screen it is "Plans", one item "a plan"; its files are "Artifacts".
 * A decision reads from the plan's decision record: "Approved" (with or without notes), "Changes asked" (denied, or
 * feedback sent; both local to this computer), or "No decision".
 */
import { isPlanApproval, isPlanPictureType, planMediaType, PLAN_PERSON, type PlanApprovalMoved, type PlanApprovalState, type PlanDecisionKind, type PlanSummary, type PlanVersion } from '@plannotator/core/plans';

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

/**
 * A listed plan's approval: its index line's (`approval`), else, for a line written before approvals were kept, what
 * its newest decision says of the newest version.
 */
export function summaryApproval(plan: Pick<PlanSummary, 'approval' | 'decision' | 'head_version_number'>): PlanApprovalState {
  if (plan.approval) return plan.approval;
  const d = plan.decision;
  const head = plan.head_version_number;
  if (!d) return { kind: 'none' };
  const approves = isPlanApproval(d.decision);
  if (!d.version_number || d.version_number >= head) {
    return approves ? { kind: 'approved', version_number: head, names: [PLAN_PERSON], notes: d.decision === 'approved-with-notes', moved: null } : { kind: 'changes', version_number: head };
  }
  return approves ? { kind: 'cleared', version_number: head, from_version_number: d.version_number, names: [PLAN_PERSON] } : { kind: 'undecided', version_number: head, from_version_number: d.version_number };
}

/** A plan's decision as a list shows it: "Approved" on the newest version, else "v4 is new and not approved". */
export function planDecisionWords(plan: Pick<PlanSummary, 'approval' | 'decision' | 'head_version_number'>): string {
  return approvalWords(summaryApproval(plan));
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "5 versions · 2 artifacts": what a plan holds. */
export function holdsLine(plan: Pick<PlanSummary, 'counts' | 'head_version_number'>): string {
  const parts = [plural(plan.head_version_number, 'version')];
  if (plan.counts.artifacts > 0) parts.push(plural(plan.counts.artifacts, 'artifact'));
  return parts.join(' · ');
}

/** How many versions came since the person looked (0 when not changed). */
export function newSince(plan: Pick<PlanSummary, 'changed' | 'head_version_number' | 'seen_version_number'>): number {
  return plan.changed ? Math.max(0, plan.head_version_number - (plan.seen_version_number ?? 0)) : 0;
}

/**
 * The row's last line of news: "v5 saved · you saw v3" when it changed since you looked, else what the decision
 * was ("You approved v3", "You asked for changes on v2"), else the newest version.
 */
export function newsLine(plan: Pick<PlanSummary, 'changed' | 'head_version_number' | 'seen_version_number' | 'decision'>): string {
  if (plan.changed && plan.seen_version_number) return `v${plan.head_version_number} saved · you saw v${plan.seen_version_number}`;
  const d = plan.decision;
  if (d && d.version_number) {
    const tone = decisionTone(d.decision);
    if (tone === 'approved') return `You approved v${d.version_number}`;
    if (tone === 'changes') return `You asked for changes on v${d.version_number}`;
  }
  return `v${plan.head_version_number} saved`;
}

/** A version's author as a display name only (never an email or a user id); null when none was recorded. */
export function authorOf(version: Pick<PlanVersion, 'author_label' | 'agent_name'>): string | null {
  return version.author_label?.trim() || version.agent_name?.trim() || null;
}

export interface PlanGroup {
  key: string;
  title: string;
  plans: PlanSummary[];
}

/**
 * The home list: "Since you looked" first (the plans that changed since you last opened them, newest first), then
 * the rest by project (projects by their newest change; a plan with no project last, under "No project").
 */
export function planGroups(plans: readonly PlanSummary[]): PlanGroup[] {
  const newest = (a: PlanSummary, b: PlanSummary) => b.updated_at.localeCompare(a.updated_at);
  const changed = plans.filter((p) => p.changed).sort(newest);
  const rest = plans.filter((p) => !p.changed).sort(newest);
  const byProject = new Map<string, PlanSummary[]>();
  for (const plan of rest) {
    const key = plan.project_name ?? '';
    byProject.set(key, [...(byProject.get(key) ?? []), plan]);
  }
  const groups: PlanGroup[] = changed.length ? [{ key: 'since', title: 'Since you looked', plans: changed }] : [];
  const projects = [...byProject.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0));
  for (const [key, list] of projects) groups.push({ key: `p:${key}`, title: key || 'No project', plans: list });
  return groups;
}

/** The home's two views: today's rows with previews (the default) or a compact list, one line per plan. */
export type PlansView = 'rows' | 'compact';
export const PLANS_VIEWS: readonly { id: PlansView; label: string }[] = [
  { id: 'rows', label: 'Rows with previews' },
  { id: 'compact', label: 'Compact list' },
];
/** The compact list's column headers, in order. */
export const PLANS_COMPACT_COLUMNS = { name: 'Name', project: 'Project', version: 'Version', decision: 'Decision', date: 'Last change' } as const;

/**
 * The compact list's groups: "Since you looked" first (as in the rows), then every other plan in one list, newest
 * change first, titled "Other plans" only when the first group is there. Not by project: the list has a Project
 * column, so a project heading would only say again what every row under it says.
 */
export function compactGroups(plans: readonly PlanSummary[]): PlanGroup[] {
  const newest = (a: PlanSummary, b: PlanSummary) => b.updated_at.localeCompare(a.updated_at);
  const changed = plans.filter((p) => p.changed).sort(newest);
  const rest = plans.filter((p) => !p.changed).sort(newest);
  const groups: PlanGroup[] = changed.length ? [{ key: 'since', title: 'Since you looked', plans: changed }] : [];
  if (rest.length) groups.push({ key: 'rest', title: changed.length ? 'Other plans' : '', plans: rest });
  return groups;
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
  back: 'Back to Plans',
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

/** The plans a search and a project pick leave (the search matches a plan's name, case-insensitively). */
export function filterPlans(plans: readonly PlanSummary[], query: string, project: string | null): PlanSummary[] {
  const q = query.trim().toLowerCase();
  return plans.filter((p) => (project === null || (p.project_name ?? '') === project) && (!q || p.name.toLowerCase().includes(q)));
}

/** Every project a plan names, by name. */
export function planProjects(plans: readonly PlanSummary[]): string[] {
  return [...new Set(plans.map((p) => p.project_name).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b));
}
