/**
 * Grid (approval "inbox-agent-grid", 2026-11-24, round 3): one list of the
 * pieces of work agents carry, grouped Needs you, Moving, Not moving, Landed,
 * Not started and Dropped, each with a bar of its life and the bar in words.
 *
 * A piece of work is a thread with an agent, as the window's list already has
 * it (every linked computer's rows included), with the PRs put on it. A PR on
 * two threads is the work of the thread it was put on first, so it is one line
 * and counts once (packages/inbox/grid/gridInput.ts decides that). Nothing
 * here reads anything: the window passes what it holds (`GridThreadIn`) and
 * the time, and draws what comes back. No new agent field, tool or poll.
 *
 * What stays (the approval's decay rules):
 * - open work stays (Moving, Not moving after 20 quiet minutes, Not started);
 *   work that needs the person never leaves by age;
 * - landed work stays until the person has seen its line, and 3 h at least;
 *   unseen for more than 12 h it is only a count in the Since line (seen when
 *   that line is), never gone while unseen;
 * - nothing else leaves without first being in Dropped (every PR closed
 *   unmerged, the agent ended, 3 days with no movement);
 * - Dropped stays until seen, and 3 h at least; then Earlier, for 7 days.
 * "Seen" is the person's look at that line (`seen`, kept with the thread on
 * its own computer). An end older than 7 days that no look ever showed (work
 * that ended before Grid could show it) is not drawn.
 *
 * Room for round 4 (being drawn, not built): a Stale group is one more
 * `GridGroup` in `GRID_GROUPS` and one more branch in `gridPlace`; a per-line
 * action (Nudge) is one more `GridAction` kind on `GridLine.actions`.
 *
 * Pure: no runtime APIs, so the window and the tests share it.
 */

export type GridGroup = "you" | "move" | "quiet" | "land" | "plan" | "drop";

/** The groups in page order, each with its heading. Landed's heading takes its word for when its work landed. */
export const GRID_GROUPS: readonly { id: GridGroup; heading: string; count: string }[] = [
  { id: "you", heading: "Needs you", count: "need you" },
  { id: "move", heading: "Moving", count: "moving" },
  { id: "quiet", heading: "Not moving", count: "not moving" },
  { id: "land", heading: "Landed", count: "landed" },
  { id: "plan", heading: "Not started", count: "not started" },
  { id: "drop", heading: "Dropped", count: "dropped" },
];

/** A piece of a bar: where the work was, from when to when (ms). */
export type GridPieceKind = "work" | "pr" | "wait" | "idle";
export interface GridPiece {
  kind: GridPieceKind;
  from: number;
  to: number;
}
export const GRID_PIECE_NAMES: Readonly<Record<GridPieceKind, string>> = { work: "Working", pr: "PR", wait: "Needs you", idle: "Not moving" };

export type GridDropWhy = "PR closed" | "agent ended" | "quiet 3 days";

/** What a line can do. Today: open its thread. Round 4's Nudge is one more kind here. */
export type GridAction = { kind: "open"; thread: string };

export const GRID_MIN = 60_000;
export const GRID_HOUR = 60 * GRID_MIN;
export const GRID_DAY = 24 * GRID_HOUR;
/** Open work with no movement this long is Not moving. */
export const GRID_QUIET_MS = 20 * GRID_MIN;
/** Landed and Dropped stay at least this long, seen or not. */
export const GRID_KEEP_MS = 3 * GRID_HOUR;
/** Landed work unseen this long is only a count in the Since line. */
export const GRID_LANDED_MAX_MS = 12 * GRID_HOUR;
/** Open work quiet this long is Dropped. */
export const GRID_DROP_QUIET_MS = 3 * GRID_DAY;
/** How long Earlier keeps what left. */
export const GRID_EARLIER_MS = 7 * GRID_DAY;
/** An end this old that no look ever showed happened before Grid could show it: not drawn. */
export const GRID_FIRST_SIGHT_MS = 7 * GRID_DAY;

/** One PR of a line, as the list's summary has it. */
export interface GridPullIn {
  key: string;
  label: string | null;
  state: "open" | "draft" | "merged" | "closed" | "unknown";
  /** When it was put on the thread (its start on the bar); null from an Inbox before the summary's items. */
  added_at: string | null;
  /** For a merged or closed PR: when the Inbox saw that state. */
  read_at: string | null;
  checks: "passing" | "failing" | "running" | null;
  review: "approved" | "changes_requested" | "review_required" | null;
}

/** A thread's checklist as Grid reads it (the row's `steps_progress`). */
export interface GridStepsIn {
  done: number;
  total: number;
  doing: string | null;
  at: string;
}

/** One thread as Grid reads it (packages/inbox/grid/gridInput.ts makes it from a list row and its agent). Times on this computer's clock. */
export interface GridThreadIn {
  id: string;
  name: string;
  /** The computer whose thread it is (`ibx_…`) when another computer's; null for this one's. */
  machine: string | null;
  agent: { key: string; name: string; host: string | null } | null;
  /** The agent's state now (null: not known), and whether this thread is the one it last worked in. */
  agentState: "working" | "idle" | "ended" | "waiting" | null;
  agentHere: boolean;
  /** When the agent was last heard, for an ended one. */
  agentEndedAt: string | null;
  /** The agent waits in its own terminal (the agent's status mark): a permission prompt or a question. */
  terminal: "permission" | "question" | null;
  /** A launched session's run line says it works. */
  running: boolean;
  created_at: string;
  last_agent_at: string | null;
  /** The list's section (`stopped`, `holding`, `waiting`, `new`, `sent`, `quiet`). */
  section: string;
  waiting_since: string | null;
  /** The first open question's words, how many are open, and how many of them are action items. */
  prompt: string | null;
  open: number;
  actions: number;
  /** The person's reply is the last message: when, and when the agent read it. */
  sent: { at: string; checked_at: string | null } | null;
  session_ended: boolean;
  /** The PRs that are this line's work, the one to name first. */
  pulls: readonly GridPullIn[];
  steps: GridStepsIn | null;
  /** The person's last look at this line (`through`: its last landing or drop that look showed; `at`: when), ms. */
  seen: { through: number; at: number } | null;
}

export interface GridLine {
  id: string;
  name: string;
  /** The PR's number as shown beside the name (`#88`). */
  pr: string | null;
  machine: string | null;
  agent: GridThreadIn["agent"];
  group: GridGroup;
  /** Landed and not seen yet: drawn bold. */
  fresh: boolean;
  /** Its landing or drop (`merged`, `dropped.at`) is not seen yet: counted in the Since line until a look shows it. */
  unseen: boolean;
  pieces: GridPiece[];
  merged: number | null;
  dropped: { at: number; why: GridDropWhy } | null;
  planned: number | null;
  /** What it asks the person, under the name. */
  ask: string | null;
  /** After the last piece: the PR's checks or review, or draft. */
  detail: { words: string; bad: boolean } | null;
  steps: GridStepsIn | null;
  actions: GridAction[];
  /** The order within its group. */
  at: number;
}

export interface GridModel {
  groups: { id: GridGroup; lines: GridLine[] }[];
  counts: Record<GridGroup, number>;
  /** What landed or dropped that the person has not seen, since their last look; null with nothing to say (or no look yet). */
  since: { at: number; merged: number; dropped: number } | null;
  /** Landed lines too long unseen to draw: only counted in the Since line, and seen when it is. */
  counted: GridLine[];
  /** What left Grid in the last 7 days, newest first. */
  earlier: GridLine[];
  /** The clock the bars share: `to` is now. */
  span: { from: number; to: number };
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
};

function askWords(t: GridThreadIn): string | null {
  if (t.waiting_since || t.open > 0 || t.section === "stopped" || t.section === "holding") {
    if (t.prompt) return t.prompt;
    if (t.actions > 0) return t.actions === 1 ? "1 action item" : `${t.actions} action items`;
    return t.open > 1 ? `${t.open} questions` : "A question";
  }
  if (t.terminal && t.agentHere) return t.terminal === "permission" ? "Asks for permission in its terminal" : "Asks a question in its terminal";
  return null;
}

const inPlay = (state: GridPullIn["state"]) => state === "open" || state === "draft" || state === "unknown";

/** A line's PRs as one: open while any is; else merged (any merged) or closed, ended at the last end. */
function prsOf(pulls: readonly GridPullIn[]): { label: string | null; at: number | null; state: "open" | "merged" | "closed"; end: number | null; detail: GridLine["detail"] } | null {
  if (pulls.length === 0) return null;
  const starts = pulls.flatMap((p) => ms(p.added_at) ?? []);
  const at = starts.length > 0 ? Math.min(...starts) : null;
  const open = pulls.filter((p) => inPlay(p.state));
  if (open.length > 0) return { label: open[0]!.label, at, state: "open", end: null, detail: detailOf(open) };
  const merged = pulls.filter((p) => p.state === "merged");
  const ends = pulls.flatMap((p) => ms(p.read_at) ?? []);
  return { label: (merged.at(-1) ?? pulls.at(-1)!).label, at, state: merged.length > 0 ? "merged" : "closed", end: ends.length > 0 ? Math.max(...ends) : null, detail: null };
}

function detailOf(open: readonly GridPullIn[]): GridLine["detail"] {
  if (open.some((p) => p.checks === "failing")) return { words: "tests failing", bad: true };
  if (open.some((p) => p.checks === "running")) return { words: "tests running", bad: false };
  const first = open[0]!;
  if (first.review === "approved") return { words: "reviewed", bad: false };
  if (first.checks === "passing") return { words: "tests passing", bad: false };
  return first.state === "draft" ? { words: "draft", bad: false } : null;
}

/** The bar: Working from the start, PR from when it was put on, and over them Needs you or Not moving to the end. */
function piecesOf(start: number, prAt: number | null, end: number, over: GridPiece | null): GridPiece[] {
  let pieces: GridPiece[] = prAt !== null && prAt < end ? [{ kind: "work", from: start, to: prAt }, { kind: "pr", from: prAt, to: end }] : [{ kind: "work", from: start, to: end }];
  if (over && over.to > over.from) {
    const cut: GridPiece[] = [];
    for (const p of pieces) {
      if (over.to <= p.from || over.from >= p.to) cut.push(p);
      else {
        if (p.from < over.from) cut.push({ kind: p.kind, from: p.from, to: over.from });
        cut.push({ kind: over.kind, from: Math.max(over.from, p.from), to: Math.min(over.to, p.to) });
        if (p.to > over.to) cut.push({ kind: p.kind, from: over.to, to: p.to });
      }
    }
    pieces = cut.filter((p, i) => !(i > 0 && cut[i - 1]!.kind === p.kind && cut[i - 1]!.to === p.from));
  }
  return pieces.filter((p) => p.to > p.from);
}

export type GridPlace = { line: GridLine; place: "shown" | "earlier" | "counted" };

/**
 * Whether a thread is a piece of work Grid shows at all. The one place that says it: today every thread with an
 * agent. What a thread with no PR carries to decide on: `steps` (a checklist, `done` of `total`, or null), `open` /
 * `prompt` / `waiting_since` (a question to the person), `running` and `agentState` with `agentHere` (its agent works
 * now, in this thread), `session_ended` and `agentState === "ended"` (its session ended), `last_agent_at`, `sent`.
 */
export function gridIsWork(t: GridThreadIn): boolean {
  return t.agent !== null;
}

/** Where one thread sits now: a shown line, a line in Earlier, a count in the Since line only, or nothing. */
export function gridPlace(t: GridThreadIn, now: number): GridPlace | null {
  return gridPlaceTimed(t, now).placed;
}

/**
 * `gridPlace`, and `until`: the first time after `now` its answer can change with the clock alone (its inputs the
 * same). A line whose bar runs to now changes each minute; a landed, dropped or not started one only when it crosses
 * one of its marks (3 h, 12 h, 3 days, a week); nothing drawn stays so.
 */
export function gridPlaceTimed(t: GridThreadIn, now: number): { placed: GridPlace | null; until: number } {
  const next = (...marks: number[]) => marks.reduce((first, mark) => (mark > now && mark < first ? mark : first), Infinity);
  const timed = (placed: GridPlace | null, until: number) => ({ placed, until });
  if (!gridIsWork(t)) return timed(null, Infinity);
  const start = ms(t.created_at) ?? now;
  const pr = prsOf(t.pulls);
  const prAt = pr?.at ?? null;
  const working = t.running || (t.agentState === "working" && t.agentHere);
  const moved = Math.max(start, ms(t.last_agent_at) ?? start, ms(t.sent?.checked_at) ?? start, prAt ?? start, ms(t.steps?.at) ?? start);
  const ask = askWords(t);
  const ended = t.session_ended || t.agentState === "ended";
  const unseen = (at: number) => t.seen === null || t.seen.through < at;
  // Seen and past its three hours: Earlier, for a week from the later of those.
  const afterSeen = (at: number, line: GridLine): GridPlace | null => (now - Math.max(at + GRID_KEEP_MS, t.seen?.at ?? 0) < GRID_EARLIER_MS ? { place: "earlier", line } : null);
  const base = {
    id: t.id,
    name: t.name,
    pr: pr?.label ?? null,
    machine: t.machine,
    agent: t.agent,
    fresh: false,
    unseen: false,
    merged: null,
    dropped: null,
    planned: null,
    ask: null,
    detail: pr?.detail ?? null,
    steps: t.steps,
    actions: [{ kind: "open", thread: t.id }] as GridAction[],
  } satisfies Partial<GridLine>;
  const idleOver = (end: number): GridPiece | null => (!working && end - moved >= GRID_QUIET_MS ? { kind: "idle", from: moved, to: end } : null);

  // The marks an ended line crosses: first sight, its 3 hours, 12 hours unseen, Earlier's week.
  const endMarks = (at: number) => [at + GRID_FIRST_SIGHT_MS, at + GRID_KEEP_MS, at + GRID_LANDED_MAX_MS, Math.max(at + GRID_KEEP_MS, t.seen?.at ?? 0) + GRID_EARLIER_MS];
  const minute = now + GRID_MIN;

  if (ask) {
    const since = ms(t.waiting_since) ?? moved;
    return timed({ place: "shown", line: { ...base, group: "you", ask, pieces: piecesOf(start, prAt, now, { kind: "wait", from: since, to: now }), at: since } }, minute);
  }
  if (pr?.state === "merged") {
    const at = pr.end ?? moved;
    if (t.seen === null && now - at >= GRID_FIRST_SIGHT_MS) return timed(null, Infinity);
    const line: GridLine = { ...base, group: "land", fresh: unseen(at), unseen: unseen(at), merged: at, pieces: piecesOf(start, prAt, at, null), at };
    const until = next(...endMarks(at));
    if (unseen(at)) return timed({ place: now - at < GRID_LANDED_MAX_MS ? "shown" : "counted", line }, until);
    return timed(now - at < GRID_KEEP_MS ? { place: "shown", line } : afterSeen(at, line), until);
  }
  let dropped: GridLine["dropped"] = null;
  if (pr?.state === "closed") dropped = { at: pr.end ?? moved, why: "PR closed" };
  else if (ended && !working) dropped = { at: Math.max(moved, ms(t.agentEndedAt) ?? moved), why: "agent ended" };
  else if (!working && now - moved >= GRID_DROP_QUIET_MS) dropped = { at: moved + GRID_DROP_QUIET_MS, why: "quiet 3 days" };
  if (dropped) {
    if (t.seen === null && now - dropped.at >= GRID_FIRST_SIGHT_MS) return timed(null, Infinity);
    const line: GridLine = { ...base, group: "drop", detail: null, unseen: unseen(dropped.at), dropped, pieces: piecesOf(start, prAt, dropped.at, idleOver(dropped.at)), at: dropped.at };
    return timed(unseen(dropped.at) || now - dropped.at < GRID_KEEP_MS ? { place: "shown", line } : afterSeen(dropped.at, line), next(...endMarks(dropped.at)));
  }
  if (!t.last_agent_at && t.sent && !t.sent.checked_at && !working) {
    const at = ms(t.sent.at) ?? start;
    // Not started stays as it is until three quiet days drop it.
    return timed({ place: "shown", line: { ...base, group: "plan", planned: at, pieces: [], at } }, next(moved + GRID_DROP_QUIET_MS));
  }
  // Every other thread with an agent is open work: Moving, then Not moving after 20 quiet minutes, then Dropped.
  const quiet = !working && now - moved >= GRID_QUIET_MS;
  return timed(
    {
      place: "shown",
      line: { ...base, group: quiet ? "quiet" : "move", pieces: piecesOf(start, prAt, now, quiet ? idleOver(now) : null), at: quiet ? moved : start },
    },
    minute,
  );
}

/** Two of Grid's inputs for one thread are the same (field by field; no JSON): its place need not be worked out again. */
export function gridSameIn(a: GridThreadIn, b: GridThreadIn): boolean {
  if (a === b) return true;
  for (const key of Object.keys(a) as (keyof GridThreadIn)[]) {
    const x = a[key];
    const y = b[key];
    if (x === y) continue;
    if (key === "pulls") {
      const p = x as GridThreadIn["pulls"];
      const q = y as GridThreadIn["pulls"];
      if (p.length !== q.length || p.some((pull, i) => !sameFlat(pull, q[i]!))) return false;
    } else if (!x || !y || typeof x !== "object" || typeof y !== "object" || !sameFlat(x, y)) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
}

const sameFlat = (x: object, y: object): boolean => {
  const a = x as Record<string, unknown>;
  const b = y as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const hasPr = (l: GridLine) => l.pieces.some((p) => p.kind === "pr");
const ORDER: Readonly<Record<GridGroup, (a: GridLine, b: GridLine) => number>> = {
  you: (a, b) => a.at - b.at,
  // PRs first, then the oldest start.
  move: (a, b) => Number(hasPr(b)) - Number(hasPr(a)) || a.at - b.at,
  quiet: (a, b) => a.at - b.at,
  land: (a, b) => b.at - a.at,
  plan: (a, b) => a.at - b.at,
  drop: (a, b) => b.at - a.at,
};

/** Moving keeps an agent's lines together, the agent with the most first, each kept in the order it had. O(n log n). */
function byAgent(lines: GridLine[]): GridLine[] {
  const key = (l: GridLine) => l.agent?.key ?? l.id;
  const count = new Map<string, number>();
  const first = new Map<string, number>();
  lines.forEach((l, i) => {
    const k = key(l);
    count.set(k, (count.get(k) ?? 0) + 1);
    if (!first.has(k)) first.set(k, i);
  });
  return lines
    .map((line, i) => ({ line, i, n: count.get(key(line))!, f: first.get(key(line))! }))
    .sort((a, b) => b.n - a.n || a.f - b.f || a.i - b.i)
    .map((x) => x.line);
}

/**
 * The page, kept between reads: each thread's place is worked out again only when what Grid reads of it, or the
 * minute, changed, and a line that comes out the same is the same object as before (so its drawing is kept). A read
 * costs O(n) to compare and O(n log n) to sort, n the threads.
 */
export function createGridModel(): (threads: readonly GridThreadIn[], now: number) => GridModel {
  type Held = { input: GridThreadIn; now: number; until: number; placed: GridPlace | null };
  let held = new Map<string, Held>();
  return (threads, now) => {
    const next = new Map<string, Held>();
    const placedAll: GridPlace[] = [];
    let look: number | null = null;
    for (const t of threads) {
      if (t.seen && (look === null || t.seen.at > look)) look = t.seen.at;
      const was = held.get(t.id);
      // Kept, the same object (a memoized line does not draw again), while its inputs are the same and the clock has
      // not reached a mark that changes it: a minute for a bar that runs to now, else 3 h, 12 h, 3 days or a week.
      let entry = was && now >= was.now && now < was.until && gridSameIn(was.input, t) ? was : null;
      if (!entry) {
        const { placed, until } = gridPlaceTimed(t, now);
        entry = { input: t, now, until, placed };
      }
      next.set(t.id, entry);
      if (entry.placed) placedAll.push(entry.placed);
    }
    held = next;
    return assemble(placedAll, now, look);
  };
}

function assemble(placed: readonly GridPlace[], now: number, look: number | null): GridModel {
  const shown = new Map<GridGroup, GridLine[]>(GRID_GROUPS.map((g) => [g.id, []]));
  const earlier: GridLine[] = [];
  const counted: GridLine[] = [];
  let mergedSince = 0;
  let droppedSince = 0;
  for (const { line, place } of placed) {
    if (line.unseen && line.merged !== null) mergedSince++;
    if (line.unseen && line.dropped) droppedSince++;
    if (place === "shown") shown.get(line.group)!.push(line);
    else if (place === "earlier") earlier.push(line);
    else counted.push(line);
  }
  const groups = GRID_GROUPS.map(({ id }) => {
    const lines = shown.get(id)!.sort(ORDER[id]);
    return { id, lines: id === "move" ? byAgent(lines) : lines };
  });
  const counts = Object.fromEntries(groups.map((g) => [g.id, g.lines.length])) as Record<GridGroup, number>;
  const width = look === null ? 6 * GRID_HOUR : Math.max(6 * GRID_HOUR, Math.min(12 * GRID_HOUR, now - look + 40 * GRID_MIN));
  return {
    groups: groups.filter((g) => g.lines.length > 0),
    counts,
    since: look !== null && mergedSince + droppedSince > 0 ? { at: look, merged: mergedSince, dropped: droppedSince } : null,
    counted,
    earlier: earlier.sort((a, b) => b.at - a.at),
    span: { from: now - width, to: now },
  };
}

/** The whole page at `now`, once (the window keeps one `createGridModel` between reads). */
export function gridModel(threads: readonly GridThreadIn[], now: number): GridModel {
  return createGridModel()(threads, now);
}

/** A length as a line says it: minutes under an hour, then half hours, then days ("32 min", "1.5 h", "3 d"). */
export function gridRounded(length: number): string {
  const minutes = Math.max(1, Math.round(length / GRID_MIN));
  if (minutes < 60) return `${minutes} min`;
  if (minutes >= 2 * 24 * 60) return `${Math.floor(minutes / (24 * 60))} d`;
  if (minutes >= 24 * 60) return "1 d";
  return `${Math.round(minutes / 30) / 2} h`;
}

/** A length as the readout says it: "40 min", "2 h 10 min" under three hours, then hours, then days. */
export function gridExact(length: number): string {
  const minutes = Math.max(1, Math.floor(length / GRID_MIN));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 48) return `${Math.floor(h / 24)} d`;
  if (h >= 24) return "1 d";
  return h < 3 && m ? `${h} h ${m} min` : `${h} h`;
}

/** A length as a screen reader says it: the line's words with the units in full ("2 hours", "32 minutes"). */
export function gridSpoken(length: string): string {
  return length.replace(/(\d) h\b/g, (_, n) => `${n} ${n === "1" ? "hour" : "hours"}`).replace(/(\d) min\b/g, "$1 minutes").replace(/(\d) d\b/g, (_, n) => `${n} ${n === "1" ? "day" : "days"}`);
}

/** One piece of a line's words: its kind, its name, how long; `on`: where the work is now. */
export interface GridSaid {
  kind: GridPieceKind;
  name: string;
  length: string;
  on: boolean;
}

/**
 * The bar in words, at most three pieces (two on a phone when there are more): the oldest are cut, and `cut` says so
 * (the line starts with "…"; the readout has them all). On a desktop line the pieces also have to fit `room`
 * characters, keeping two at least.
 */
export function gridSaid(line: GridLine, options: { phone: boolean; room?: number } = { phone: false }): { cut: boolean; pieces: GridSaid[] } {
  const all = line.pieces.map((p, i, list) => ({ kind: p.kind, name: GRID_PIECE_NAMES[p.kind], length: gridRounded(p.to - p.from), on: i === list.length - 1 && line.merged === null }));
  let shown = options.phone && all.length > 3 ? all.slice(-2) : all.slice(-3);
  const room = options.room ?? 50;
  const width = (pieces: GridSaid[]) => pieces.reduce((n, p) => n + p.name.length + p.length.length + 4, pieces.length < all.length ? 3 : 0);
  while (!options.phone && shown.length > 2 && width(shown) > room) shown = shown.slice(1);
  return { cut: shown.length < all.length, pieces: shown };
}

/**
 * Landed's word, from when its work landed (local time, `offset`: minutes east of UTC at `now`, as `-getTimezoneOffset()`):
 * "tonight" when all of it landed since 6 PM today, "overnight" when all of it landed between 6 PM yesterday and noon
 * and it is not noon yet, "today" when all of it landed today; else none ("4 landed").
 */
export function gridLandedWord(times: readonly number[], now: number, offset: number): string | null {
  if (times.length === 0) return null;
  const local = (at: number) => at + offset * GRID_MIN;
  const dayStart = Math.floor(local(now) / GRID_DAY) * GRID_DAY;
  const hours = (at: number) => (local(at) - dayStart) / GRID_HOUR;
  const first = Math.min(...times);
  if (hours(first) >= 18) return "tonight";
  if (hours(now) < 12 && hours(first) >= -6 && times.every((at) => hours(at) < 9)) return "overnight";
  if (hours(first) >= 0) return "today";
  return null;
}

/** The whole hours, local time, after `from` and before `to`: where the clock's ticks go (a :30 or :45 zone included). */
export function gridHourTicks(from: number, to: number): number[] {
  const out: number[] = [];
  const at = new Date(from);
  at.setMinutes(0, 0, 0);
  if (at.getTime() <= from) at.setHours(at.getHours() + 1);
  for (let guard = 0; at.getTime() < to && guard < 48; guard++) {
    out.push(at.getTime());
    at.setHours(at.getHours() + 1);
  }
  return out;
}
