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
 * - A file that cannot be read stops that chain there (listed in `unreadable`); the next run tries again from it, so
 *   the order is kept.
 * - A folder with no `NNN.md` (left by an interrupted run) is no plan yet; annotate's chains (`annotate-…-<hash>`)
 *   are not plans and are left out. Other files and folders (`submissions/`, temp files) are ignored.
 * - A later `NNN.md` in a chain already imported becomes the plan's next version (the pickup), and the plan's name
 *   follows the newest version's first heading.
 * - A feedback archive line of plan review (`surface: "plan"`) becomes a decision on the version it names. A line
 *   whose chain is not in the library (its history was removed) is counted in `orphan_feedback` and read again next
 *   time. Other surfaces are not plans.
 * - A decision snapshot (`plans/{slug}-approved.md` / `-denied.md`) is matched by its text to the version it was
 *   made on (the snapshot is that version's text, or it followed by "\n\n---\n\n" and the notes), in a chain of the
 *   same heading. Matched: a decision on that version, unless a feedback line already gave the same decision there
 *   (then `duplicate_snapshots`). Not matched (a decision without history): a plan of its own, whose one version is
 *   the snapshot file as it is (the plan text and the notes cannot be told apart), with no project.
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
  orphan_feedback: number;
  snapshot_only_plans: number;
  duplicate_snapshots: number;
}

export interface PlanImportOptions {
  dataDir: string;
  /** Also write again any index line a crash left behind (the first run of a process). */
  repair?: boolean;
}

const emptyReport = (): PlanImportReport => ({
  plans_created: 0,
  versions_added: 0,
  decisions_added: 0,
  index_repaired: 0,
  gaps: [],
  annotate_chains: 0,
  empty_chains: 0,
  unreadable: [],
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

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const titleOfSlug = (slug: string) => (DATED_SLUG.exec(slug)?.[1] ?? slug).replace(/-+/g, " ").trim() || "Untitled plan";
const IMPORTED_BY = { ...NO_ACTOR, author_via: "plan-review" };

/** A decision snapshot's status and a feedback decision mean the same outcome. */
function sameOutcome(snapshot: "approved" | "denied", decision: PlanDecisionKind): boolean {
  return snapshot === "approved" ? decision === "approved" || decision === "approved-with-notes" : decision === "denied" || decision === "feedback";
}

/**
 * The import as steps: it yields after each chain, snapshot and feedback file, so the server can run it in the
 * background without holding the event loop (`importPlanLibraryInSteps`).
 */
export function* planImportSteps(store: PlanStore, options: PlanImportOptions, report: PlanImportReport = emptyReport()): Generator<void, PlanImportReport> {
  const { dataDir } = options;
  if (options.repair) report.index_repaired = store.repairIndex();
  const map = store.legacyMap();
  rebuildMap(store, dataDir, map);
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
      if (importChain(store, map, report, historyRoot, project, slug)) dirty = true;
      if (++sinceSave >= 100) {
        save();
        sinceSave = 0;
      }
      yield;
    }
  }
  save();

  // 2. Feedback archive lines → decisions (before the snapshots, so a decision kept by both is the line's).
  const feedbackRoot = join(dataDir, "feedback");
  for (const project of folders(feedbackRoot)) {
    if (importFeedback(store, map, report, dataDir, project)) dirty = true;
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
    if (importSnapshot(store, map, report, snapshotsDir, name)) dirty = true;
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

/** Plans the map does not know (it was lost, or a crash came before it was saved): put them back from their records. */
function rebuildMap(store: PlanStore, dataDir: string, map: PlanLegacyMap): void {
  const known = new Set<string>([...Object.values(map.chains).map((c) => c.plan), ...Object.values(map.snapshots).map((s) => s.plan)]);
  for (const id of planFolders(dataDir)) {
    if (known.has(id)) continue;
    const plan = store.get(id);
    if (!plan?.legacy) continue;
    for (const chain of plan.legacy.chains) {
      const key = `${chain.project}/${chain.slug}`;
      if (!map.chains[key]) map.chains[key] = { plan: id, versions: 0, last: 0 };
    }
    if (plan.legacy.chains.length === 0) {
      const first = store.versions(id)[0];
      const file = first?.legacy?.startsWith("plans/") ? first.legacy.slice("plans/".length) : null;
      if (first && file) map.snapshots[`plans/${file}#${first.version}`] = { plan: id, event: null };
    }
  }
}

/** One history chain; true when the map changed. */
function importChain(store: PlanStore, map: PlanLegacyMap, report: PlanImportReport, historyRoot: string, project: string, slug: string): boolean {
  const dir = join(historyRoot, project, slug);
  const key = `${project}/${slug}`;
  const entry = map.chains[key];
  const dirMtime = mtimeOf(dir)?.getTime();
  // Nothing added since the last read (adding a file changes its folder's time).
  if (entry && dirMtime !== undefined && entry.dir_mtime === dirMtime) return false;
  const files = numberedFiles(dir);
  if (files.length === 0) {
    report.empty_chains++;
    return false;
  }
  if (files.some((file, i) => file.n !== i + 1)) report.gaps.push(key);

  const firstTime = mtimeOf(join(dir, files[0]!.name)) ?? new Date();
  const id = entry?.plan ?? planId("pln", firstTime.getTime());
  let plan = store.get(id);
  if (!plan) {
    let firstText = "";
    try {
      firstText = decode(readFileSync(join(dir, files[0]!.name)));
    } catch {
      // Unreadable: the loop below reports it.
    }
    const name = planHeadingOf(firstText) ?? titleOfSlug(slug);
    plan = store.createPlan({
      id,
      name,
      project_name: project === "_unknown" ? null : project,
      created_at: firstTime.toISOString(),
      created_by: IMPORTED_BY,
      legacy: { chains: [{ project, slug }], snapshots: [] },
      document: { title: name },
    }).plan;
    report.plans_created++;
  }

  const known = new Set(store.versions(id).map((v) => v.legacy));
  let complete = true;
  let newest: { text: string; at: string } | null = null;
  for (const file of files) {
    const legacy = `history/${project}/${slug}/${file.name}`;
    if (known.has(legacy)) continue;
    const path = join(dir, file.name);
    let bytes: Uint8Array;
    let at: Date;
    try {
      bytes = new Uint8Array(readFileSync(path));
      at = statSync(path).mtime;
    } catch {
      report.unreadable.push(legacy);
      complete = false;
      break;
    }
    store.addVersion(id, plan.primary_doc_id, { bytes, committed_at: at.toISOString(), source: "plan-review", ...IMPORTED_BY, legacy });
    report.versions_added++;
    newest = { text: decode(bytes), at: at.toISOString() };
  }
  if (newest) {
    const heading = planHeadingOf(newest.text);
    if (heading && heading !== plan.name) store.updatePlan(id, { name: heading }, newest.at);
  }
  map.chains[key] = {
    plan: id,
    versions: store.versions(id).length,
    last: files[files.length - 1]!.n,
    // Only a chain read to its end is skipped next time; one stopped at an unreadable file is read again.
    ...(complete && dirMtime !== undefined ? { dir_mtime: dirMtime } : {}),
  };
  return true;
}

/** One project's feedback archive; true when the map changed. */
function importFeedback(store: PlanStore, map: PlanLegacyMap, report: PlanImportReport, dataDir: string, project: string): boolean {
  const rel = `feedback/${project}/index.jsonl`;
  const path = join(dataDir, rel);
  let size: number;
  let text: string;
  try {
    size = statSync(path).size;
    if (map.feedback_files[rel] === size) return false;
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const eventsOf = new Map<string, PlanEvent[]>();
  let orphans = 0;
  for (const raw of text.split("\n")) {
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
    const planOfLine = slug ? map.chains[`${project}/${slug}`]?.plan : undefined;
    if (!slug || !planOfLine || !store.get(planOfLine)) {
      orphans++;
      continue;
    }
    const key = `${rel}#${sha1Hex(new TextEncoder().encode(raw))}`;
    let events = eventsOf.get(planOfLine);
    if (!events) {
      events = store.events(planOfLine);
      eventsOf.set(planOfLine, events);
    }
    if (events.some((event) => event.legacy === key)) continue;
    const plan = store.get(planOfLine)!;
    const n = typeof record.target?.planVersion === "number" ? record.target.planVersion : null;
    const version = n === null ? undefined : store.versions(planOfLine).find((v) => v.legacy === `history/${project}/${slug}/${String(n).padStart(3, "0")}.md`);
    const at = typeof record.ts === "string" && !Number.isNaN(Date.parse(record.ts)) ? record.ts : (mtimeOf(path) ?? new Date()).toISOString();
    const event = store.addEvent(planOfLine, {
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
    events.push(event);
    report.decisions_added++;
  }
  report.orphan_feedback += orphans;
  // A file with lines no plan took yet is read again next time.
  if (orphans > 0) return false;
  map.feedback_files[rel] = size;
  return true;
}

/** One decision snapshot; true when the map changed. */
function importSnapshot(store: PlanStore, map: PlanLegacyMap, report: PlanImportReport, dir: string, name: string): boolean {
  const path = join(dir, name);
  let bytes: Uint8Array;
  let at: Date;
  let signature: string;
  try {
    const stat = statSync(path);
    signature = `${stat.size}:${stat.mtimeMs}`;
    if (map.snapshot_files[name] === signature) return false;
    bytes = new Uint8Array(readFileSync(path));
    at = stat.mtime;
  } catch {
    report.unreadable.push(`plans/${name}`);
    return false;
  }
  const sha = gitBlobSha(bytes);
  const key = `plans/${name}#${sha}`;
  const done = () => {
    map.snapshot_files[name] = signature;
    return true;
  };
  if (map.snapshots[key]) return done();
  const [, slug, status] = SNAPSHOT_FILE.exec(name) as unknown as [string, string, "approved" | "denied"];
  const text = decode(bytes);
  const match = matchSnapshot(store, map, slug, text, at);
  const decided = { decision: status as PlanDecisionKind, at: at.toISOString(), feedback: null, feedback_record: null, snapshot: `plans/${name}` };

  if (match) {
    const events = store.events(match.plan);
    if (events.some((event) => event.legacy === key)) {
      map.snapshots[key] = { plan: match.plan, event: events.find((event) => event.legacy === key)!.id };
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

  // A decision without history: a plan of its own, the snapshot as its one version.
  const id = planId("pln", at.getTime());
  const name0 = planHeadingOf(text) ?? titleOfSlug(slug);
  const { plan } = store.createPlan({
    id,
    name: name0,
    created_at: at.toISOString(),
    created_by: IMPORTED_BY,
    legacy: { chains: [], snapshots: [name] },
    document: { title: name0 },
  });
  const version = store.addVersion(id, plan.primary_doc_id, { bytes, committed_at: at.toISOString(), source: "plan-review", ...IMPORTED_BY, legacy: `plans/${name}` });
  const event = store.addEvent(id, {
    kind: "decision",
    at: at.toISOString(),
    ...IMPORTED_BY,
    subject: { document_id: plan.primary_doc_id, version_number: version.version_number },
    decision: { document_id: plan.primary_doc_id, version: version.version, version_number: version.version_number, ...decided },
    legacy: key,
  });
  map.snapshots[key] = { plan: id, event: event.id };
  report.plans_created++;
  report.snapshot_only_plans++;
  report.versions_added++;
  report.decisions_added++;
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
