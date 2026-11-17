/**
 * The Spaces home's rules (approval "plans-home", .product/approved/plans-home/approval.md), pure, so the page and its
 * tests read the same answers:
 * - a plan's kind (its face): an HTML main page is a page; anything else is a document (paper);
 * - its one fact: "Your move" when the main page's newest version holds no decision of the person's (and is not the
 *   person's own); the agent at work only when the Inbox truly knows a live session is on this plan (`SpaceWork`,
 *   never guessed from a project); else the date of the last change;
 * - its unread dot: a version came that the person has not seen (read, decided on, or made);
 * - the sections: "Now" (only active plans, never cut), "Recent" (the rest, newest first, cut by the view), "All
 *   plans" by project, a project's scope, and search across every title;
 * - the held layout: while the person is looking, positions wait and only content changes (`heldLayout`);
 * - a document's face: the top of its main page, without a first heading that repeats the title (`faceMarkdown`).
 */
import type { PlanSummary } from '@plannotator/core/plans';

export type SpaceKind = 'document' | 'page' | 'image' | 'data';

/** The card's face kind: an HTML main page is a page; Markdown and diagrams are documents. */
export function spaceKind(plan: Pick<PlanSummary, 'primary_kind'>): SpaceKind {
  return plan.primary_kind === 'html' ? 'page' : 'document';
}

/**
 * A live agent session the Inbox knows is on a plan: the plan its last submit was (and that is still the plan's
 * newest version), or a plan its open turn is on. None is known yet in this build: the link is the next slice's
 * (docs/agent-guides/inbox-plans.md), so no plan says an agent is working.
 */
export interface SpaceWork {
  plan: string;
  /** The agent's name as the Inbox shows it ("Codex"). */
  agent: string;
  host: string;
  session: string;
}

export type SpaceFact = { kind: 'move' } | { kind: 'working'; agent: string; host: string; session: string } | { kind: 'date'; at: string };

/** The main page's versions that hold one of the person's decisions (an older index line: its newest decision). */
function decidedVersions(plan: PlanSummary): readonly number[] {
  if (plan.decided_versions) return plan.decided_versions;
  return plan.decision ? [plan.decision.version_number ?? 1] : [];
}

/** The newest version waits on the person: no decision of theirs on it, and it is not their own edit or Restore. */
export function isYourMove(plan: PlanSummary): boolean {
  if (plan.status !== 'active' || plan.head_version_number < 1) return false;
  if (plan.head_source === 'person') return false;
  return !decidedVersions(plan).includes(plan.head_version_number);
}

/** The one grey line: "Your move", the agent at work (only with a known link to this plan), else the date. */
export function spaceFact(plan: PlanSummary, work: SpaceWork | null): SpaceFact {
  if (isYourMove(plan)) return { kind: 'move' };
  if (work && work.plan === plan.id) return { kind: 'working', agent: work.agent, host: work.host, session: work.session };
  return { kind: 'date', at: plan.updated_at };
}

/**
 * Something arrived since the person last saw the plan: its newest version is past the one they read on its page, or
 * (never opened here) past the newest they decided on in plan review. Their own version counts as seen.
 */
export function spaceUnread(plan: PlanSummary): boolean {
  if (plan.head_version_number < 1 || plan.head_source === 'person') return false;
  const decided = decidedVersions(plan);
  const seen = Math.max(plan.seen_version_number ?? 0, decided.length ? decided[decided.length - 1]! : 0);
  return plan.head_version_number > seen;
}

/** Active on the home's "Now": its move is the person's, or an agent is known to be working on it. */
export function isNow(plan: PlanSummary, work: SpaceWork | null): boolean {
  return spaceFact(plan, work).kind !== 'date';
}

const newestFirst = (a: PlanSummary, b: PlanSummary) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id);

/** How many rows "Recent" keeps in the list view. */
export const RECENT_ROWS = 8;
/** How many rows a project shows in "All plans" before "Show N more", in the list view. */
export const ALL_PLANS_ROWS = 5;

export interface SpacesHomeSections {
  now: PlanSummary[];
  /** Every other plan, newest first; the view cuts it (8 rows, or one row of cards). */
  recent: PlanSummary[];
}

export function homeSections(plans: readonly PlanSummary[], work: SpaceWork | null): SpacesHomeSections {
  const sorted = [...plans].sort(newestFirst);
  return { now: sorted.filter((p) => isNow(p, work)), recent: sorted.filter((p) => !isNow(p, work)) };
}

/** The name a plan's project is grouped under; a plan with none is under "No project". */
export const NO_PROJECT = 'No project';
export const projectOf = (plan: Pick<PlanSummary, 'project_name'>) => plan.project_name?.trim() || NO_PROJECT;

export interface SpacesGroup {
  project: string;
  plans: PlanSummary[];
}

/** Every plan by project, newest first in each; projects by their newest plan. */
export function projectGroups(plans: readonly PlanSummary[]): SpacesGroup[] {
  const groups = new Map<string, PlanSummary[]>();
  for (const plan of [...plans].sort(newestFirst)) {
    const key = projectOf(plan);
    groups.set(key, [...(groups.get(key) ?? []), plan]);
  }
  return [...groups].map(([project, list]) => ({ project, plans: list }));
}

/** A project as the sidebar lists it (the Inbox's), to scope the home to. */
export interface SpacesScopeProject {
  id: string;
  name: string;
  root?: string | null;
}

const lastPart = (root: string) => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root;

/** The plans in one of the Inbox's projects: by its id, else by its name or its folder's name. */
export function inProject(plans: readonly PlanSummary[], project: SpacesScopeProject): PlanSummary[] {
  const names = new Set([project.name, project.root ? lastPart(project.root) : null].filter((n): n is string => !!n));
  return plans.filter((p) => (p.project_id ? p.project_id === project.id : !!p.project_name && names.has(p.project_name)));
}

/** Every plan whose title holds each word of the query, in any case; an empty query is every plan. */
export function searchPlans(plans: readonly PlanSummary[], query: string): PlanSummary[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...plans];
  return plans.filter((p) => {
    const name = p.name.toLocaleLowerCase();
    return words.every((w) => name.includes(w));
  });
}

/** The person's pinned plans that are still here, in their order. */
export function pinnedPlans(plans: readonly PlanSummary[], pins: readonly string[]): PlanSummary[] {
  const byId = new Map(plans.map((p) => [p.id, p]));
  return pins.map((id) => byId.get(id)).filter((p): p is PlanSummary => !!p);
}

/** Each plan's place on the home: its section and its rank in it. */
function placesOf(plans: readonly PlanSummary[], work: SpaceWork | null): Map<string, string> {
  const { now, recent } = homeSections(plans, work);
  return new Map([...now.map((p, i) => [p.id, `now:${i}`] as const), ...recent.map((p, i) => [p.id, `recent:${i}`] as const)]);
}

/**
 * The layout while the person looks: the plans as they were placed (`held`), without the ones that are gone and
 * without new ones (they wait). A held plan keeps the stamps it was placed with, so it stays in its section and its
 * place; the host draws its content (face, dot, fact) from `fresh`, in place. `pending`, the pill's "N updates": the
 * plans that arrived since, and the ones that changed and would move. A change that keeps its place is no update to
 * wait for (it is already drawn), and a plan only pushed down by another is not one either. Nothing held: `fresh`.
 */
export function heldLayout(held: readonly PlanSummary[] | null, fresh: readonly PlanSummary[], work: SpaceWork | null = null): { layout: PlanSummary[]; pending: number } {
  if (!held) return { layout: [...fresh], pending: 0 };
  const byId = new Map(fresh.map((p) => [p.id, p]));
  const was = new Map(held.map((p) => [p.id, p]));
  const layout = held.filter((p) => byId.has(p.id));
  const before = placesOf(layout, work);
  const after = placesOf(fresh, work);
  const pending = fresh.filter((p) => {
    const then = was.get(p.id);
    if (!then) return true;
    const changed = then.updated_at !== p.updated_at || then.head_version_number !== p.head_version_number || isNow(then, work) !== isNow(p, work);
    return changed && before.get(p.id) !== after.get(p.id);
  }).length;
  return { layout, pending };
}

/** "Today", "Yesterday", "Nov 15", or "Nov 15, 2025" in another year: the date of the last change. */
export function spaceDate(at: string, now = Date.now()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '';
  const today = new Date(now);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(today) - day(when)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(when.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) };
  return when.toLocaleDateString('en-US', opts);
}

/** The fact in words, as the card's line and its spoken name say it. */
export function factWords(fact: SpaceFact, now = Date.now()): string {
  return fact.kind === 'move' ? 'Your move' : fact.kind === 'working' ? `${fact.agent} is working` : spaceDate(fact.at, now);
}

/** "1 update", "3 updates". */
export const updatesWords = (n: number) => `${n} ${n === 1 ? 'update' : 'updates'}`;

const plainHeading = (s: string) =>
  s
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();

/**
 * The top of a plan's main page as its face draws it: its words from the start (past a front matter block), without
 * the first heading when that heading is the plan's title (the card says the title already), cut to the first
 * `lines` lines (a face shows only its top).
 */
export function faceMarkdown(text: string, title: string, lines = 60): string {
  let all = text.replace(/\r\n?/g, '\n').split('\n');
  if (all[0]?.trim() === '---') {
    const end = all.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) all = all.slice(end + 1);
  }
  let first = 0;
  while (first < all.length && !all[first]!.trim()) first++;
  all = all.slice(first);
  const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(all[0] ?? '');
  if (heading && plainHeading(heading[1]!) === plainHeading(title)) {
    all = all.slice(1);
    while (all.length && !all[0]!.trim()) all = all.slice(1);
  }
  return all.slice(0, lines).join('\n');
}
