/**
 * The Spaces home's rules (approval "plans-home", .product/approved/plans-home/approval.md), pure, so the page and its
 * tests read the same answers:
 * - a plan's kind (its face): an HTML main page is a page; anything else is a document (paper);
 * - its one fact: "Your move" when the main page's newest version holds no decision of the person's (and is not the
 *   person's own); the agent at work only when the Inbox truly knows a live session is on this plan (`SpaceWork`,
 *   never guessed from a project); else the date of the last change;
 * - its unread dot: a version came that the person has not seen (read, decided on, or made);
 * - the sections: "Now" (`isNow`, the one place it is decided; never cut), "Recent" (the rest, newest first, cut by
 *   the view), "All plans" by project, a project's scope (with the projects combined into it), and search across
 *   every title;
 * - the held layout: while the person is looking, positions wait and only content changes (`heldLayout`);
 * - a document's face: the top of its main page, without a first heading that repeats the title or a generic first
 *   section heading, its start moved down a few blocks at most so a table, numbered steps or code near the top shows
 *   (`faceMarkdown`).
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

/** How long a newest version keeps its plan in "Now" under the `fresh` rule. */
export const NOW_FRESH_MS = 3 * 86_400_000;

/**
 * What belongs in "Now", decided here only (the owner was asked; the answer is this one line):
 * - `fresh`: a live session is known to be on it, or its newest main-page version came in the last 3 days (by the
 *   version's own time, `head_at`: an imported version keeps its history file's time, not the import's) and it waits
 *   on the person or is unread. Older plans sit in Recent, keeping "Your move" and the unread dot (else a library of
 *   old imported plans never opened would fill "Now").
 * - `waiting`: every plan that waits on the person, however old (the first build: old plan reviews filled "Now").
 */
export const NOW_RULE = 'fresh' as 'fresh' | 'waiting';

/** On the home's "Now" (`NOW_RULE`); `now`: the time it is asked at. */
export function isNow(plan: PlanSummary, work: SpaceWork | null, now = Date.now()): boolean {
  if (work && work.plan === plan.id) return true;
  if (NOW_RULE === 'waiting') return isYourMove(plan);
  const fresh = plan.head_at != null && now - Date.parse(plan.head_at) < NOW_FRESH_MS;
  return fresh && (isYourMove(plan) || (plan.status === 'active' && spaceUnread(plan)));
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

export function homeSections(plans: readonly PlanSummary[], work: SpaceWork | null, now = Date.now()): SpacesHomeSections {
  const sorted = [...plans].sort(newestFirst);
  return { now: sorted.filter((p) => isNow(p, work, now)), recent: sorted.filter((p) => !isNow(p, work, now)) };
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

/** A project as the sidebar lists it (the Inbox's), to scope the home to; `combined`: the projects combined into it. */
export interface SpacesScopeProject {
  id: string;
  name: string;
  root?: string | null;
  combined?: readonly { id: string; name: string; root?: string | null }[];
}

const lastPart = (root: string) => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root;

/**
 * The plans in one of the Inbox's projects, the projects combined into it included: by id, else by a name or a
 * folder's name (plan review files a plan under its folder's name).
 */
export function inProject(plans: readonly PlanSummary[], project: SpacesScopeProject): PlanSummary[] {
  const all = [project, ...(project.combined ?? [])];
  const ids = new Set(all.map((p) => p.id));
  const names = new Set(all.flatMap((p) => [p.name, p.root ? lastPart(p.root) : null]).filter((n): n is string => !!n));
  return plans.filter((p) => (p.project_id ? ids.has(p.project_id) : !!p.project_name && names.has(p.project_name)));
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
function placesOf(plans: readonly PlanSummary[], work: SpaceWork | null, at: number): Map<string, string> {
  const { now, recent } = homeSections(plans, work, at);
  return new Map([...now.map((p, i) => [p.id, `now:${i}`] as const), ...recent.map((p, i) => [p.id, `recent:${i}`] as const)]);
}

/**
 * The layout while the person looks: the plans as they were placed (`held`), without the ones that are gone and
 * without new ones (they wait). A held plan keeps the stamps it was placed with, so it stays in its section and its
 * place; the host draws its content (face, dot, fact) from `fresh`, in place. `pending`, the pill's "N updates": the
 * plans that arrived since, and the ones that changed and would move. A change that keeps its place is no update to
 * wait for (it is already drawn), and a plan only pushed down by another is not one either. Nothing held: `fresh`.
 */
export function heldLayout(held: readonly PlanSummary[] | null, fresh: readonly PlanSummary[], work: SpaceWork | null = null, at = Date.now()): { layout: PlanSummary[]; pending: number } {
  if (!held) return { layout: [...fresh], pending: 0 };
  const byId = new Map(fresh.map((p) => [p.id, p]));
  const was = new Map(held.map((p) => [p.id, p]));
  const layout = held.filter((p) => byId.has(p.id));
  const before = placesOf(layout, work, at);
  const after = placesOf(fresh, work, at);
  const pending = fresh.filter((p) => {
    const then = was.get(p.id);
    if (!then) return true;
    const changed = then.updated_at !== p.updated_at || then.head_version_number !== p.head_version_number || isNow(then, work, at) !== isNow(p, work, at);
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

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** First section headings nearly every plan opens with: they tell no plan from another, so a face starts below one. */
const GENERIC_HEADING = /^(context|overview|summary|background|problem|goals?|introduction)$/;

/** About how many lines of a face's sheet a card shows (the rest is cut off by the card). */
export const FACE_VISIBLE_LINES = 12;
/** How far a face's start may move down to bring a table, numbered steps or code into view: blocks, and source lines. */
const FACE_SHIFT_BLOCKS = 4;
const FACE_LOOK_LINES = 40;

type FaceBlockKind = 'heading' | 'text' | 'list' | 'steps' | 'table' | 'code';
interface FaceBlock {
  start: number;
  end: number;
  kind: FaceBlockKind;
}

/** The page's blocks, in order: a heading, a fenced code block, or lines up to a blank one (by their first line). */
function faceBlocks(lines: readonly string[]): FaceBlock[] {
  const blocks: FaceBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      let end = i + 1;
      while (end < lines.length && !lines[end]!.trimStart().startsWith(fence[1]!)) end++;
      blocks.push({ start: i, end: Math.min(end + 1, lines.length), kind: 'code' });
      i = end + 1;
      continue;
    }
    if (HEADING.test(line)) {
      blocks.push({ start: i, end: i + 1, kind: 'heading' });
      i++;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && lines[end]!.trim() && !HEADING.test(lines[end]!) && !/^ {0,3}(`{3,}|~{3,})/.test(lines[end]!)) end++;
    const kind: FaceBlockKind = /^\s*\|/.test(line) ? 'table' : /^\s*\d+[.)]\s/.test(line) ? 'steps' : /^\s*[-*+]\s/.test(line) ? 'list' : 'text';
    blocks.push({ start: i, end, kind });
    i = end;
  }
  return blocks;
}

/** About how many sheet lines a block takes (a heading and the gap after a block count too). */
function faceHeight(block: FaceBlock, lines: readonly string[]): number {
  const own = lines.slice(block.start, block.end);
  if (block.kind === 'heading') return 1.8;
  if (block.kind === 'code') return own.length + 1;
  if (block.kind === 'table') return own.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).length * 1.3 + 0.7;
  const wrap = block.kind === 'text' ? 62 : 56;
  return own.reduce((n, l) => n + Math.max(1, Math.ceil(l.trim().length / wrap)), 0) + 0.7;
}

/**
 * The top of a plan's main page as its face draws it, made with no AI and nothing reordered: its words from the start
 * (past a front matter block), without the first heading when it is the plan's title (the card says the title) and
 * without a generic first section heading ("Context", "Overview", …: nearly every plan opens with one, so faces
 * would look alike), then cut to `lines` lines. When a table, numbered steps or a code block sits near the top but
 * below what the card shows, the start moves down by whole blocks (at most a few) until it shows; never past it, and
 * never onto a heading ("## Approach" would make faces alike again).
 */
export function faceMarkdown(text: string, title: string, lines = 60): string {
  let all = text.replace(/\r\n?/g, '\n').split('\n');
  if (all[0]?.trim() === '---') {
    const end = all.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) all = all.slice(end + 1);
  }
  const blocks = faceBlocks(all);
  let first = 0;
  const headingWords = (b: FaceBlock | undefined) => (b?.kind === 'heading' ? plainHeading(HEADING.exec(all[b.start]!)![1]!) : null);
  if (headingWords(blocks[first]) === plainHeading(title)) first++;
  if (GENERIC_HEADING.test((headingWords(blocks[first]) ?? '').replace(/[:.]$/, ''))) first++;
  // A table, steps or code near the top: start late enough (whole blocks, a few at most) for its top to show.
  const near = blocks.slice(first, first + FACE_SHIFT_BLOCKS + 2).find((b) => (b.kind === 'table' || b.kind === 'steps' || b.kind === 'code') && b.start - (blocks[first]?.start ?? 0) < FACE_LOOK_LINES);
  if (near) {
    const at = blocks.indexOf(near);
    const fits = (start: number) => blocks.slice(start, at).reduce((n, b) => n + faceHeight(b, all), 0) + Math.min(faceHeight(near, all), 3) <= FACE_VISIBLE_LINES;
    // A moved start is never a heading: "## Approach" would open every face alike again; its content leads instead.
    for (let start = first; start <= Math.min(at, first + FACE_SHIFT_BLOCKS); start++) {
      if ((start > first && blocks[start]!.kind === 'heading') || !fits(start)) continue;
      first = start;
      break;
    }
  }
  const from = blocks[first]?.start ?? all.length;
  return all.slice(from, from + lines).join('\n');
}
