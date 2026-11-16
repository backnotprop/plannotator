/**
 * Plans' words and the list's shape, pure. On screen it is "Plans", one item "a plan"; its files are "Artifacts".
 * A decision reads from the plan's decision record: "Approved" (with or without notes), "Changes asked" (denied, or
 * feedback sent; both local to this computer), or "No decision".
 */
import type { PlanDecisionKind, PlanSummary, PlanVersion } from '@plannotator/core/plans';

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

/** The plans a search and a project pick leave (the search matches a plan's name, case-insensitively). */
export function filterPlans(plans: readonly PlanSummary[], query: string, project: string | null): PlanSummary[] {
  const q = query.trim().toLowerCase();
  return plans.filter((p) => (project === null || (p.project_name ?? '') === project) && (!q || p.name.toLowerCase().includes(q)));
}

/** Every project a plan names, by name. */
export function planProjects(plans: readonly PlanSummary[]): string[] {
  return [...new Set(plans.map((p) => p.project_name).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b));
}
