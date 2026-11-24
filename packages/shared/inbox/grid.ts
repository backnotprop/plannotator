/**
 * Grid (approval "inbox-agent-grid", 2026-11-24, round 3): one list of the
 * pieces of work agents carry, grouped Needs you, Moving, Not moving, Landed,
 * Not started and Dropped, each with a bar of its life and the bar in words.
 *
 * A piece of work is a thread with an agent, as the window's list already has
 * it (every linked computer's rows included), with its headline PR. Nothing
 * here reads anything: the window passes what it holds (`GridThreadIn`) and
 * the time, and draws what comes back. No new agent field, tool or poll.
 *
 * What stays (the approval's decay rules):
 * - open work stays (Moving, Not moving after 20 quiet minutes, Not started);
 *   work that needs the person never leaves by age;
 * - landed work stays until the person has seen Grid since, and 3 h at least;
 *   unseen for more than 12 h it is only a count in the Since line;
 * - nothing else leaves without first being in Dropped (a PR closed unmerged,
 *   open work whose agent ended, open work quiet for 3 days);
 * - Dropped stays until seen, and 3 h at least; then Earlier, for 7 days.
 *
 * Room for round 4 (being drawn, not built): a Stale group is one more
 * `GridGroup` in `GRID_GROUPS` and one more branch in `gridPlace`; a per-line
 * action (Nudge) is one more `GridAction` kind on `GridLine.actions`.
 *
 * Pure: no runtime APIs, so the window and the tests share it.
 */

export type GridGroup = "you" | "move" | "quiet" | "land" | "plan" | "drop";

/** The groups in page order, each with its heading. Landed's heading takes its word for the time of day. */
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

/** A thread's headline PR as the window knows it: the list's summary, with the thread's PR read when there was one. */
export interface GridPullIn {
  label: string | null;
  state: "open" | "draft" | "merged" | "closed" | "unknown";
  /** When it was put on the thread (its start on the bar); null until the thread's PRs were read. */
  added_at: string | null;
  /** For a merged or closed PR: when the Inbox saw that state. */
  read_at: string | null;
  checks: "passing" | "failing" | "running" | null;
  review: "approved" | "changes_requested" | "review_required" | null;
}

/** One thread as Grid reads it (packages/inbox/grid/gridInput.ts makes it from a list row and its agent). */
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
  pull: GridPullIn | null;
}

export interface GridLine {
  id: string;
  name: string;
  /** The PR's number as shown beside the name (`#88`). */
  pr: string | null;
  machine: string | null;
  agent: GridThreadIn["agent"];
  group: GridGroup;
  /** Landed since the person last looked: drawn bold. */
  fresh: boolean;
  pieces: GridPiece[];
  merged: number | null;
  dropped: { at: number; why: GridDropWhy } | null;
  planned: number | null;
  /** What it asks the person, under the name. */
  ask: string | null;
  /** After the last piece: the PR's checks or review, or draft. */
  detail: { words: string; bad: boolean } | null;
  actions: GridAction[];
  /** The order within its group. */
  at: number;
}

export interface GridModel {
  groups: { id: GridGroup; lines: GridLine[] }[];
  counts: Record<GridGroup, number>;
  /** What happened since the person last looked; null with nothing to say (or no look yet). */
  since: { at: number; merged: number; dropped: number } | null;
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

function detailOf(pull: GridPullIn | null): GridLine["detail"] {
  if (!pull || (pull.state !== "open" && pull.state !== "draft")) return null;
  if (pull.checks === "failing") return { words: "tests failing", bad: true };
  if (pull.checks === "running") return { words: "tests running", bad: false };
  if (pull.review === "approved") return { words: "reviewed", bad: false };
  if (pull.checks === "passing") return { words: "tests passing", bad: false };
  return pull.state === "draft" ? { words: "draft", bad: false } : null;
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

/** Where one thread sits now: a shown line, a line in Earlier, a count in the Since line only, or nothing. */
export function gridPlace(t: GridThreadIn, now: number, look: number | null): { line: GridLine; place: "shown" | "earlier" | "counted" } | null {
  const start = ms(t.created_at) ?? now;
  const pull = t.pull;
  const prAt = pull ? ms(pull.added_at) : null;
  const working = t.running || (t.agentState === "working" && t.agentHere);
  const moved = Math.max(start, ms(t.last_agent_at) ?? start, ms(t.sent?.checked_at) ?? start, prAt ?? start);
  const ask = askWords(t);
  const pullOpen = !!pull && (pull.state === "open" || pull.state === "draft" || pull.state === "unknown");
  const ballWithAgent = t.section === "sent" && t.sent !== null;
  const openWork = pullOpen || ballWithAgent || working;
  const ended = t.session_ended || t.agentState === "ended";
  const unseen = (at: number) => look === null || at > look;
  const base = {
    id: t.id,
    name: t.name,
    pr: pull?.label ?? null,
    machine: t.machine,
    agent: t.agent,
    fresh: false,
    merged: null,
    dropped: null,
    planned: null,
    ask: null,
    detail: detailOf(pull),
    actions: [{ kind: "open", thread: t.id }] as GridAction[],
  } satisfies Partial<GridLine>;
  const idleOver = (end: number): GridPiece | null => (!working && end - moved >= GRID_QUIET_MS ? { kind: "idle", from: moved, to: end } : null);

  if (ask) {
    const since = ms(t.waiting_since) ?? moved;
    return { place: "shown", line: { ...base, group: "you", ask, pieces: piecesOf(start, prAt, now, { kind: "wait", from: since, to: now }), at: since } };
  }
  if (pull?.state === "merged") {
    const at = ms(pull.read_at) ?? moved;
    const line: GridLine = { ...base, group: "land", fresh: unseen(at), merged: at, pieces: piecesOf(start, prAt, at, null), at };
    if (now - at < GRID_KEEP_MS || (unseen(at) && now - at < GRID_LANDED_MAX_MS)) return { place: "shown", line };
    if (unseen(at)) return now - at < GRID_EARLIER_MS ? { place: "counted", line } : null;
    return now - at < GRID_EARLIER_MS ? { place: "earlier", line } : null;
  }
  let dropped: GridLine["dropped"] = null;
  if (pull?.state === "closed") dropped = { at: ms(pull.read_at) ?? moved, why: "PR closed" };
  else if (openWork && ended) dropped = { at: Math.max(moved, ms(t.agentEndedAt) ?? moved), why: "agent ended" };
  else if (openWork && !working && now - moved >= GRID_DROP_QUIET_MS) dropped = { at: moved + GRID_DROP_QUIET_MS, why: "quiet 3 days" };
  if (dropped) {
    const line: GridLine = { ...base, group: "drop", detail: null, dropped, pieces: piecesOf(start, prAt, dropped.at, idleOver(dropped.at)), at: dropped.at };
    if (now - dropped.at >= GRID_EARLIER_MS) return null;
    return { place: unseen(dropped.at) || now - dropped.at < GRID_KEEP_MS ? "shown" : "earlier", line };
  }
  if (!t.last_agent_at && t.sent && !t.sent.checked_at && !working) {
    const at = ms(t.sent.at) ?? start;
    return { place: "shown", line: { ...base, group: "plan", planned: at, pieces: [], at } };
  }
  // A thread whose agent answered and asks nothing, with no PR in play: the talk is done, not work in flight.
  if (!openWork) return null;
  const quiet = !working && now - moved >= GRID_QUIET_MS;
  return {
    place: "shown",
    line: { ...base, group: quiet ? "quiet" : "move", pieces: piecesOf(start, prAt, now, quiet ? idleOver(now) : null), at: quiet ? moved : start },
  };
}

const ORDER: Readonly<Record<GridGroup, (a: GridLine, b: GridLine) => number>> = {
  you: (a, b) => a.at - b.at,
  // PRs first, then the oldest start.
  move: (a, b) => Number(b.pieces.some((p) => p.kind === "pr")) - Number(a.pieces.some((p) => p.kind === "pr")) || a.at - b.at,
  quiet: (a, b) => a.at - b.at,
  land: (a, b) => b.at - a.at,
  plan: (a, b) => a.at - b.at,
  drop: (a, b) => b.at - a.at,
};

/** The whole page at `now`, for the person whose last look at Grid was `look` (null: never). */
export function gridModel(threads: readonly GridThreadIn[], now: number, look: number | null): GridModel {
  const shown = new Map<GridGroup, GridLine[]>(GRID_GROUPS.map((g) => [g.id, []]));
  const earlier: GridLine[] = [];
  let mergedSince = 0;
  let droppedSince = 0;
  for (const t of threads) {
    const placed = gridPlace(t, now, look);
    if (!placed) continue;
    const { line, place } = placed;
    if (look !== null && line.merged !== null && line.merged > look) mergedSince++;
    if (look !== null && line.dropped && line.dropped.at > look) droppedSince++;
    if (place === "shown") shown.get(line.group)!.push(line);
    else if (place === "earlier") earlier.push(line);
  }
  const groups = GRID_GROUPS.map(({ id }) => {
    let lines = shown.get(id)!.sort(ORDER[id]);
    // Moving keeps an agent's lines together, the agent with the most first (the order it had otherwise).
    if (id === "move") {
      const count = new Map<string, number>();
      for (const l of lines) count.set(l.agent?.key ?? l.id, (count.get(l.agent?.key ?? l.id) ?? 0) + 1);
      const firstAt = new Map<string, number>();
      lines.forEach((l, i) => firstAt.has(l.agent?.key ?? l.id) || firstAt.set(l.agent?.key ?? l.id, i));
      const key = (l: GridLine) => l.agent?.key ?? l.id;
      lines = [...lines].sort((a, b) => count.get(key(b))! - count.get(key(a))! || firstAt.get(key(a))! - firstAt.get(key(b))! || lines.indexOf(a) - lines.indexOf(b));
    }
    return { id, lines };
  });
  const counts = Object.fromEntries(groups.map((g) => [g.id, g.lines.length])) as Record<GridGroup, number>;
  const width = look === null ? 6 * GRID_HOUR : Math.max(6 * GRID_HOUR, Math.min(12 * GRID_HOUR, now - look + 40 * GRID_MIN));
  return {
    groups: groups.filter((g) => g.lines.length > 0),
    counts,
    since: look !== null && mergedSince + droppedSince > 0 ? { at: look, merged: mergedSince, dropped: droppedSince } : null,
    earlier: earlier.sort((a, b) => b.at - a.at),
    span: { from: now - width, to: now },
  };
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

/** "tonight", "overnight" or "today" for Landed, from the hour of the day now. */
export function gridLandedWord(hour: number): string {
  return hour >= 18 ? "tonight" : hour < 9 ? "overnight" : "today";
}
