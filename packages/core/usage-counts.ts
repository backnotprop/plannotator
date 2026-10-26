/**
 * Usage counts for experimental features: the registry, the batch and its
 * validator (approval record "experimental-telemetry", 2026-10-24).
 *
 * Browser-safe and dependency-free: the local Plannotator process, the CLI and
 * the counts Worker (apps/telemetry) all read this one list, so what a client
 * may build and what the Worker accepts can never disagree.
 *
 * The rules this file enforces:
 *  - Only events listed here exist. A caller names an event by its id; there
 *    is no string a caller passes that reaches a batch (the builder copies
 *    only registry keys, in registry order, with whole-number values).
 *  - One batch is one feature and one complete UTC day: schema, feature id,
 *    the feature's revision number, the day, and whole numbers. No free text,
 *    no id for the person or the computer, no path, no app version.
 *  - Counts are whole numbers from 1 to 100 per day; day events are 1.
 *  - Two facts are worked out on the computer and sent as plain values:
 *    `first_day` (1, once per install per feature) and `days_last7` (a bucket
 *    of how many of the last 7 days the feature was used: 1, 2–3, 4–5, 6–7,
 *    sent as the bucket's first day: 1, 2, 4 or 6).
 *  - Every feature's counting ends on a fixed UTC day (`collectUntil`).
 */

export const USAGE_COUNTS_SCHEMA = 1;
/** The most any count event says for one day. */
export const USAGE_COUNT_CAP = 100;
/** The counts service's host (owner-deployed Worker, apps/telemetry). */
export const USAGE_COUNTS_HOST = "counts.plannotator.ai";
/** The one write route. */
export const USAGE_COUNTS_PATH = "/v1/counts";
/** The Worker refuses a larger body; a real batch is under 250 bytes. */
export const USAGE_COUNTS_MAX_BODY_BYTES = 1024;
/**
 * The Worker takes a day at most this many days back. After that a day is
 * closed for good: no batch can change it, so the read route serves it (and
 * serves nothing newer), and a total can never be read before and after one
 * install's batch to learn that batch.
 */
export const USAGE_COUNTS_MAX_DAYS_BACK = 3;
/** The client drops a day older than this unsent (the Worker would refuse it). */
export const USAGE_COUNTS_QUEUE_DAYS = USAGE_COUNTS_MAX_DAYS_BACK;
/** The Worker deletes a feature's totals this many days after its counting ends. */
export const USAGE_COUNTS_RETENTION_DAYS = 180;
/** The read route hides any (day, rev) and any cell with fewer reports than this. */
export const USAGE_COUNTS_MIN_REPORTS = 5;

/**
 * - `day`: 0 or 1 for the day (set, not added).
 * - `count`: added, capped at USAGE_COUNT_CAP for the day.
 * - `first_day`: a local fact, 1 on the first day the feature was used on this
 *   computer, sent once. Never recorded by a caller.
 * - `days_last7`: a local fact, the bucket of used days in the 7 days ending on
 *   the batch's day. Never recorded by a caller.
 */
export type UsageCountEventKind = "day" | "count" | "first_day" | "days_last7";

export interface UsageCountEventDef {
  readonly id: string;
  readonly kind: UsageCountEventKind;
  /** Plain words for the notice and `plannotator telemetry --show`. */
  readonly label: string;
}

export interface UsageCountFeatureDef {
  /** The config key, the wire value. */
  readonly id: string;
  readonly name: string;
  /** Bumped when the feature changes in a way that matters to the counts. */
  readonly rev: number;
  /**
   * The notice version a person must have been shown before anything is
   * counted (config.json `usageCountsNotice.<id>`, written only by the notice
   * UI). Bump it when what is counted changes: counting stops until the new
   * notice is shown.
   */
  readonly notice: number;
  /** The last UTC day counted. The client and the Worker both stop after it. */
  readonly collectUntil: string;
  /** The recorded event that means "used it" for the two local facts. */
  readonly useEvent: string;
  readonly events: readonly UsageCountEventDef[];
}

/**
 * The counted features. Adding one is a reviewed change: a new id, its events,
 * an end date, and a notice. The Worker validates against this same list.
 */
export const USAGE_COUNT_FEATURES = [
  {
    id: "decisionMode",
    name: "Decision mode",
    rev: 1,
    notice: 1,
    collectUntil: "2027-04-30",
    useEvent: "opened",
    events: [
      { id: "active_day", kind: "day", label: "days the Inbox was open with it on" },
      { id: "entry_shown", kind: "day", label: "days the Decide button showed (two or more questions waiting)" },
      { id: "opened", kind: "count", label: "times you opened decision mode" },
      { id: "decided", kind: "count", label: "questions you answered in it" },
      { id: "sent", kind: "count", label: "replies sent from it" },
      { id: "to_thread", kind: "count", label: "times you left it to open a thread" },
      { id: "finished", kind: "count", label: "times you reached the end with nothing left" },
      { id: "first_day", kind: "first_day", label: "the first day you used it (sent once)" },
      { id: "days_last7", kind: "days_last7", label: "how many of the last 7 days you used it (1, 2–3, 4–5 or 6–7)" },
    ],
  },
] as const satisfies readonly UsageCountFeatureDef[];

export type UsageCountFeatureId = (typeof USAGE_COUNT_FEATURES)[number]["id"];

type FeatureOf<F extends UsageCountFeatureId> = Extract<(typeof USAGE_COUNT_FEATURES)[number], { id: F }>;

/** Every event id a feature's batch may carry. */
export type UsageCountEventId<F extends UsageCountFeatureId> = FeatureOf<F>["events"][number]["id"];

/** The events a caller may record: `day` and `count` kinds, never the facts. */
export type RecordableUsageCountEvent<F extends UsageCountFeatureId> = Extract<
  FeatureOf<F>["events"][number],
  { kind: "day" | "count" }
>["id"];

export function usageCountFeature(id: unknown): UsageCountFeatureDef | null {
  if (typeof id !== "string") return null;
  return (USAGE_COUNT_FEATURES as readonly UsageCountFeatureDef[]).find((f) => f.id === id) ?? null;
}

export function usageCountEvent(feature: UsageCountFeatureDef, id: unknown): UsageCountEventDef | null {
  if (typeof id !== "string") return null;
  return feature.events.find((e) => e.id === id) ?? null;
}

/** Whether a caller may record this event (a `day` or `count` event of the feature). */
export function isRecordableUsageCountEvent(feature: UsageCountFeatureDef, id: unknown): boolean {
  const def = usageCountEvent(feature, id);
  return def !== null && (def.kind === "day" || def.kind === "count");
}

// ── Days ──

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a real calendar day written YYYY-MM-DD. */
export function isUtcDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return utcDay(date) === value;
}

/** The UTC day of a moment, YYYY-MM-DD. */
export function utcDay(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** A UTC day moved by whole days. */
export function addUtcDays(day: string, days: number): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  return utcDay(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function utcDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The newest day the read route may serve on `today`: a day no batch can
 * still change (the Worker accepts a day for USAGE_COUNTS_MAX_DAYS_BACK days).
 */
export function usageCountsServedThrough(today: string): string {
  return addUtcDays(today, -(USAGE_COUNTS_MAX_DAYS_BACK + 1));
}

// ── The days_last7 bucket ──

export const DAYS_LAST7_BUCKETS = [
  { value: 1, label: "1", min: 1, max: 1 },
  { value: 2, label: "2-3", min: 2, max: 3 },
  { value: 4, label: "4-5", min: 4, max: 5 },
  { value: 6, label: "6-7", min: 6, max: 7 },
] as const;

/** The wire value for a number of used days in the last 7, or null for none. */
export function daysLast7Value(usedDays: number): number | null {
  if (!Number.isInteger(usedDays) || usedDays < 1) return null;
  const n = Math.min(usedDays, 7);
  return DAYS_LAST7_BUCKETS.find((b) => n >= b.min && n <= b.max)!.value;
}

/** The bucket label of a wire value (1 → "1", 2 → "2-3"), or null. */
export function daysLast7Label(value: unknown): string | null {
  return DAYS_LAST7_BUCKETS.find((b) => b.value === value)?.label ?? null;
}

/** The spread bucket the Worker files a count under, so totals show the spread without any one install's number. */
export function countBucketLabel(value: number): string {
  if (value <= 1) return "1";
  if (value <= 3) return "2-3";
  if (value <= 9) return "4-9";
  if (value <= 29) return "10-29";
  return "30-100";
}

// ── The batch ──

export interface UsageCountsBatch {
  schema: typeof USAGE_COUNTS_SCHEMA;
  feature: UsageCountFeatureId;
  rev: number;
  day: string;
  /** In registry order; an event at 0 is left out, so absent means 0. */
  events: Record<string, number>;
}

/** Whether a value is allowed for an event kind. */
function validEventValue(kind: UsageCountEventKind, value: unknown): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  switch (kind) {
    case "day":
    case "first_day":
      return value === 1;
    case "count":
      return value >= 1 && value <= USAGE_COUNT_CAP;
    case "days_last7":
      return daysLast7Label(value) !== null;
  }
}

/**
 * Build a batch from whatever a local store holds. Only registry keys are read,
 * in registry order; every other key is ignored, a count over the cap is
 * capped, anything that is not a valid whole number is dropped. Answers null
 * when nothing valid is left, the feature is unknown, the revision is not one
 * of the feature's, or the day is not a day or is past the feature's end.
 */
export function buildUsageCountsBatch(featureId: unknown, rev: unknown, day: unknown, events: unknown): UsageCountsBatch | null {
  const feature = usageCountFeature(featureId);
  if (!feature) return null;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1 || rev > feature.rev) return null;
  if (!isUtcDay(day) || day > feature.collectUntil) return null;
  if (typeof events !== "object" || events === null || Array.isArray(events)) return null;
  const source = events as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const def of feature.events) {
    if (!Object.prototype.hasOwnProperty.call(source, def.id)) continue;
    let value = source[def.id];
    if (def.kind === "count" && typeof value === "number" && Number.isInteger(value) && value > USAGE_COUNT_CAP) value = USAGE_COUNT_CAP;
    if (validEventValue(def.kind, value)) out[def.id] = value;
  }
  if (Object.keys(out).length === 0) return null;
  return { schema: USAGE_COUNTS_SCHEMA, feature: feature.id as UsageCountFeatureId, rev, day, events: out };
}

/** The exact body sent: fixed key order, events in registry order, no spaces. */
export function serializeUsageCountsBatch(batch: UsageCountsBatch): string {
  const feature = usageCountFeature(batch.feature)!;
  const events = feature.events
    .filter((e) => Object.prototype.hasOwnProperty.call(batch.events, e.id))
    .map((e) => `${JSON.stringify(e.id)}:${batch.events[e.id]}`)
    .join(",");
  return `{"schema":${batch.schema},"feature":${JSON.stringify(batch.feature)},"rev":${batch.rev},"day":${JSON.stringify(batch.day)},"events":{${events}}}`;
}

export interface ParseBatchOptions {
  /** Today's UTC day, for the window the Worker accepts. */
  today: string;
}

/**
 * The validator the Worker runs, and the client runs on its own batch before
 * it sends. Strict: exactly the keys schema, feature, rev, day, events; a
 * registry feature; a revision from 1 to the feature's; a real day no more
 * than USAGE_COUNTS_MAX_DAYS_BACK back, no more than one day ahead (clock
 * skew), and not after the feature's end; at least one event, each a registry
 * event of that feature with a value its kind allows. Anything else is null,
 * with no reason (the Worker says only `invalid`).
 */
export function parseUsageCountsBatch(input: unknown, options: ParseBatchOptions): UsageCountsBatch | null {
  let value: unknown = input;
  if (typeof input === "string") {
    if (input.length > USAGE_COUNTS_MAX_BODY_BYTES) return null;
    try {
      value = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const wanted = ["schema", "feature", "rev", "day", "events"];
  if (keys.length !== wanted.length || !wanted.every((k) => keys.includes(k))) return null;
  if (record.schema !== USAGE_COUNTS_SCHEMA) return null;
  const feature = usageCountFeature(record.feature);
  if (!feature) return null;
  const rev = record.rev;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1 || rev > feature.rev) return null;
  const day = record.day;
  if (!isUtcDay(day) || !isUtcDay(options.today)) return null;
  if (day > feature.collectUntil) return null;
  const age = utcDaysBetween(day, options.today);
  if (age > USAGE_COUNTS_MAX_DAYS_BACK || age < -1) return null;
  const events = record.events;
  if (typeof events !== "object" || events === null || Array.isArray(events)) return null;
  const eventKeys = Object.keys(events as object);
  if (eventKeys.length === 0 || eventKeys.length > feature.events.length) return null;
  const out: Record<string, number> = {};
  for (const key of eventKeys) {
    const def = usageCountEvent(feature, key);
    if (!def) return null;
    const v = (events as Record<string, unknown>)[key];
    if (!validEventValue(def.kind, v)) return null;
    out[key] = v;
  }
  // Registry order, as the client serializes.
  const ordered: Record<string, number> = {};
  for (const def of feature.events) if (def.id in out) ordered[def.id] = out[def.id]!;
  return { schema: USAGE_COUNTS_SCHEMA, feature: feature.id as UsageCountFeatureId, rev, day, events: ordered };
}

// ── The request, every byte ──

/** The fixed User-Agent: no runtime version, no Plannotator version. */
export const USAGE_COUNTS_USER_AGENT = "plannotator-telemetry";

/**
 * The whole HTTP/1.1 request, headers and body, as it goes on the wire. Every
 * header is fixed, so every computer sends the same bytes for the same counts.
 * `host` is USAGE_COUNTS_HOST for the real service (a loopback test endpoint
 * names its own host and port).
 */
export function buildUsageCountsRequest(host: string, body: string): string {
  const length = new TextEncoder().encode(body).length;
  return [
    `POST ${USAGE_COUNTS_PATH} HTTP/1.1`,
    `Host: ${host}`,
    `User-Agent: ${USAGE_COUNTS_USER_AGENT}`,
    "Content-Type: application/json",
    `Content-Length: ${length}`,
    "Accept: */*",
    "Accept-Encoding: identity",
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}
