/**
 * The Spaces home's rules (approval "plans-home", .product/approved/plans-home/approval.md), pure, so the page and its
 * tests read the same answers:
 * - a plan's kind (its face): an HTML main page is a page; a picture or a drawn diagram an image; a table data;
 *   Markdown a document (paper);
 * - its one fact: "Your move" when the main page's newest version holds no decision of the person's (and is not the
 *   person's own); the agent at work only when the Inbox truly knows a live session is on this plan (`SpaceWork`,
 *   never guessed from a project); else the date of the last change;
 * - its unread dot: a version came that the person has not seen (read, decided on, or made);
 * - the sections: "Now" (`isNow`, the one place it is decided; never cut), "Recent" (the rest, newest first, cut by
 *   the view), "All plans" by project, a project's scope (with the projects combined into it), and search across
 *   every title;
 * - the held layout: while the person is looking, positions wait and only content changes (`heldLayout`);
 * - a document's face: the top of its main page from its first paragraph, whose first sentence is the lede, without a
 *   heading that repeats the title or a generic one (`faceParts`).
 */
import type { PlanSummary } from '@plannotator/core/plans';

export type SpaceKind = 'document' | 'page' | 'image' | 'data';

/**
 * The card's face kind, read from the main page with no judgment (home-5: "a main HTML page makes it a page, a main
 * image makes it an image, a main CSV makes it data, otherwise it is a document"). A diagram's face is its drawing,
 * so it sits flat as an image does.
 */
export function spaceKind(plan: Pick<PlanSummary, 'primary_kind'>): SpaceKind {
  switch (plan.primary_kind) {
    case 'html':
      return 'page';
    case 'image':
    case 'mermaid':
    case 'graphviz':
      return 'image';
    case 'data':
      return 'data';
    default:
      return 'document';
  }
}

/**
 * A live agent session the Inbox knows is on a plan: the session that submitted the plan's newest version (recorded
 * with it, `head_agent`), while it is live in the Inbox, and only when that is the newest plan it submitted
 * (`spaceWorks`). Never guessed from a project, a folder or a time.
 */
export interface SpaceWork {
  plan: string;
  /** The agent's name as the Inbox shows it ("Codex"). */
  agent: string;
  host: string;
  session: string;
}

/** Which live sessions are on which plan: one work at most per plan, and per session (its newest submit). */
export type SpaceWorks = SpaceWork | readonly SpaceWork[] | null;

const workOn = (plan: PlanSummary, work: SpaceWorks): SpaceWork | null => {
  if (!work) return null;
  if (!Array.isArray(work)) return (work as SpaceWork).plan === plan.id ? (work as SpaceWork) : null;
  return (work as readonly SpaceWork[]).find((w) => w.plan === plan.id) ?? null;
};

/**
 * The works the home shows, from the sessions live in the Inbox (`host:session`) and each plan's `head_agent`: a live
 * session is on the plan whose newest version it submitted last (a later submit of another plan moves it there).
 * `names`: the Inbox's name for a host, when the version recorded none.
 */
export function spaceWorks(plans: readonly PlanSummary[], live: ReadonlySet<string>, names: Readonly<Record<string, string>> = {}): SpaceWork[] {
  const newest = new Map<string, PlanSummary>();
  for (const plan of plans) {
    const agent = plan.head_agent;
    if (!agent || plan.status !== 'active' || !live.has(`${agent.host}:${agent.session}`)) continue;
    const key = `${agent.host}:${agent.session}`;
    const was = newest.get(key);
    if (!was || (plan.head_at ?? '') > (was.head_at ?? '')) newest.set(key, plan);
  }
  return [...newest.values()].map((plan) => ({ plan: plan.id, agent: plan.head_agent!.name || names[plan.head_agent!.host] || plan.head_agent!.host, host: plan.head_agent!.host, session: plan.head_agent!.session }));
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
export function spaceFact(plan: PlanSummary, works: SpaceWorks): SpaceFact {
  if (isYourMove(plan)) return { kind: 'move' };
  const work = workOn(plan, works);
  if (work) return { kind: 'working', agent: work.agent, host: work.host, session: work.session };
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

/** The next moment after `at` a plan leaves "Now" by its age alone (Infinity: none will), so the home can settle then. */
export function nextNowCrossing(plans: readonly PlanSummary[], at: number): number {
  let next = Infinity;
  for (const plan of plans) {
    const leaves = plan.head_at ? Date.parse(plan.head_at) + NOW_FRESH_MS : NaN;
    if (leaves > at && leaves < next) next = leaves;
  }
  return next;
}

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
export function isNow(plan: PlanSummary, work: SpaceWorks, now = Date.now()): boolean {
  if (workOn(plan, work)) return true;
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

export function homeSections(plans: readonly PlanSummary[], work: SpaceWorks, now = Date.now()): SpacesHomeSections {
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
function placesOf(plans: readonly PlanSummary[], work: SpaceWorks, at: number): Map<string, string> {
  const { now, recent } = homeSections(plans, work, at);
  return new Map([...now.map((p, i) => [p.id, `now:${i}`] as const), ...recent.map((p, i) => [p.id, `recent:${i}`] as const)]);
}

/**
 * The layout while the person looks: the plans as they were placed (`held`), without the ones that are gone and
 * without new ones (they wait). A held plan keeps the stamps it was placed with, so it stays in its section and its
 * place; the host draws its content (face, dot, fact) from `fresh`, in place. `pending`, the pill's "N updates": the
 * plans that arrived since, and the ones that changed and would move. A change that keeps its place is no update to
 * wait for (it is already drawn), and a plan only pushed down by another is not one either. Nothing held: `fresh`.
 *
 * `placed`: the works and the clock the layout was placed with (frozen with it, so a plan passing Now's 3 days, or an
 * agent coming or going, moves nothing while the person looks); `now`: the ones of this moment, for what would move.
 */
export function heldLayout(
  held: readonly PlanSummary[] | null,
  fresh: readonly PlanSummary[],
  placed: { work: SpaceWorks; at: number } = { work: null, at: Date.now() },
  now: { work: SpaceWorks; at: number } = placed,
): { layout: PlanSummary[]; pending: number } {
  if (!held) return { layout: [...fresh], pending: 0 };
  const byId = new Map(fresh.map((p) => [p.id, p]));
  const was = new Map(held.map((p) => [p.id, p]));
  const layout = held.filter((p) => byId.has(p.id));
  const before = placesOf(layout, placed.work, placed.at);
  const after = placesOf(fresh, now.work, now.at);
  const pending = fresh.filter((p) => {
    const then = was.get(p.id);
    if (!then) return true;
    const changed = then.updated_at !== p.updated_at || then.head_version_number !== p.head_version_number || isNow(then, placed.work, placed.at) !== isNow(p, now.work, now.at);
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

/** Section headings nearly every plan has: they tell no plan from another, so a face leaves them out (their words stay). */
const GENERIC_HEADING = /^(context|overview|summary|background|problem|goals?|introduction)$/;

/** About how many body lines (15/24 on the 420 px sheet, past its 34 px top) a card shows; the rest is cut by the card. */
export const FACE_VISIBLE_LINES = 12;
/** How near the lede a table, numbered steps or code may sit to be brought up under it: blocks, and source lines. */
const FACE_SHIFT_BLOCKS = 4;
const FACE_LOOK_LINES = 40;
/** Characters per line on the sheet: the lede (18 px) and the body (15 px), in a 348 px measure. */
const LEDE_WRAP = 34;
const BODY_WRAP = 44;

export type FaceBlockKind = 'heading' | 'text' | 'list' | 'steps' | 'table' | 'code';
export interface FaceBlock {
  start: number;
  end: number;
  kind: FaceBlockKind;
}

/** The page's blocks, in order: a heading, a fenced code block, or lines up to a blank one (by their first line). */
export function faceBlocks(lines: readonly string[]): FaceBlock[] {
  const blocks: FaceBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^ {0,3}(`{3,})/.exec(line);
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
    while (end < lines.length && lines[end]!.trim() && !HEADING.test(lines[end]!) && !/^ {0,3}`{3,}/.test(lines[end]!)) end++;
    const kind: FaceBlockKind = /^\s*\|/.test(line) ? 'table' : /^\s*\d+[.)]\s/.test(line) ? 'steps' : /^\s*[-*+]\s/.test(line) ? 'list' : 'text';
    blocks.push({ start: i, end, kind });
    i = end;
  }
  return blocks;
}

/** About how many body lines a block takes (the gap after it, and the room above a heading, count too). */
function faceHeight(block: FaceBlock, lines: readonly string[]): number {
  const own = lines.slice(block.start, block.end);
  if (block.kind === 'heading') return 1.7;
  if (block.kind === 'code') return own.length * 0.85 + 1.2;
  if (block.kind === 'table') return own.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).length * 1.4 + 0.6;
  return own.reduce((n, l) => n + Math.max(1, Math.ceil(l.trim().length / BODY_WRAP)), 0) + 0.45;
}

/** Inline Markdown as plain words (the lede is set as words, not parsed): links' text, no emphasis or code marks. */
export function plainInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A paragraph's first sentence and the rest (a sentence ends at ". ", "! " or "? " before a capital or a digit). */
function firstSentence(paragraph: string): [string, string] {
  const end = /[.!?](?=\s+["“(]?[\p{Lu}\p{N}])/u.exec(paragraph);
  if (!end || end.index > 240) return [paragraph, ''];
  return [paragraph.slice(0, end.index + 1), paragraph.slice(end.index + 1).trim()];
}

/** A face's parts: a specific first heading (shown above the lede), the lede (the first sentence, as words), and the
 * Markdown that follows it, in blocks (each drawn and compared on its own). */
export interface FaceParts {
  heading: string | null;
  lede: string;
  blocks: string[];
}

/**
 * The top of a plan's main page as its face draws it, made with no AI and nothing reordered (approval "plans-home",
 * and the owner's fidelity round): past a front matter block and a first heading that repeats the title (the card says
 * the title), it starts at the plan's first paragraph, never on a list: that paragraph's first sentence is the lede,
 * the rest follows in order. A specific first heading ("Session layout") is the top line, above the lede; a generic
 * heading ("Context", "Overview", …) is left out wherever it is, its words kept. When a table, numbered steps or a code
 * block sits a few blocks below the lede but would fall below what the card shows, the blocks between are left out so
 * it shows under the lede: the face ends early, never reorders. A plan with no paragraph near the top starts at its top.
 */
export function faceParts(text: string, title: string): FaceParts {
  let all = text.replace(/\r\n?/g, '\n').split('\n');
  if (all[0]?.trim() === '---') {
    const end = all.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) all = all.slice(end + 1);
  }
  const blocks = faceBlocks(all);
  const words = (b: FaceBlock | undefined) => (b?.kind === 'heading' ? plainHeading(HEADING.exec(all[b.start]!)![1]!) : null);
  const generic = (b: FaceBlock) => b.kind === 'heading' && GENERIC_HEADING.test((words(b) ?? '').replace(/[:.]$/, ''));
  let first = 0;
  if (words(blocks[first]) === plainHeading(title)) first++;
  const source = (b: FaceBlock) => all.slice(b.start, b.end).join('\n');
  // The first paragraph near the top (never a list's or a table's line).
  const para = blocks.findIndex((b, i) => i >= first && b.kind === 'text' && b.start - (blocks[first]?.start ?? 0) < FACE_LOOK_LINES);
  let heading: string | null = null;
  if (para < 0) return { heading: null, lede: '', blocks: blocks.slice(first).filter((b) => !generic(b)).slice(0, 12).map(source) };
  const top = blocks[first];
  if (top && top.kind === 'heading' && !generic(top) && first < para) heading = plainInline(HEADING.exec(all[top.start]!)![1]!);
  const [lede, more] = firstSentence(plainInline(all.slice(blocks[para]!.start, blocks[para]!.end).join(' ')));
  const after = blocks.slice(para + 1).filter((b) => !generic(b));
  const rest: string[] = more ? [more] : [];
  const restHeights: number[] = more ? [Math.ceil(more.length / BODY_WRAP) + 0.45] : [];
  const used = (heading ? 1.7 : 0) + Math.ceil(lede.length / LEDE_WRAP) * 1.15 + 0.45;
  for (const b of after) {
    rest.push(source(b));
    restHeights.push(faceHeight(b, all));
  }
  // A table, steps or code a few blocks down that the card would cut: brought up under the lede by leaving out what is
  // between (the face ends early there), when it then shows.
  const lead = more ? 1 : 0;
  const near = after.findIndex((b, i) => i <= FACE_SHIFT_BLOCKS && (b.kind === 'table' || b.kind === 'steps' || b.kind === 'code') && b.start - blocks[para]!.start < FACE_LOOK_LINES);
  if (near >= 0) {
    const at = near + lead;
    const before = restHeights.slice(0, at).reduce((n, h) => n + h, 0);
    const shows = (from: number) => used + from + Math.min(restHeights[at]!, 3) <= FACE_VISIBLE_LINES;
    if (!shows(before) && shows(0)) {
      // The table's own heading comes up with it when there is room for both.
      const own = at > lead && after[at - lead - 1]!.kind === 'heading' && shows(restHeights[at - 1]!) ? at - 1 : at;
      rest.splice(0, own);
    }
  }
  return { heading, lede, blocks: rest.slice(0, 14) };
}

/** A face's parts as one Markdown text (the tests' and a thumbnail's reading of it). */
export function faceMarkdown(text: string, title: string): string {
  const parts = faceParts(text, title);
  return [parts.heading ? `### ${parts.heading}` : null, parts.lede || null, ...parts.blocks].filter((b): b is string => !!b).join('\n\n');
}
