/**
 * Settings -> Decision data's Insights (approval `.product/approved/decision-data/`, 2026-11-05): numbers over what the
 * Inbox already stores. It never bottlenecks the server: one calculation, a generator that offers to give way every few
 * hundred records, which `runInSlices` runs at most about 4 ms at a time, handing the event loop back in between and
 * stopping when the reader has gone. It runs only when a request asks: no Worker, cache, timer or stored totals.
 *
 * The one thing it adds to the store is a line per question when a thread or project is deleted (`DECISION_LINES_FILE`):
 * ids, times and what became of it, no words. Plan and code review decisions are not here; they never touch the Inbox.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INBOX_HOST_NAMES, isInboxActionReport, isInboxNote, type DecisionDataSummary, type DecisionGroup, type DecisionTrend, type InboxMessage, type InboxQuestionRecord } from "@plannotator/core/inbox-types";

export type DecisionFate = "answered" | "skipped" | "set_aside" | "replaced" | "archived" | "open" | "picked_unsent";

/** One question an agent asked; action items are not decisions. */
export interface DecisionRow {
  id: string;
  thread_id: string;
  project_id: string;
  agent: string;
  kind: string;
  asked_at: number;
  /** The last pick's moment, or the Send's when the Send carried the answer. */
  answered_at: number | null;
  sent_at: number | null;
  fate: DecisionFate;
  /** Whether the answer took the recommendation: null unless the question named one and was answered. */
  took: boolean | null;
  offered: boolean;
  stopped: boolean;
  holds_up: boolean;
  files: boolean;
  revisions: number;
}

export interface DecisionDataInput {
  /** A project's id -> the head of its combined group (a project no longer stored: itself). */
  headOf: (projectId: string) => string;
  /** A project's id -> the name the person sees, or null for a project no longer stored. */
  labelOf: (projectId: string) => string | null;
  messages: readonly InboxMessage[];
  /** The store's own map, read only, so a calculation adds no copy of it. */
  byId: ReadonlyMap<string, InboxMessage>;
  /** The Inbox's own rule: the archive closed this message's questions. One an agent sent after the archive line stays live. */
  closedByArchive: (message: InboxMessage) => boolean;
  questions: readonly InboxQuestionRecord[];
  /** `DECISION_LINES_FILE`'s text, read before the calculation. */
  deleted?: string;
}

export interface DecisionQuery {
  since: number | null;
  until: number;
  /** Minutes east of UTC at the reader. */
  tz_offset_min: number;
  now: number;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
};

function agentLabel(author: { host?: string | null; name?: string | null }): string {
  if (author.host) return INBOX_HOST_NAMES[author.host] ?? author.host;
  if (author.name) return author.name;
  return "An agent";
}

function tookRecommendation(question: InboxQuestionRecord): { offered: boolean; took: boolean | null } {
  const recommended = question.parsed.choices.filter((choice) => choice.recommended).map((choice) => choice.label);
  if (recommended.length === 0) return { offered: false, took: null };
  const answer = question.answer;
  if (!answer || answer.skipped) return { offered: true, took: null };
  if (answer.other) return { offered: true, took: false };
  const picked = new Set(answer.selected);
  return { offered: true, took: picked.size === recommended.length && recommended.every((label) => picked.has(label)) };
}

/** The row of one stored question, or null when it is not a question an agent asked. */
export function decisionRowOf(question: InboxQuestionRecord, byId: ReadonlyMap<string, InboxMessage>, headOf: (projectId: string) => string, closedByArchive: (message: InboxMessage) => boolean): DecisionRow | null {
  if (question.kind === "action") return null;
  const message = byId.get(question.message_id);
  if (!message || message.author.kind !== "agent") return null;
  const asked = ms(message.created_at);
  if (asked === null) return null;
  const sent = question.sent_reply_id ? ms(byId.get(question.sent_reply_id)?.created_at) : null;
  let fate: DecisionFate;
  if (question.superseded_by) fate = "replaced";
  else if (question.set_aside) fate = "set_aside";
  else if (question.answer && question.revision > 0 && question.sent_revision === question.revision) fate = question.answer.skipped ? "skipped" : "answered";
  else if (closedByArchive(message)) fate = "archived";
  else fate = question.answer ? "picked_unsent" : "open";
  const decided = fate === "answered" || fate === "skipped";
  const { offered, took } = tookRecommendation(question);
  return {
    id: question.id,
    thread_id: message.thread_id,
    project_id: headOf(question.project_id),
    agent: agentLabel(message.author),
    kind: question.kind,
    asked_at: asked,
    answered_at: decided ? (ms(question.picked_at) ?? sent) : null,
    sent_at: decided ? sent : null,
    fate,
    took: fate === "answered" ? took : null,
    offered,
    stopped: question.stopped !== null,
    holds_up: question.holds_up.length > 0,
    files: (message.attachments?.length ?? 0) + (message.inline_images?.length ?? 0) > 0,
    revisions: question.revision,
  };
}

const DAY_MS = 86_400_000;
/** A time every later step can use, even moved into the reader's zone: `new Date(...).toISOString()` throws past this. */
const readableTime = (at: unknown): at is number => typeof at === "number" && Number.isFinite(at) && Math.abs(at) <= 8.64e15 - 2 * DAY_MS;
const readableTimeOrNull = (at: unknown): at is number | null => at === null || readableTime(at);
const FATES: ReadonlySet<unknown> = new Set<DecisionFate>(["answered", "skipped", "set_aside", "replaced", "archived", "open", "picked_unsent"]);

/** Every field the count and the CSV use, of the type they use it as. */
function isReadableRow(row: Partial<Record<keyof DecisionRow, unknown>> | null | undefined): row is DecisionRow {
  return (
    typeof row === "object" &&
    row !== null &&
    typeof row.id === "string" &&
    typeof row.thread_id === "string" &&
    typeof row.project_id === "string" &&
    typeof row.agent === "string" &&
    typeof row.kind === "string" &&
    readableTime(row.asked_at) &&
    readableTimeOrNull(row.answered_at) &&
    readableTimeOrNull(row.sent_at) &&
    FATES.has(row.fate) &&
    (row.took === null || typeof row.took === "boolean") &&
    typeof row.offered === "boolean" &&
    typeof row.stopped === "boolean" &&
    typeof row.holds_up === "boolean" &&
    typeof row.files === "boolean" &&
    typeof row.revisions === "number" &&
    Number.isFinite(row.revisions)
  );
}

/** A stored record's row, or null for one that can't be read: it costs its own number, never the count, the CSV or a delete. */
function readableRowOf(question: InboxQuestionRecord, byId: ReadonlyMap<string, InboxMessage>, headOf: (projectId: string) => string, closedByArchive: (message: InboxMessage) => boolean): DecisionRow | null {
  try {
    const row = decisionRowOf(question, byId, headOf, closedByArchive);
    return isReadableRow(row) ? row : null;
  } catch {
    return null;
  }
}

// ── Numbers kept when a thread is deleted (round 2) ──

/** One line per question of a deleted thread or project, in the store's folder, so `uninstall --purge` removes it with the store. */
export const DECISION_LINES_FILE = "decision-lines.jsonl";

/**
 * The lines a deletion keeps: no prompt, choice, answer or note. A question nobody answered no longer waits on anyone
 * once its thread is gone, so it stays in the totals as closed, not as waiting forever.
 */
export function decisionLinesOf(questions: Iterable<InboxQuestionRecord>, byId: ReadonlyMap<string, InboxMessage>, labelOf: (projectId: string) => string | null, closedByArchive: (message: InboxMessage) => boolean): string {
  let out = "";
  for (const question of questions) {
    const row = readableRowOf(question, byId, (id) => id, closedByArchive);
    if (!row) continue;
    const fate = row.fate === "open" || row.fate === "picked_unsent" ? "archived" : row.fate;
    out += `${JSON.stringify({ v: 1, ...row, fate, project_name: labelOf(question.project_id) })}\n`;
  }
  return out;
}

/** The kept lines' text, or empty when nothing was ever deleted. Async: the read holds nothing up. */
export async function readDecisionLines(storeDir: string): Promise<string> {
  try {
    return await readFile(join(storeDir, DECISION_LINES_FILE), "utf8");
  } catch {
    return "";
  }
}

function rowOfLine(raw: string): (DecisionRow & { project_name: string | null }) | null {
  if (!raw) return null;
  let line: unknown;
  try {
    line = JSON.parse(raw);
  } catch {
    return null; // A line torn by a crash mid-write.
  }
  const row = line as (DecisionRow & { project_name?: unknown }) | null;
  // A hand edit or a later format: what can't be read is skipped, as a torn line is.
  if (!isReadableRow(row)) return null;
  return { ...row, project_name: typeof row.project_name === "string" ? row.project_name : null };
}

/** How often a loop offers to give way. The driver reads the clock only here. */
const EVERY = 256;

/** Every row: the stored questions, then the kept lines of deleted ones (a line whose question is still stored counts once). */
function* rowsSteps(input: DecisionDataInput): Generator<void, { rows: DecisionRow[]; labelOf: (projectId: string) => string }> {
  const rows: DecisionRow[] = [];
  const stored = new Set<string>();
  let tick = 0;
  for (const question of input.questions) {
    if (++tick % EVERY === 0) yield;
    stored.add(question.id);
    const row = readableRowOf(question, input.byId, input.headOf, input.closedByArchive);
    if (row) rows.push(row);
  }
  const names = new Map<string, string>();
  const lines = input.deleted ? input.deleted.split("\n") : [];
  yield;
  for (const raw of lines) {
    if (++tick % EVERY === 0) yield;
    const line = rowOfLine(raw);
    if (!line || stored.has(line.id)) continue;
    stored.add(line.id);
    const { project_name, ...row } = line;
    const project = input.headOf(row.project_id);
    if (project_name) names.set(project, project_name);
    rows.push({ ...row, project_id: project });
  }
  return { rows, labelOf: (id) => input.labelOf(id) ?? names.get(id) ?? id };
}

// ── The driver ──

export const SLICE_MS = 4;

export class DecisionDataAborted extends Error {}

/** Run a calculation at most about `SLICE_MS` at a time, giving the event loop back between slices. Stops when the reader has gone. */
export async function runInSlices<T>(steps: Generator<void, T>, signal?: AbortSignal): Promise<T> {
  let begun = performance.now();
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    if (performance.now() - begun >= SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) throw new DecisionDataAborted();
      begun = performance.now();
    }
  }
}

// ── Trends: the last 30 days against the 30 before. Two periods, no series, nothing stored. ──

export const TREND_DAYS = 30;
/** A rate is not shown under this many answers; each trend period needs this many behind it. */
export const RATE_MIN = 20;
export const MEDIAN_MIN = 5;
/** A rate has to move this much to be worth a line. */
const TREND_POINTS = 0.05;
/** A wait has to move this share of what it was. */
const TREND_WAIT_SHARE = 0.25;
/** How far from chance: at this size a change with nothing behind it shows about once in a hundred. */
const TREND_Z = 2.5;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** Two shares: is the gap bigger than chance? A plain two-proportion check. */
function clearOfChance(a: number, n: number, b: number, m: number): boolean {
  const pooled = (a + b) / (n + m);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / n + 1 / m));
  return spread > 0 && Math.abs(a / n - b / m) / spread >= TREND_Z;
}

/**
 * At most three lines, and none unless the history covers both full periods, each has enough behind it, and the change
 * is big enough to notice and too big for chance. Anything else shows nothing.
 *
 * The periods are whole UTC days and today counts in the recent one, so on unchanged data a line can change only when
 * the UTC date turns over. UTC because the reader's offset moves on a daylight-saving day, and two windows should agree.
 */
export function trendsOf(rows: readonly DecisionRow[], now: number, earliest: number | null): DecisionTrend[] {
  const end = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
  const cut = end - TREND_DAYS * DAY_MS;
  const start = end - 2 * TREND_DAYS * DAY_MS;
  if (earliest === null || earliest > start) return [];
  const period = (at: number | null): 0 | 1 | null => (at === null || at < start || at >= end ? null : at >= cut ? 0 : 1);
  const offered = [0, 0];
  const taken = [0, 0];
  const decided = [0, 0];
  const skipped = [0, 0];
  const waits: number[][] = [[], []];
  for (const row of rows) {
    const decidedIn = period(row.answered_at);
    if (decidedIn !== null) {
      decided[decidedIn]!++;
      if (row.fate === "skipped") skipped[decidedIn]!++;
      if (row.took !== null) {
        offered[decidedIn]!++;
        if (row.took) taken[decidedIn]!++;
      }
    }
    // Waits go by when the agent asked. A stopped agent still waiting counts as the longest wait, so the recent
    // period can't look short just because its slow answers haven't happened yet.
    if (!row.stopped) continue;
    const askedIn = period(row.asked_at);
    if (askedIn === null) continue;
    if (row.fate === "open" || row.fate === "picked_unsent") waits[askedIn]!.push(Infinity);
    else if (row.fate === "answered" && row.sent_at !== null) waits[askedIn]!.push(row.sent_at - row.asked_at);
  }
  const out: DecisionTrend[] = [];
  const rate = (key: "recommendations" | "skips", hit: number[], of: number[]) => {
    const [n, m] = [of[0]!, of[1]!];
    if (n < RATE_MIN || m < RATE_MIN) return;
    const [recent, before] = [hit[0]! / n, hit[1]! / m];
    if (Math.abs(recent - before) < TREND_POINTS || !clearOfChance(hit[0]!, n, hit[1]!, m)) return;
    out.push({ key, direction: recent > before ? "up" : "down", now: recent, was: before });
  };
  rate("recommendations", taken, offered);
  const [recent, before] = [waits[0]!, waits[1]!];
  if (recent.length >= RATE_MIN && before.length >= RATE_MIN) {
    const [recentMiddle, beforeMiddle] = [median(recent)!, median(before)!];
    if (Number.isFinite(recentMiddle) && Number.isFinite(beforeMiddle) && beforeMiddle > 0 && Math.abs(recentMiddle - beforeMiddle) / beforeMiddle >= TREND_WAIT_SHARE) {
      // Medians: compare how many in each period ran longer than the middle of both.
      const middle = median([...recent, ...before])!;
      const over = (list: number[]) => list.reduce((count, wait) => count + (wait > middle ? 1 : 0), 0);
      if (clearOfChance(over(recent), recent.length, over(before), before.length)) {
        out.push({ key: "waits", direction: recentMiddle > beforeMiddle ? "up" : "down", now_ms: recentMiddle, was_ms: beforeMiddle });
      }
    }
  }
  rate("skips", skipped, decided);
  return out;
}

// ── The summary ──

/** Answers with under this between them are one sitting. */
const SITTING_GAP_MS = 5 * 60_000;

const HOST_OF_LABEL: ReadonlyMap<string, string> = new Map(Object.entries(INBOX_HOST_NAMES).reverse().map(([host, name]) => [name, host]));

function* summarySteps(input: DecisionDataInput, query: DecisionQuery): Generator<void, DecisionDataSummary> {
  const { rows, labelOf } = yield* rowsSteps(input);
  let tick = 0;
  const inRange = (at: number | null): boolean => at !== null && (query.since === null || at >= query.since) && at <= query.until;
  const counts = { answered: 0, skipped: 0, set_aside: 0, replaced: 0 };
  const done: DecisionRow[] = [];
  // The whole history, whatever range is showing: enough to say "too early" and "nothing yet" with one request.
  const history = { asked: 0, answered: 0, earliest: null as number | null };
  let waiting = 0;
  for (const row of rows) {
    if (++tick % EVERY === 0) yield;
    history.asked++;
    if (row.fate === "answered") history.answered++;
    if ((row.fate === "answered" || row.fate === "skipped") && row.answered_at !== null && (history.earliest === null || row.answered_at < history.earliest)) history.earliest = row.answered_at;
    if (row.fate === "open" || row.fate === "picked_unsent") waiting++;
    if (inRange(row.asked_at) && (row.fate === "set_aside" || row.fate === "replaced")) counts[row.fate]++;
    if ((row.fate === "answered" || row.fate === "skipped") && inRange(row.answered_at)) {
      counts[row.fate]++;
      done.push(row);
    }
  }
  yield;
  done.sort((a, b) => a.answered_at! - b.answered_at!);
  yield;

  // Days, in the reader's zone.
  const dayOf = (at: number) => new Date(at + query.tz_offset_min * 60_000).toISOString().slice(0, 10);
  const dayMap = new Map<string, { day: string; answered: number; skipped: number; own_words: number }>();
  const dayEntry = (day: string) => {
    let entry = dayMap.get(day);
    if (!entry) dayMap.set(day, (entry = { day, answered: 0, skipped: 0, own_words: 0 }));
    return entry;
  };
  for (const row of done) {
    if (++tick % EVERY === 0) yield;
    dayEntry(dayOf(row.answered_at!))[row.fate === "answered" ? "answered" : "skipped"]++;
  }

  // The person's plain replies. One says something; what it settles is not stored.
  const carried = new Set<string>();
  for (const question of input.questions) {
    if (++tick % EVERY === 0) yield;
    if (question.sent_reply_id) carried.add(question.sent_reply_id);
  }
  // The person's own words by thread, as times: agent messages are not needed below, so they are not held.
  const ownWordsAt = new Map<string, number[]>();
  for (const message of input.messages) {
    if (++tick % EVERY === 0) yield;
    try {
      // A Re-ask note is a press: the Inbox writes its words, the person typed none.
      if (message.author.kind !== "person" || isInboxNote(message) || (message.reask?.length ?? 0) > 0) continue;
      const at = ms(message.created_at);
      if (!readableTime(at) || carried.has(message.id)) continue;
      const times = ownWordsAt.get(message.thread_id);
      if (times) times.push(at);
      else ownWordsAt.set(message.thread_id, [at]);
      if (inRange(at) && !isInboxActionReport(message) && !message.started_by_person && message.reply_to && !message.review_verdict && message.body.trim() !== "") dayEntry(dayOf(at)).own_words++;
    } catch {
      // A record that can't be read costs its own number.
    }
  }
  // Replaced, left open or archived after the person's own words: the nearest honest stand-in for "a plain reply settled it".
  let settledInWords = 0;
  for (const row of rows) {
    if (++tick % EVERY === 0) yield;
    if ((row.fate !== "replaced" && row.fate !== "open" && row.fate !== "archived") || !inRange(row.asked_at)) continue;
    if (ownWordsAt.get(row.thread_id)?.some((at) => at > row.asked_at)) settledInWords++;
  }

  // Pace: sittings of 3 or more answers with under five minutes between them.
  const fast = { offered: 0, taken: 0 };
  const slow = { offered: 0, taken: 0 };
  let run: DecisionRow[] = [];
  const closeRun = () => {
    if (run.length >= 3) {
      const start = run[0]!.answered_at!;
      const end = run[run.length - 1]!.answered_at!;
      if (end > start) {
        const perMinute = (run.length - 1) / ((end - start) / 60_000);
        const split = perMinute >= 2 ? fast : perMinute < 1 ? slow : null;
        if (split) {
          for (const row of run) {
            if (row.took === null) continue;
            split.offered++;
            if (row.took) split.taken++;
          }
        }
      }
    }
    run = [];
  };
  for (const row of done) {
    if (++tick % EVERY === 0) yield;
    if (run.length > 0 && row.answered_at! - run[run.length - 1]!.answered_at! > SITTING_GAP_MS) closeRun();
    run.push(row);
  }
  closeRun();
  yield;

  const stoppedWaits: number[] = [];
  let offered = 0;
  let taken = 0;
  for (const row of done) {
    if (++tick % EVERY === 0) yield;
    if (row.took !== null) {
      offered++;
      if (row.took) taken++;
    }
    if (row.fate === "answered" && row.stopped && row.sent_at !== null) stoppedWaits.push(row.sent_at - row.asked_at);
  }
  yield;

  const groupSteps = function* (key: (row: DecisionRow) => string, label: (id: string) => string, host?: (id: string) => string | undefined): Generator<void, DecisionGroup[]> {
    const groups = new Map<string, DecisionGroup & { waits: number[] }>();
    const of = (id: string) => {
      let group = groups.get(id);
      if (!group) {
        const known = host?.(id);
        groups.set(id, (group = { id, label: label(id), ...(known ? { host: known } : {}), answered: 0, skipped: 0, set_aside: 0, replaced: 0, offered: 0, taken: 0, median_wait_ms: null, waits: [] }));
      }
      return group;
    };
    for (const row of rows) {
      if (++tick % EVERY === 0) yield;
      if ((row.fate === "set_aside" || row.fate === "replaced") && inRange(row.asked_at)) of(key(row))[row.fate]++;
    }
    for (const row of done) {
      if (++tick % EVERY === 0) yield;
      const group = of(key(row));
      if (row.fate === "skipped") {
        group.skipped++;
        continue;
      }
      group.answered++;
      if (row.took !== null) {
        group.offered++;
        if (row.took) group.taken++;
      }
      if (row.sent_at !== null) group.waits.push(row.sent_at - row.asked_at);
    }
    yield;
    return [...groups.values()]
      .map(({ waits, ...group }) => ({ ...group, median_wait_ms: waits.length >= MEDIAN_MIN ? median(waits) : null }))
      .sort((a, b) => b.answered - a.answered || a.label.localeCompare(b.label));
  };
  const projects = yield* groupSteps((row) => row.project_id, labelOf);
  const agents = yield* groupSteps((row) => row.agent, (id) => id, (id) => HOST_OF_LABEL.get(id));
  yield;
  const trends = trendsOf(rows, query.now, history.earliest);
  yield;

  return {
    range: { since: query.since, until: query.until, earliest: done[0]?.answered_at ?? null },
    counts,
    settled_in_words: settledInWords,
    waiting,
    days: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    pace: { fast, slow },
    stopped_wait: { n: stoppedWaits.length, median_ms: median(stoppedWaits) },
    recommendation: { offered, taken },
    projects,
    agents,
    history,
    trends,
    rate_min: RATE_MIN,
    median_min: MEDIAN_MIN,
  };
}

/** The route's way in: the calculation, a slice at a time. */
export const decisionDataSummary = (input: DecisionDataInput, query: DecisionQuery, signal?: AbortSignal): Promise<DecisionDataSummary> => runInSlices(summarySteps(input, query), signal);

// ── The export: one line per question, times and ids, no words ──

const iso = (at: number | null) => (at === null ? "" : new Date(at).toISOString());

/**
 * A CSV cell. An agent or project name can start like a spreadsheet formula: the apostrophe keeps it text. Spaces
 * before the sign and the full-width signs count too, since a spreadsheet may read past or fold them.
 */
function cell(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  const safe = typeof value === "string" && /^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The moment the range goes by, as the page cuts it: a decision by when it was made, anything else by when it was asked. */
const rangeMoment = (row: DecisionRow): number => (row.fate === "answered" || row.fate === "skipped" ? (row.answered_at ?? row.asked_at) : row.asked_at);

function* csvSteps(input: DecisionDataInput, since: number | null): Generator<void, string> {
  const { rows, labelOf } = yield* rowsSteps(input);
  const lines = ["question_id,thread_id,project,agent,kind,fate,asked_at,answered_at,sent_at,recommendation_offered,took_recommendation,stopped,holds_up,had_files,revisions"];
  let tick = 0;
  for (const row of rows) {
    if (++tick % EVERY === 0) yield;
    if (since !== null && rangeMoment(row) < since) continue;
    lines.push(
      [row.id, row.thread_id, labelOf(row.project_id), row.agent, row.kind, row.fate, iso(row.asked_at), iso(row.answered_at), iso(row.sent_at), row.offered, row.took, row.stopped, row.holds_up, row.files, row.revisions]
        .map(cell)
        .join(","),
    );
  }
  yield;
  return `${lines.join("\n")}\n`;
}

export const decisionDataCsv = (input: DecisionDataInput, since: number | null, signal?: AbortSignal): Promise<string> => runInSlices(csvSteps(input, since), signal);
