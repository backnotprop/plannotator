/**
 * The plan library on disk: `<dataDir>/plan-library/` (docs/agent-guides/inbox-plans.md has the layout).
 *
 *   index.jsonl                one line per plan change (the last line per id wins), for a fast list
 *   looks.json                 the person's looks (outside the logs, written whole)
 *   legacy-map.json            what the import took from where (written whole)
 *   <pln_id>/
 *     plan.jsonl               the plan record, one snapshot per change
 *     docs.jsonl               documents and versions (`{ kind: "document" | "version", record }`)
 *     docs/<doc_id>/<n>.md     each version as a plain file, readable without Plannotator
 *     events.jsonl             decisions and activity
 *     files/, comments.jsonl   (later: a plan's files, comments and replies)
 *
 * The Inbox store's rules (packages/shared/inbox/store-log/jsonl-log.ts): one writer (the Inbox server; the CLI only
 * reads), every change appends ONE line in a single append-mode write, a line that does not parse is skipped on read
 * (a torn last line after a crash), and before appending to a file whose last line is torn a newline goes first, so
 * the fragment stays its own unreadable line. Whole files (a version, looks.json, legacy-map.json, a plan's first
 * line) are written to a temp file and renamed. A version's file is written before the line that names it, so a line
 * never names a missing file; a file with no line (a crash between) is never read and is written over by the next
 * version of that number. Folders 0700, files 0600.
 *
 * Nothing here runs unless a caller asks: creating the store reads and writes nothing.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gitBlobSha,
  isPlanDocument,
  isPlanEvent,
  isPlanId,
  isPlanIndexLine,
  isPlanRecord,
  isPlanVersion,
  NO_ACTOR,
  planId,
  type PlanActor,
  type PlanDocument,
  type PlanDocumentKind,
  type PlanEvent,
  type PlanIndexLine,
  type PlanLegacy,
  type PlanLook,
  type PlanLooks,
  type PlanRecord,
  type PlanSummary,
  type PlanVersion,
  type PlanVersionSource,
} from "@plannotator/core/plans";

export const PLAN_LIBRARY_DIR = "plan-library";
export const PLAN_INDEX_FILE = "index.jsonl";
export const PLAN_LOOKS_FILE = "looks.json";
export const PLAN_LEGACY_MAP_FILE = "legacy-map.json";
const PLAN_FILE = "plan.jsonl";
const DOCS_FILE = "docs.jsonl";
const EVENTS_FILE = "events.jsonl";

const EXT: Record<PlanDocumentKind, string> = { markdown: "md", html: "html", mermaid: "mmd", graphviz: "dot" };

export function planLibraryDir(dataDir: string): string {
  return join(dataDir, PLAN_LIBRARY_DIR);
}

/** What the import took from where (legacy-map.json). Hints for a fast pickup; the records themselves are the truth. */
export interface PlanLegacyMap {
  v: 1;
  /** `{project}/{slug}` → its plan, and how far the import has read it. */
  chains: Record<string, { plan: string; versions: number; last: number; dir_mtime?: number }>;
  /** `plans/{file}#{blob sha}` → the plan its decision went to (`event` null: a duplicate of a decision already kept). */
  snapshots: Record<string, { plan: string; event: string | null }>;
  /** `{file name}` → `size:mtimeMs` when last read, so an unchanged snapshot is not read again. */
  snapshot_files: Record<string, string>;
  /** `feedback/{project}/index.jsonl` → how far it was read. */
  feedback_files: Record<string, PlanFeedbackFileState>;
}

/**
 * How far a feedback archive was read: its size then, the byte offset after its last whole line read, and the byte
 * ranges of the lines that had no plan or version to land on yet (read again only when the history changed).
 */
export interface PlanFeedbackFileState {
  size: number;
  read: number;
  pending: [number, number][];
}

const isFeedbackFileState = (value: unknown): value is PlanFeedbackFileState => {
  const state = value as Partial<PlanFeedbackFileState> | null;
  return (
    !!state &&
    typeof state === "object" &&
    Number.isSafeInteger(state.size) &&
    Number.isSafeInteger(state.read) &&
    Array.isArray(state.pending) &&
    state.pending.every((range) => Array.isArray(range) && range.length === 2 && range.every((n) => Number.isSafeInteger(n) && n >= 0) && range[0]! <= range[1]!)
  );
};

const EMPTY_LEGACY_MAP =(): PlanLegacyMap => ({ v: 1, chains: {}, snapshots: {}, snapshot_files: {}, feedback_files: {} });

export interface NewPlanInput {
  /** A chosen id (the import allocates one before it writes the legacy map); absent: a new one. */
  id?: string;
  name: string;
  project_name?: string | null;
  project_id?: string | null;
  project_root?: string | null;
  created_at: string;
  created_by?: PlanActor;
  legacy?: PlanLegacy | null;
  document: { title: string; doc_path?: string | null; kind?: PlanDocumentKind };
}

export interface NewVersionInput extends Partial<PlanActor> {
  bytes: Uint8Array;
  committed_at: string;
  source: PlanVersionSource;
  legacy?: string | null;
}

export interface PlanRead {
  plan: PlanRecord;
  documents: PlanDocument[];
  versions: PlanVersion[];
  events: PlanEvent[];
}

export interface PlanStore {
  readonly root: string;
  /** The library folder exists (something was ever written). */
  exists(): boolean;
  list(): PlanSummary[];
  get(id: string): PlanRecord | null;
  read(id: string): PlanRead | null;
  versions(id: string, docId?: string): PlanVersion[];
  /** A version's file on disk, or null. */
  versionPath(id: string, docId: string, n: number): string | null;
  versionBytes(id: string, docId: string, n: number): Uint8Array | null;
  events(id: string): PlanEvent[];
  looks(): PlanLooks;
  /** The person looked at a plan (and saw version `seen` of `doc`, the primary document when absent). */
  recordLook(id: string, input?: { doc?: string | null; seen?: number | null; at?: string }): PlanLook;
  createPlan(input: NewPlanInput): { plan: PlanRecord; document: PlanDocument };
  addVersion(id: string, docId: string, input: NewVersionInput): PlanVersion;
  addEvent(id: string, event: Omit<PlanEvent, "id" | "plan_id"> & { id?: string }): PlanEvent;
  /** The plan record changed (its name): one more snapshot line. */
  updatePlan(id: string, change: Partial<Pick<PlanRecord, "name" | "note" | "status" | "thread_id" | "legacy">>, at?: string): PlanRecord;
  /** Append an index line for every plan whose last one is missing or behind its files (a crash between writes); how many. */
  repairIndex(): number;
  /** The same, yielding after each plan (the import runs it in the background). */
  repairIndexSteps(): Generator<void, number>;
  legacyMap(): PlanLegacyMap;
  saveLegacyMap(map: PlanLegacyMap): void;
}

// ─────────────────────────────── File rules ───────────────────────────────

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeWhole(path: string, data: string | Uint8Array): void {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, path);
}

/** True when the file ends without a newline (a torn last line): the next append starts on a fresh line. */
function endsTorn(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Append one record as one line, in one append-mode write. */
function appendLine(path: string, value: unknown): void {
  const prefix = endsTorn(path) ? "\n" : "";
  appendFileSync(path, `${prefix}${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** Every line that parses and passes `check`; a torn or foreign line is skipped. */
function readLines<T>(path: string, check: (value: unknown) => value is T): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (check(value)) out.push(value);
    } catch {
      // A torn line from a crash mid-append: skipped.
    }
  }
  return out;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const isDocsLine = (value: unknown): value is { kind: "document" | "version"; record: unknown } =>
  !!value && typeof value === "object" && ((value as { kind?: unknown }).kind === "document" || (value as { kind?: unknown }).kind === "version");

// ─────────────────────────────── The store ───────────────────────────────

export function createPlanStore(options: { dataDir: string; now?: () => number }): PlanStore {
  const root = planLibraryDir(options.dataDir);
  const now = () => new Date(options.now?.() ?? Date.now()).toISOString();
  const folder = (id: string) => join(root, id);

  const ensureRoot = () => ensureDir(root);

  const planOf = (id: string): PlanRecord | null => {
    if (!isPlanId("pln", id)) return null;
    const lines = readLines(join(folder(id), PLAN_FILE), isPlanRecord);
    const last = lines[lines.length - 1];
    return last && last.id === id ? last : null;
  };

  const docsOf = (id: string): { documents: PlanDocument[]; versions: PlanVersion[] } => {
    const documents = new Map<string, PlanDocument>();
    const versions = new Map<string, PlanVersion>();
    for (const line of readLines(join(folder(id), DOCS_FILE), isDocsLine)) {
      if (line.kind === "document" && isPlanDocument(line.record) && line.record.plan_id === id) documents.set(line.record.id, line.record);
      if (line.kind === "version" && isPlanVersion(line.record) && line.record.plan_id === id) {
        // One version per number per document; a repeated line (never written twice, but read leniently) keeps the first.
        const key = `${line.record.document_id}:${line.record.version_number}`;
        if (!versions.has(key)) versions.set(key, line.record);
      }
    }
    const sorted = [...versions.values()].sort((a, b) => (a.document_id === b.document_id ? a.version_number - b.version_number : a.document_id.localeCompare(b.document_id)));
    // The head is the newest version line, whatever the document line says: a crash between the version line and
    // the document line leaves the document one behind, and the next version must not take the same number.
    const heads = new Map<string, number>();
    for (const v of sorted) heads.set(v.document_id, Math.max(heads.get(v.document_id) ?? 0, v.version_number));
    const docs = [...documents.values()].map((doc) => ({ ...doc, head_version: Math.max(doc.head_version, heads.get(doc.id) ?? 0) }));
    return { documents: docs, versions: sorted };
  };

  const eventsOf = (id: string): PlanEvent[] =>
    readLines(join(folder(id), EVENTS_FILE), isPlanEvent)
      .filter((event) => event.plan_id === id)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  const looks = (): PlanLooks => {
    const value = readJson(join(root, PLAN_LOOKS_FILE)) as Partial<PlanLooks> | null;
    if (!value || value.v !== 1 || !value.plans || typeof value.plans !== "object") return { v: 1, plans: {} };
    return { v: 1, plans: value.plans };
  };

  /** The index line for a plan as it stands now, from its own files. */
  const indexLineOf = (id: string): PlanIndexLine | null => {
    const plan = planOf(id);
    if (!plan) return null;
    const { documents, versions } = docsOf(id);
    const events = eventsOf(id);
    const primary = documents.find((doc) => doc.id === plan.primary_doc_id);
    const decisions = events.filter((event) => event.kind === "decision" && event.decision);
    const latest = decisions[decisions.length - 1]?.decision;
    const times = [plan.updated_at, ...versions.map((v) => v.committed_at), ...events.map((e) => e.at)].sort();
    return {
      id,
      name: plan.name,
      project_id: plan.project_id,
      project_name: plan.project_name,
      status: plan.status,
      created_at: plan.created_at,
      updated_at: times[times.length - 1] ?? plan.updated_at,
      primary_doc_id: plan.primary_doc_id,
      head_version_number: primary?.head_version ?? 0,
      decision: latest ? { decision: latest.decision, version_number: latest.version_number, at: latest.at } : null,
      counts: { documents: documents.length, versions: versions.length, comments: 0, artifacts: 0, events: events.length },
    };
  };

  const appendIndex = (id: string) => {
    const line = indexLineOf(id);
    if (line) appendLine(join(root, PLAN_INDEX_FILE), line);
  };

  const versionFile = (docId: string, n: number, kind: PlanDocumentKind = "markdown") => `docs/${docId}/${n}.${EXT[kind]}`;

  return {
    root,
    exists: () => existsSync(root),

    list() {
      const latest = new Map<string, PlanIndexLine>();
      for (const line of readLines(join(root, PLAN_INDEX_FILE), isPlanIndexLine)) latest.set(line.id, line);
      const seen = looks().plans;
      return [...latest.values()]
        .map((line): PlanSummary => {
          const look = seen[line.id];
          const seenVersion = look ? (look.docs[line.primary_doc_id] ?? null) : null;
          return { ...line, looked_at: look?.looked_at ?? null, seen_version_number: seenVersion, changed: look !== undefined && line.head_version_number > (seenVersion ?? 0) };
        })
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
    },

    get: planOf,

    read(id) {
      const plan = planOf(id);
      if (!plan) return null;
      return { plan, ...docsOf(id), events: eventsOf(id) };
    },

    versions(id, docId) {
      const plan = planOf(id);
      if (!plan) return [];
      const doc = docId ?? plan.primary_doc_id;
      return docsOf(id).versions.filter((v) => v.document_id === doc);
    },

    versionPath(id, docId, n) {
      const version = this.versions(id, docId).find((v) => v.version_number === n);
      if (!version) return null;
      const path = join(folder(id), version.file);
      return existsSync(path) ? path : null;
    },

    versionBytes(id, docId, n) {
      const path = this.versionPath(id, docId, n);
      if (!path) return null;
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        return null;
      }
    },

    events: eventsOf,
    looks,

    recordLook(id, input = {}) {
      const plan = planOf(id);
      if (!plan) throw new Error(`No plan ${id}.`);
      const all = looks();
      const doc = input.doc ?? plan.primary_doc_id;
      const look: PlanLook = { looked_at: input.at ?? now(), docs: { ...(all.plans[id]?.docs ?? {}) } };
      if (input.seen !== undefined && input.seen !== null) look.docs[doc] = Math.max(look.docs[doc] ?? 0, input.seen);
      all.plans[id] = look;
      ensureRoot();
      writeWhole(join(root, PLAN_LOOKS_FILE), `${JSON.stringify(all, null, 2)}\n`);
      return look;
    },

    createPlan(input) {
      const id = input.id ?? planId("pln", Date.parse(input.created_at) || undefined);
      if (!isPlanId("pln", id)) throw new Error(`Not a plan id: ${id}`);
      if (planOf(id)) throw new Error(`Plan ${id} already exists.`);
      // A crash after the document line and before plan.jsonl leaves the document: it is this plan's, so it is kept.
      const orphan = existsSync(folder(id)) ? docsOf(id).documents[0] : undefined;
      const docId = orphan?.id ?? planId("doc", Date.parse(input.created_at) || undefined);
      const plan: PlanRecord = {
        id,
        name: input.name,
        note: null,
        project_id: input.project_id ?? null,
        project_root: input.project_root ?? null,
        project_name: input.project_name ?? null,
        primary_doc_id: docId,
        status: "active",
        thread_id: null,
        created_at: input.created_at,
        updated_at: input.created_at,
        created_by: input.created_by ?? NO_ACTOR,
        legacy: input.legacy ?? null,
      };
      const document: PlanDocument = {
        id: docId,
        plan_id: id,
        doc_path: input.document.doc_path ?? null,
        kind: input.document.kind ?? "markdown",
        title: input.document.title,
        head_version: 0,
        created_at: input.created_at,
        archived_at: null,
      };
      ensureRoot();
      ensureDir(folder(id));
      // The document line before the plan record: a plan that reads always has its primary document.
      if (!orphan) appendLine(join(folder(id), DOCS_FILE), { kind: "document", record: document });
      // The first record whole (temp, then rename): a plan folder never holds a torn first record.
      writeWhole(join(folder(id), PLAN_FILE), `${JSON.stringify(plan)}\n`);
      appendIndex(id);
      return { plan, document: orphan ?? document };
    },

    addVersion(id, docId, input) {
      const plan = planOf(id);
      if (!plan) throw new Error(`No plan ${id}.`);
      const { documents } = docsOf(id);
      const doc = documents.find((d) => d.id === docId);
      if (!doc) throw new Error(`Plan ${id} has no document ${docId}.`);
      const n = doc.head_version + 1;
      const file = versionFile(docId, n, doc.kind);
      ensureDir(join(folder(id), "docs", docId));
      // The bytes first: a line never names a file that is not there.
      writeWhole(join(folder(id), file), input.bytes);
      const version: PlanVersion = {
        version: gitBlobSha(input.bytes),
        version_number: n,
        document_id: docId,
        plan_id: id,
        file,
        size: input.bytes.length,
        committed_at: input.committed_at,
        source: input.source,
        legacy: input.legacy ?? null,
        author_label: input.author_label ?? null,
        author_via: input.author_via ?? null,
        agent_host: input.agent_host ?? null,
        agent_session: input.agent_session ?? null,
        agent_name: input.agent_name ?? null,
      };
      appendLine(join(folder(id), DOCS_FILE), { kind: "version", record: version });
      appendLine(join(folder(id), DOCS_FILE), { kind: "document", record: { ...doc, head_version: n } });
      const updated = input.committed_at > plan.updated_at ? input.committed_at : plan.updated_at;
      if (updated !== plan.updated_at) appendLine(join(folder(id), PLAN_FILE), { ...plan, updated_at: updated });
      appendIndex(id);
      return version;
    },

    addEvent(id, input) {
      if (!planOf(id)) throw new Error(`No plan ${id}.`);
      const event = { ...input, id: input.id ?? planId("actev", Date.parse(input.at) || undefined), plan_id: id } as PlanEvent;
      if (!isPlanEvent(event)) throw new Error("Not a plan event.");
      appendLine(join(folder(id), EVENTS_FILE), event);
      appendIndex(id);
      return event;
    },

    updatePlan(id, change, when) {
      const plan = planOf(id);
      if (!plan) throw new Error(`No plan ${id}.`);
      const at = when ?? now();
      const next: PlanRecord = { ...plan, ...change, updated_at: at > plan.updated_at ? at : plan.updated_at };
      appendLine(join(folder(id), PLAN_FILE), next);
      appendIndex(id);
      return next;
    },

    repairIndex() {
      const steps = this.repairIndexSteps();
      for (;;) {
        const next = steps.next();
        if (next.done) return next.value;
      }
    },

    *repairIndexSteps() {
      const listed = new Map<string, string>();
      for (const line of readLines(join(root, PLAN_INDEX_FILE), isPlanIndexLine)) listed.set(line.id, JSON.stringify(line));
      let repaired = 0;
      for (const id of planFolders(options.dataDir)) {
        const line = indexLineOf(id);
        if (line && listed.get(id) !== JSON.stringify(line)) {
          appendLine(join(root, PLAN_INDEX_FILE), line);
          repaired++;
        }
        yield;
      }
      return repaired;
    },

    legacyMap() {
      const value = readJson(join(root, PLAN_LEGACY_MAP_FILE)) as Partial<PlanLegacyMap> | null;
      if (!value || value.v !== 1) return EMPTY_LEGACY_MAP();
      return {
        v: 1,
        chains: value.chains && typeof value.chains === "object" ? value.chains : {},
        snapshots: value.snapshots && typeof value.snapshots === "object" ? value.snapshots : {},
        snapshot_files: value.snapshot_files && typeof value.snapshot_files === "object" ? value.snapshot_files : {},
        feedback_files: Object.fromEntries(Object.entries(value.feedback_files && typeof value.feedback_files === "object" ? value.feedback_files : {}).filter(([, state]) => isFeedbackFileState(state))),
      };
    },

    saveLegacyMap(map) {
      ensureRoot();
      writeWhole(join(root, PLAN_LEGACY_MAP_FILE), `${JSON.stringify(map, null, 2)}\n`);
    },
  };
}

/** The plan folders on disk (for tests and repairs): names that are plan ids. */
export function planFolders(dataDir: string): string[] {
  try {
    return readdirSync(planLibraryDir(dataDir)).filter((name) => isPlanId("pln", name));
  } catch {
    return [];
  }
}
