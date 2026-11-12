import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INBOX_HOST_NAMES, isInboxActionReport, isInboxNote, type DecisionDataSummary, type DecisionGroup, type DecisionTrend, type InboxMessage, type InboxQuestionRecord } from "@plannotator/core/inbox-types";

export type DecisionFate = "answered" | "skipped" | "set_aside" | "replaced" | "archived" | "open" | "picked_unsent";

export interface DecisionRow {
  id: string;
  thread_id: string;
  project_id: string;
  agent: string;
  kind: string;
  asked_at: number;
  answered_at: number | null;
  sent_at: number | null;
  fate: DecisionFate;
  took: boolean | null;
  offered: boolean;
  stopped: boolean;
  holds_up: boolean;
  files: boolean;
  revisions: number;
}

export interface DecisionDataInput {
  headOf: (projectId: string) => string;
  labelOf: (projectId: string) => string | null;
  messages: readonly InboxMessage[];
  byId: ReadonlyMap<string, InboxMessage>;
  closedByArchive: (message: InboxMessage) => boolean;
  reaskListedIds: (threadId: string) => ReadonlySet<string>;
  questions: readonly InboxQuestionRecord[];
  deleted?: string;
}

export interface DecisionQuery {
  since: number | null;
  until: number;
  tz_offset_min: number;
  now: number;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
};

export function agentLabel(author: { host?: string | null; name?: string | null }): string {
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
const readableTime = (at: unknown): at is number => typeof at === "number" && Number.isFinite(at) && Math.abs(at) <= 8.64e15 - 2 * DAY_MS;
const readableTimeOrNull = (at: unknown): at is number | null => at === null || readableTime(at);
const FATES: ReadonlySet<unknown> = new Set<DecisionFate>(["answered", "skipped", "set_aside", "replaced", "archived", "open", "picked_unsent"]);

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

function readableRowOf(question: InboxQuestionRecord, byId: ReadonlyMap<string, InboxMessage>, headOf: (projectId: string) => string, closedByArchive: (message: InboxMessage) => boolean): DecisionRow | null {
  try {
    const row = decisionRowOf(question, byId, headOf, closedByArchive);
    return isReadableRow(row) ? row : null;
  } catch {
    return null;
  }
}

export const DECISION_LINES_FILE = "decision-lines.jsonl";

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
    return null;
  }
  const row = line as (DecisionRow & { project_name?: unknown }) | null;
  if (!isReadableRow(row)) return null;
  return { ...row, project_name: typeof row.project_name === "string" ? row.project_name : null };
}

const EVERY = 256;

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

export const SLICE_MS = 4;

export class DecisionDataAborted extends Error {}

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

export function ownWordsTime(message: InboxMessage, carried: ReadonlySet<string>): number | null {
  if (message.author.kind !== "person" || isInboxNote(message) || (message.reask?.length ?? 0) > 0) return null;
  const at = ms(message.created_at);
  if (!readableTime(at) || carried.has(message.id)) return null;
  return at;
}

export const TREND_DAYS = 30;
export const RATE_MIN = 20;
export const MEDIAN_MIN = 5;
const TREND_POINTS = 0.05;
const TREND_WAIT_SHARE = 0.25;
const TREND_Z = 2.5;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)]!;
};

function clearOfChance(a: number, n: number, b: number, m: number): boolean {
  const pooled = (a + b) / (n + m);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / n + 1 / m));
  return spread > 0 && Math.abs(a / n - b / m) / spread >= TREND_Z;
}

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

const SITTING_GAP_MS = 5 * 60_000;

const HOST_OF_LABEL: ReadonlyMap<string, string> = new Map(Object.entries(INBOX_HOST_NAMES).reverse().map(([host, name]) => [name, host]));

function* summarySteps(input: DecisionDataInput, query: DecisionQuery): Generator<void, DecisionDataSummary> {
  const { rows, labelOf } = yield* rowsSteps(input);
  let tick = 0;
  const inRange = (at: number | null): boolean => at !== null && (query.since === null || at >= query.since) && at <= query.until;
  const counts = { answered: 0, skipped: 0, set_aside: 0, replaced: 0 };
  const done: DecisionRow[] = [];
  const history = { asked: 0, answered: 0, earliest: null as number | null };
  let waiting = 0;
  const reaskedByThread = new Map<string, ReadonlySet<string>>();
  const reasked = (row: DecisionRow): boolean => {
    let listed = reaskedByThread.get(row.thread_id);
    if (!listed) {
      try {
        listed = input.reaskListedIds(row.thread_id);
      } catch {
        listed = new Set();
      }
      reaskedByThread.set(row.thread_id, listed);
    }
    return listed.has(row.id);
  };
  for (const row of rows) {
    if (++tick % EVERY === 0) yield;
    history.asked++;
    if (row.fate === "answered") history.answered++;
    if ((row.fate === "answered" || row.fate === "skipped") && row.answered_at !== null && (history.earliest === null || row.answered_at < history.earliest)) history.earliest = row.answered_at;
    if (row.fate === "picked_unsent" || (row.fate === "open" && !reasked(row))) waiting++;
    if (inRange(row.asked_at) && (row.fate === "set_aside" || row.fate === "replaced")) counts[row.fate]++;
    if ((row.fate === "answered" || row.fate === "skipped") && inRange(row.answered_at)) {
      counts[row.fate]++;
      done.push(row);
    }
  }
  yield;
  done.sort((a, b) => a.answered_at! - b.answered_at!);
  yield;

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

  const carried = new Set<string>();
  for (const question of input.questions) {
    if (++tick % EVERY === 0) yield;
    if (question.sent_reply_id) carried.add(question.sent_reply_id);
  }
  const ownWordsAt = new Map<string, number[]>();
  for (const message of input.messages) {
    if (++tick % EVERY === 0) yield;
    try {
      const at = ownWordsTime(message, carried);
      if (at === null) continue;
      const times = ownWordsAt.get(message.thread_id);
      if (times) times.push(at);
      else ownWordsAt.set(message.thread_id, [at]);
      if (inRange(at) && !isInboxActionReport(message) && !message.started_by_person && message.reply_to && !message.review_verdict && message.body.trim() !== "") dayEntry(dayOf(at)).own_words++;
    } catch {
    }
  }
  let settledInWords = 0;
  for (const row of rows) {
    if (++tick % EVERY === 0) yield;
    if ((row.fate !== "replaced" && row.fate !== "open" && row.fate !== "archived") || !inRange(row.asked_at)) continue;
    if (ownWordsAt.get(row.thread_id)?.some((at) => at > row.asked_at)) settledInWords++;
  }

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

export const decisionDataSummary = (input: DecisionDataInput, query: DecisionQuery, signal?: AbortSignal): Promise<DecisionDataSummary> => runInSlices(summarySteps(input, query), signal);

const iso = (at: number | null) => (at === null ? "" : new Date(at).toISOString());

function cell(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  const safe = typeof value === "string" && /^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvInRange(row: DecisionRow, since: number): boolean {
  if (row.fate === "open" || row.fate === "picked_unsent") return true;
  const at = row.fate === "answered" || row.fate === "skipped" ? (row.answered_at ?? row.asked_at) : row.asked_at;
  return at >= since;
}

function* csvSteps(input: DecisionDataInput, since: number | null): Generator<void, string> {
  const { rows, labelOf } = yield* rowsSteps(input);
  const lines = ["question_id,thread_id,project,agent,kind,fate,asked_at,answered_at,sent_at,recommendation_offered,took_recommendation,stopped,holds_up,had_files,revisions"];
  let tick = 0;
  for (const row of rows) {
    if (++tick % EVERY === 0) yield;
    if (since !== null && !csvInRange(row, since)) continue;
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
