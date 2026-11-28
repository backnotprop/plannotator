/**
 * The plan library's import from today's stores, READ-ONLY: it reads `history/`, `plans/` and `feedback/` under the
 * data dir and writes only under `plan-library/`. It never creates, changes, moves or removes a file outside it (it
 * calls no writer of those stores either: `getPlanDir` creates its folder, so it is not used here).
 *
 * Run it as often as you like: what it already took is never taken twice. Each record it writes names the file (or
 * line) it came from (`legacy`), and before adding a version or a decision it looks for that name in the plan's own
 * records. `legacy-map.json` only makes a second run fast (which chain is which plan, how far each was read, which
 * files did not change); if it is lost or behind after a crash, the records rebuild it.
 *
 * What it does with each case (docs/agent-guides/inbox-plans.md, "The import"):
 * - A `history/{project}/{slug}/` folder with `NNN.md` files is one plan; its files, in number order, are versions
 *   1, 2, 3…, dated by the file's modified time. Chains are never joined: a plan whose heading changed (a new slug)
 *   or that came back after two days (a new dated slug) is two plans. Two projects with the same slug are two plans.
 * - Missing numbers (001, 002, 004): the files there are imported in order and numbered without a gap; each keeps its
 *   file name in `legacy`, and the chain is listed in the report's `gaps`.
 * - A file that may still be being written (modified less than `PLAN_IMPORT_SETTLE_MS` ago, or changed while it was
 *   read) is not read yet: its chain stops there (listed in `unsettled`) and a later run reads it whole. An empty
 *   `NNN.md` is no version (listed in `empty_files`): the chain's newest file, empty, is a stalled write and the chain
 *   waits for it in its place; one with a later file after it is over. Versions follow file numbers, never arrival: a
 *   file numbered below a version already taken is never taken (listed in `late_files`).
 * - A file that cannot be read stops that chain there (listed in `unreadable`); the next run tries again from it, so
 *   the order is kept.
 * - A folder with no `NNN.md` (left by an interrupted run) is no plan yet; annotate's chains (`annotate-…-<hash>`)
 *   are not plans and are left out. Other files and folders (`submissions/`, temp files) are ignored.
 * - A later `NNN.md` in a chain already imported becomes the plan's next version (the pickup), and the plan's name
 *   follows the newest version's first heading.
 * - A feedback archive line of plan review (`surface: "plan"`) becomes a decision on the version it names. A line
 *   with nothing to land on yet (its chain is not in the library, or the version it names is on disk but not
 *   imported yet) waits, counted in `orphan_feedback`: it is tried again only after a run that added versions, and
 *   the rest of the file is not read again until the file grows. Other surfaces are not plans.
 * - A decision snapshot (`plans/{slug}-approved.md` / `-denied.md`) is matched by its text to the version it was
 *   made on (the snapshot is that version's text, or it followed by "\n\n---\n\n" and the notes), in a chain of the
 *   same heading. Matched: a decision on that version, unless a feedback line already gave the same decision there
 *   (then `duplicate_snapshots`). Not matched (a decision without history): a plan of its own, whose one version is
 *   the snapshot file as it is (the plan text and the notes cannot be told apart), with no project. A crash while
 *   that plan is made leaves it unfinished; the next run finishes the same plan (never a second one).
 *   A snapshot written over by a later decision (the same slug and status) is a new decision.
 * - Snapshots saved to a custom folder (a browser setting the server never keeps) are not found.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  gitBlobSha,
  NO_ACTOR,
  PLAN_DECISION_KINDS,
  planHeadingOf,
  planId,
  sha1Hex,
  type PlanDecisionKind,
  type PlanEvent,
  type PlanRecord,
  type PlanVersion,
} from "@plannotator/core/plans";
import { planFolders, type PlanLegacyMap, type PlanStore } from "./store";

export interface PlanImportReport {
  plans_created: number;
  versions_added: number;
  decisions_added: number;
  /** Index lines written again after a crash left one behind. */
  index_repaired: number;
  /** Chains whose numbers skip (`{project}/{slug}`). */
  gaps: string[];
  annotate_chains: number;
  empty_chains: number;
  /** Files that could not be read, relative to the data dir. */
  unreadable: string[];
  /** Files that may still be being written, left for a later run (relative to the data dir). */
  unsettled: string[];
  /** Empty files, which are no version or decision (relative to the data dir). */
  empty_files: string[];
  /**
   * Files numbered below a version already taken from their chain (one that was empty when a later file was written,
   * filled in since): never taken, so versions stay in file order (relative to the data dir).
   */
  late_files: string[];
  /** Feedback lines read this run that have no plan or version to land on yet. */
  orphan_feedback: number;
  snapshot_only_plans: number;
  duplicate_snapshots: number;
}

export interface PlanImportOptions {
  dataDir: string;
  /** Also write again any index line a crash left behind (the first run of a process). */
  repair?: boolean;
  /** The clock (tests): a file modified within `PLAN_IMPORT_SETTLE_MS` of it is left for a later run. */
  now?: () => number;
}

/** A source file modified this recently may still be being written (plan review truncates, then writes). */
export const PLAN_IMPORT_SETTLE_MS = 2000;
/** Feedback lines handled between two pauses. */
const FEEDBACK_LINES_PER_STEP = 25;
/** Versions of one chain added between two pauses. */
const VERSIONS_PER_STEP = 10;

const emptyReport = (): PlanImportReport => ({
  plans_created: 0,
  versions_added: 0,
  decisions_added: 0,
  index_repaired: 0,
  gaps: [],
  annotate_chains: 0,
  empty_chains: 0,
  unreadable: [],
  unsettled: [],
  empty_files: [],
  late_files: [],
  orphan_feedback: 0,
  snapshot_only_plans: 0,
  duplicate_snapshots: 0,
});

/** Annotate's history slugs (`deriveAnnotateHistorySlug`): `annotate-<file name>-<8 hex>`. */
const ANNOTATE_SLUG = /^annotate-.*-[0-9a-f]{8}$/;
const VERSION_FILE = /^(\d+)\.md$/;
const DATED_SLUG = /^(.*)-(\d{4}-\d{2}-\d{2})$/;
const SNAPSHOT_FILE = /^(.+)-(approved|denied)\.md$/;
/** How a decision snapshot's notes follow the plan (`saveFinalSnapshot`). */
const SNAPSHOT_NOTES = "\n\n---\n\n";

function folders(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function numberedFiles(dir: string): { name: string; n: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; n: number }[] = [];
  for (const name of names) {
    const match = VERSION_FILE.exec(name);
    if (match) out.push({ name, n: Number.parseInt(match[1]!, 10) });
  }
  return out.sort((a, b) => a.n - b.n);
}

const mtimeOf = (path: string): Date | null => {
  try {
    return statSync(path).mtime;
  } catch {
    return null;
  }
};

type SourceRead =
  | { kind: "read"; bytes: Uint8Array; at: Date; signature: string }
  | { kind: "empty"; signature: string }
  | { kind: "unsettled" }
  | { kind: "unreadable" };

/**
 * A source file read whole, only once it has settled: modified at least `PLAN_IMPORT_SETTLE_MS` before `now` (a write
 * sets the time to now, so a file a writer has just truncated is that young), and the same size and time after the
 * read as before it, with as many bytes as its size.
 */
function readSettled(path: string, now: () => number): SourceRead {
  let bytes: Uint8Array;
  let before: ReturnType<typeof statSync>;
  let after: ReturnType<typeof statSync>;
  try {
    before = statSync(path);
    if (Math.abs(now() - before.mtimeMs) < PLAN_IMPORT_SETTLE_MS) return { kind: "unsettled" };
    bytes = new Uint8Array(readFileSync(path));
    after = statSync(path);
  } catch {
    return { kind: "unreadable" };
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) return { kind: "unsettled" };
  const signature = `${before.size}:${before.mtimeMs}`;
  return bytes.length === 0 ? { kind: "empty", signature } : { kind: "read", bytes, at: before.mtime, signature };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const titleOfSlug = (slug: string) => (DATED_SLUG.exec(slug)?.[1] ?? slug).replace(/-+/g, " ").trim() || "Untitled plan";
const IMPORTED_BY = { ...NO_ACTOR, author_via: "plan-review" };

const AGENT_FIELD_MAX = 200;
/**
 * The agent session plan review recorded beside a history version (`NNN.agent.json`, packages/shared/storage.ts), as
 * the version's agent; nothing when there is none or it does not read as one.
 */
function versionAgent(dir: string, n: number): { agent_host?: string; agent_session?: string; agent_name?: string | null } {
  try {
    const raw = JSON.parse(readFileSync(join(dir, `${String(n).padStart(3, "0")}.agent.json`), "utf8")) as Record<string, unknown> | null;
    const ok = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= AGENT_FIELD_MAX;
    if (!raw || !ok(raw.host) || !ok(raw.session)) return {};
    return { agent_host: raw.host, agent_session: raw.session, agent_name: ok(raw.name) ? raw.name : null };
  } catch {
    return {};
  }
}

/** A decision snapshot's status and a feedback decision mean the same outcome. */
function sameOutcome(snapshot: "approved" | "denied", decision: PlanDecisionKind): boolean {
  return snapshot === "approved" ? decision === "approved" || decision === "approved-with-notes" : decision === "denied" || decision === "feedback";
}

/**
 * The import as steps: it yields after each chain, snapshot and feedback file, every few versions and feedback lines,
 * and after each plan while it repairs and rebuilds, so the server can run it in the background without holding the
 * event loop (`importPlanLibraryInSteps`).
 */
export function* planImportSteps(store: PlanStore, options: PlanImportOptions, report: PlanImportReport = emptyReport()): Generator<void, PlanImportReport> {
  const { dataDir } = options;
  const now = options.now ?? Date.now;
  if (options.repair) report.index_repaired = yield* store.repairIndexSteps();
  const map = store.legacyMap();
  /** Decisions without history whose plan a crash left unfinished: snapshot key → plan id. */
  const unfinished = new Map<string, string>();
  yield* rebuildMap(store, dataDir, map, unfinished);
  let dirty = false;
  const save = () => {
    if (!dirty) return;
    store.saveLegacyMap(map);
    dirty = false;
  };

  // 1. History chains → plans and versions.
  const historyRoot = join(dataDir, "history");
  let sinceSave = 0;
  for (const project of folders(historyRoot)) {
    for (const slug of folders(join(historyRoot, project))) {
      if (ANNOTATE_SLUG.test(slug)) {
        report.annotate_chains++;
        continue;
      }
      if (yield* importChain(store, map, report, historyRoot, project, slug, now)) dirty = true;
      if (++sinceSave >= 100) {
        save();
        sinceSave = 0;
      }
      yield;
    }
  }
  save();

  // 2. Feedback archive lines → decisions (before the snapshots, so a decision kept by both is the line's). Lines that
  // waited are tried again only when this run added versions: nothing else can give them a place to land.
  const historyChanged = report.versions_added > 0;
  const feedbackRoot = join(dataDir, "feedback");
  for (const project of folders(feedbackRoot)) {
    if (yield* importFeedback(store, map, report, dataDir, project, historyChanged)) dirty = true;
    yield;
  }
  save();

  // 3. Decision snapshots → decisions, or plans of their own.
  const snapshotsDir = join(dataDir, "plans");
  let names: string[] = [];
  try {
    names = readdirSync(snapshotsDir).filter((name) => SNAPSHOT_FILE.test(name) && !name.endsWith(".annotations.md") && !name.endsWith(".diff.md")).sort();
  } catch {
    // No snapshots folder: nothing to read (and never one to create).
  }
  for (const name of names) {
    if (importSnapshot(store, map, unfinished, report, snapshotsDir, name, now)) dirty = true;
    yield;
  }
  save();
  return report;
}

/** The whole import at once (the CLI, tests). */
export function importPlanLibrary(store: PlanStore, options: PlanImportOptions): PlanImportReport {
  const steps = planImportSteps(store, options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** The import with a pause between steps, for a server that keeps answering while it runs. */
export async function importPlanLibraryInSteps(store: PlanStore, options: PlanImportOptions & { pause?: () => Promise<void> }): Promise<PlanImportReport> {
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const steps = planImportSteps(store, options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    await pause();
  }
}

/**
 * Plans the map does not know (it was lost, or a crash came before it was saved): put them back from their records.
 * A decision without history counts as done only once its plan holds the decision; until then it is `unfinished`, and
 * its snapshot finishes that plan rather than making another.
 */
function* rebuildMap(store: PlanStore, dataDir: string, map: PlanLegacyMap, unfinished: Map<string, string>): Generator<void> {
  const known = new Set<string>([...Object.values(map.chains).map((c) => c.plan), ...Object.values(map.snapshots).map((s) => s.plan)]);
  for (const id of planFolders(dataDir)) {
    if (known.has(id)) continue;
    const plan = store.get(id);
    if (plan?.legacy) {
      for (const chain of plan.legacy.chains) {
        const key = `${chain.project}/${chain.slug}`;
        if (!map.chains[key]) map.chains[key] = { plan: id, versions: 0, last: 0 };
      }
      if (plan.legacy.chains.length === 0) {
        const events = store.events(id);
        for (const key of plan.legacy.snapshots) {
          const event = events.find((e) => e.legacy === key);
          if (event) map.snapshots[key] = { plan: id, event: event.id };
          else unfinished.set(key, id);
        }
      }
    }
    yield;
  }
}

/** One history chain; true when the map changed. */
function* importChain(
  store: PlanStore,
  map: PlanLegacyMap,
  report: PlanImportReport,
  historyRoot: string,
  project: string,
  slug: string,
  now: () => number,
): Generator<void, boolean> {
  const dir = join(historyRoot, project, slug);
  const key = `${project}/${slug}`;
  const entry = map.chains[key];
  const dirMtime = mtimeOf(dir)?.getTime();
  // Nothing added since the last read (adding a file changes its folder's time; a chain is only marked read once every
  // file in it was read settled, so a file still being written then is never skipped this way).
  if (entry && dirMtime !== undefined && entry.dir_mtime === dirMtime) return false;
  const files = numberedFiles(dir);
  if (files.length === 0) {
    report.empty_chains++;
    return false;
  }
  if (files.some((file, i) => file.n !== i + 1)) report.gaps.push(key);

  let plan: PlanRecord | null = entry ? store.get(entry.plan) : null;
  const legacyOf = (name: string) => `history/${project}/${slug}/${name}`;
  const known = new Set(plan ? store.versions(plan.id).map((v) => v.legacy) : []);
  // Versions follow file numbers, never arrival: a file numbered below the newest one taken is never taken after it.
  const taken = Math.max(0, ...files.filter((file) => known.has(legacyOf(file.name))).map((file) => file.n));
  let complete = true;
  let newest: { text: string; at: string } | null = null;
  let added = 0;
  for (const [i, file] of files.entries()) {
    const legacy = legacyOf(file.name);
    if (known.has(legacy)) continue;
    if (file.n < taken) {
      report.late_files.push(legacy);
      continue;
    }
    const read = readSettled(join(dir, file.name), now);
    if (read.kind === "unreadable" || read.kind === "unsettled") {
      // Stop here, so the order is kept; the next run reads it again.
      (read.kind === "unreadable" ? report.unreadable : report.unsettled).push(legacy);
      complete = false;
      break;
    }
    if (read.kind === "empty") {
      report.empty_files.push(legacy);
      // A later file was written: plan review writes in order, so this write is over and it is no version.
      if (i < files.length - 1) continue;
      // The newest file: a write that truncated it and stalled (a laptop asleep mid-write) fills it in place later,
      // which does not change the folder's time. Wait for it in its place, with the chain not marked read.
      complete = false;
      break;
    }
    const at = read.at.toISOString();
    const text = decode(read.bytes);
    if (!plan) {
      const name = planHeadingOf(text) ?? titleOfSlug(slug);
      plan = store.createPlan({
        id: entry?.plan ?? planId("pln", read.at.getTime()),
        name,
        project_name: project === "_unknown" ? null : project,
        created_at: at,
        created_by: IMPORTED_BY,
        legacy: { chains: [{ project, slug }], snapshots: [] },
        document: { title: name },
      }).plan;
      report.plans_created++;
    }
    store.addVersion(plan.id, plan.primary_doc_id, { bytes: read.bytes, committed_at: at, source: "plan-review", ...IMPORTED_BY, ...versionAgent(dir, file.n), legacy });
    report.versions_added++;
    newest = { text, at };
    if (++added % VERSIONS_PER_STEP === 0) yield;
  }
  if (!plan) {
    // Nothing to make a plan of yet (its first file is being written or cannot be read, or every file is empty).
    if (complete) report.empty_chains++;
    return false;
  }
  if (newest) {
    const heading = planHeadingOf(newest.text);
    if (heading && heading !== plan.name) store.updatePlan(plan.id, { name: heading }, newest.at);
  }
  const next = {
    plan: plan.id,
    versions: store.versions(plan.id).length,
    last: files[files.length - 1]!.n,
    // Only a chain read to its end is skipped next time; one stopped at a file not read yet is read again.
    ...(complete && dirMtime !== undefined ? { dir_mtime: dirMtime } : {}),
  };
  // Unchanged (a chain waiting on a file, read again on every pickup): the map is not written again for it.
  if (entry && entry.plan === next.plan && entry.versions === next.versions && entry.last === next.last && entry.dir_mtime === next.dir_mtime) return false;
  map.chains[key] = next;
  return true;
}

/**
 * One project's feedback archive; true when the map changed. It is append-only, so only the bytes after the last
 * whole line read are new; a line still being appended (no newline yet) waits for the next run. Lines that waited are
 * read again by their byte ranges when `retry`. A file that shrank was written over: it is read again from the start
 * (what was taken is never taken twice).
 */
function* importFeedback(
  store: PlanStore,
  map: PlanLegacyMap,
  report: PlanImportReport,
  dataDir: string,
  project: string,
  retry: boolean,
): Generator<void, boolean> {
  const rel = `feedback/${project}/index.jsonl`;
  const path = join(dataDir, rel);
  const prior = map.feedback_files[rel];
  let buf: Buffer;
  try {
    const size = statSync(path).size;
    if (prior && prior.size === size && !(retry && prior.pending.length > 0)) return false;
    buf = readFileSync(path);
  } catch {
    return false;
  }
  const state = prior && buf.length >= prior.read ? prior : { size: 0, read: 0, pending: [] as [number, number][] };
  const ranges: [number, number][] = retry ? [...state.pending] : [];
  const pending: [number, number][] = retry ? [] : [...state.pending];
  const end = buf.lastIndexOf(0x0a) + 1;
  for (let at = state.read; at < end; ) {
    const nl = buf.indexOf(0x0a, at);
    ranges.push([at, nl]);
    at = nl + 1;
  }

  const plans = new Map<string, { plan: PlanRecord; events: PlanEvent[]; versions: PlanVersion[] }>();
  const planCached = (id: string) => {
    let cached = plans.get(id);
    if (!cached) {
      const plan = store.get(id);
      if (!plan) return null;
      cached = { plan, events: store.events(id), versions: store.versions(id) };
      plans.set(id, cached);
    }
    return cached;
  };
  const wait = (range: [number, number]) => {
    pending.push(range);
    report.orphan_feedback++;
  };
  let handled = 0;
  for (const range of ranges) {
    if (++handled % FEEDBACK_LINES_PER_STEP === 0) yield;
    const bytes = buf.subarray(range[0], range[1]);
    const raw = bytes.toString("utf8");
    if (!raw.trim()) continue;
    let record: { surface?: unknown; decision?: unknown; ts?: unknown; feedback?: unknown; recordFile?: unknown; target?: { slug?: unknown; planVersion?: unknown } };
    try {
      record = JSON.parse(raw);
    } catch {
      continue; // a torn line, as the archive's own reader skips it
    }
    if (!record || typeof record !== "object" || record.surface !== "plan") continue;
    if (!PLAN_DECISION_KINDS.includes(record.decision as PlanDecisionKind)) continue;
    const slug = typeof record.target?.slug === "string" ? record.target.slug : null;
    if (!slug) continue;
    const planOfLine = map.chains[`${project}/${slug}`]?.plan;
    const cached = planOfLine ? planCached(planOfLine) : null;
    if (!cached) {
      wait(range); // its chain is not in the library (removed, or its first file not read yet)
      continue;
    }
    const key = `${rel}#${sha1Hex(bytes)}`;
    if (cached.events.some((event) => event.legacy === key)) continue;
    const n = typeof record.target?.planVersion === "number" ? record.target.planVersion : null;
    const historyFile = n === null ? null : `history/${project}/${slug}/${String(n).padStart(3, "0")}.md`;
    const version = historyFile ? cached.versions.find((v) => v.legacy === historyFile) : undefined;
    if (historyFile && !version && sizeOf(join(dataDir, historyFile)) > 0) {
      wait(range); // the version it names is on disk but not imported yet: it lands there later, not on no version
      continue;
    }
    const at = typeof record.ts === "string" && !Number.isNaN(Date.parse(record.ts)) ? record.ts : (mtimeOf(path) ?? new Date()).toISOString();
    const { plan } = cached;
    const event = store.addEvent(plan.id, {
      kind: "decision",
      at,
      ...IMPORTED_BY,
      subject: { document_id: plan.primary_doc_id, version_number: version?.version_number ?? null },
      decision: {
        document_id: plan.primary_doc_id,
        version: version?.version ?? null,
        version_number: version?.version_number ?? null,
        decision: record.decision as PlanDecisionKind,
        at,
        feedback: typeof record.feedback === "string" && record.feedback ? record.feedback : null,
        feedback_record: { file: rel, line_sha: key.slice(rel.length + 1), record_file: typeof record.recordFile === "string" ? record.recordFile : null },
        snapshot: null,
      },
      legacy: key,
    });
    cached.events.push(event);
    report.decisions_added++;
  }
  map.feedback_files[rel] = { size: buf.length, read: Math.max(end, state.read), pending: pending.sort((a, b) => a[0] - b[0]) };
  return true;
}

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** One decision snapshot; true when the map changed. */
function importSnapshot(
  store: PlanStore,
  map: PlanLegacyMap,
  unfinished: Map<string, string>,
  report: PlanImportReport,
  dir: string,
  name: string,
  now: () => number,
): boolean {
  const path = join(dir, name);
  try {
    const stat = statSync(path);
    if (map.snapshot_files[name] === `${stat.size}:${stat.mtimeMs}`) return false;
  } catch {
    report.unreadable.push(`plans/${name}`);
    return false;
  }
  const read = readSettled(path, now);
  if (read.kind === "unreadable" || read.kind === "unsettled") {
    // Not recorded as read: the next run reads it again.
    (read.kind === "unreadable" ? report.unreadable : report.unsettled).push(`plans/${name}`);
    return false;
  }
  const done = () => {
    map.snapshot_files[name] = read.signature;
    return true;
  };
  if (read.kind === "empty") {
    report.empty_files.push(`plans/${name}`);
    return done();
  }
  const { bytes, at } = read;
  const sha = gitBlobSha(bytes);
  const key = `plans/${name}#${sha}`;
  if (map.snapshots[key]) return done();
  const [, slug, status] = SNAPSHOT_FILE.exec(name) as unknown as [string, string, "approved" | "denied"];
  const text = decode(bytes);
  const decided = { decision: status as PlanDecisionKind, at: at.toISOString(), feedback: null, feedback_record: null, snapshot: `plans/${name}` };
  const match = unfinished.has(key) ? null : matchSnapshot(store, map, slug, text, at);

  if (match) {
    const events = store.events(match.plan);
    const kept = events.find((event) => event.legacy === key);
    if (kept) {
      map.snapshots[key] = { plan: match.plan, event: kept.id };
      return done();
    }
    const same = events.find((event) => event.kind === "decision" && event.decision && event.decision.version_number === match.n && sameOutcome(status, event.decision.decision));
    if (same) {
      map.snapshots[key] = { plan: match.plan, event: null };
      report.duplicate_snapshots++;
      return done();
    }
    const plan = store.get(match.plan)!;
    const event = store.addEvent(match.plan, {
      kind: "decision",
      at: at.toISOString(),
      ...IMPORTED_BY,
      subject: { document_id: plan.primary_doc_id, version_number: match.n },
      decision: { document_id: plan.primary_doc_id, version: match.sha, version_number: match.n, ...decided },
      legacy: key,
    });
    map.snapshots[key] = { plan: match.plan, event: event.id };
    report.decisions_added++;
    return done();
  }

  // A decision without history: a plan of its own, the snapshot as its one version. Each step looks for what an
  // earlier run (one a crash stopped) already wrote, so running it again finishes the same plan.
  const left = unfinished.get(key);
  let plan = left ? store.get(left) : null;
  if (!plan) {
    const title = planHeadingOf(text) ?? titleOfSlug(slug);
    plan = store.createPlan({
      id: planId("pln", at.getTime()),
      name: title,
      created_at: at.toISOString(),
      created_by: IMPORTED_BY,
      // The snapshot's key, so a run after a crash finds this plan (rebuildMap) even before it has a version.
      legacy: { chains: [], snapshots: [key] },
      document: { title },
    }).plan;
    report.plans_created++;
    report.snapshot_only_plans++;
  }
  unfinished.delete(key);
  const versionLegacy = `plans/${name}`;
  let version = store.versions(plan.id).find((v) => v.legacy === versionLegacy && v.version === sha);
  if (!version) {
    version = store.addVersion(plan.id, plan.primary_doc_id, { bytes, committed_at: at.toISOString(), source: "plan-review", ...IMPORTED_BY, legacy: versionLegacy });
    report.versions_added++;
  }
  let event = store.events(plan.id).find((e) => e.legacy === key);
  if (!event) {
    event = store.addEvent(plan.id, {
      kind: "decision",
      at: at.toISOString(),
      ...IMPORTED_BY,
      subject: { document_id: plan.primary_doc_id, version_number: version.version_number },
      decision: { document_id: plan.primary_doc_id, version: version.version, version_number: version.version_number, ...decided },
      legacy: key,
    });
    report.decisions_added++;
  }
  map.snapshots[key] = { plan: plan.id, event: event.id };
  return done();
}

/**
 * The version a snapshot was made on: in a chain of the same heading (the same slug, or the same heading with an
 * earlier start date, which a chain continued across days has), the newest version whose text the snapshot is, or
 * begins with before its notes. Among chains, the one whose version was saved last before the snapshot.
 */
function matchSnapshot(store: PlanStore, map: PlanLegacyMap, slug: string, text: string, at: Date): { plan: string; n: number; sha: string } | null {
  const dated = DATED_SLUG.exec(slug);
  const base = dated?.[1] ?? slug;
  const date = dated?.[2] ?? null;
  const when = at.toISOString();
  let best: { plan: string; n: number; sha: string; at: string } | null = null;
  // Saved at or before the snapshot beats after; then the closest to it.
  const better = (candidate: string, current: string): boolean => {
    const a = candidate <= when;
    const b = current <= when;
    if (a !== b) return a;
    return a ? candidate > current : candidate < current;
  };
  for (const [key, chain] of Object.entries(map.chains)) {
    const chainSlug = key.slice(key.indexOf("/") + 1);
    const chainDated = DATED_SLUG.exec(chainSlug);
    const sameHeading = chainSlug === slug || (chainDated !== null && chainDated[1] === base && (date === null || chainDated[2]! <= date));
    if (!sameHeading) continue;
    const versions = store.versions(chain.plan);
    for (let i = versions.length - 1; i >= 0; i--) {
      const v = versions[i]!;
      // Plan review decides on what the agent submitted: never on the person's own version (an edit, or a Restore
      // holding an older version's text), which would put an old approval on the newest.
      if (v.source === "person") continue;
      const bytes = store.versionBytes(chain.plan, v.document_id, v.version_number);
      if (!bytes) continue;
      const own = decode(bytes);
      if (text !== own && !text.startsWith(own + SNAPSHOT_NOTES)) continue;
      if (!best || better(v.committed_at, best.at)) best = { plan: chain.plan, n: v.version_number, sha: v.version, at: v.committed_at };
      break;
    }
  }
  return best ? { plan: best.plan, n: best.n, sha: best.sha } : null;
}
