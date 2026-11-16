/**
 * Plannotator Plans: the plan library's records (browser-safe: types, ids, pure checks, the git blob SHA; no I/O).
 *
 * A plan is one plan and everything that belongs to it: its documents (the plan itself is the primary one), each
 * document's versions, its files, comments, decisions and activity. The store is
 * packages/shared/plans/store.ts (`<dataDir>/plan-library/`); docs/agent-guides/inbox-plans.md has the layout.
 *
 * The field names are what they are (snake_case, as stored); the on-screen word is always "plan".
 */
import { ulid } from "./ulid";

// ─────────────────────────────── Ids ───────────────────────────────

/** Id prefixes: `pln` a plan, `doc` a document, `anno` a comment, `reply` a reply, `actev` an activity event. */
export const PLAN_ID_PREFIXES = ["pln", "doc", "anno", "reply", "actev"] as const;
export type PlanIdPrefix = (typeof PLAN_ID_PREFIXES)[number];

export function planId(prefix: PlanIdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

const ULID_PART = "[0-9A-HJKMNP-TV-Z]{26}";
const PLAN_ID_RE: Record<PlanIdPrefix, RegExp> = {
  pln: new RegExp(`^pln_${ULID_PART}$`),
  doc: new RegExp(`^doc_${ULID_PART}$`),
  anno: new RegExp(`^anno_${ULID_PART}$`),
  reply: new RegExp(`^reply_${ULID_PART}$`),
  actev: new RegExp(`^actev_${ULID_PART}$`),
};

export function isPlanId(prefix: PlanIdPrefix, value: unknown): value is string {
  return typeof value === "string" && PLAN_ID_RE[prefix].test(value);
}

// ─────────────────────────────── Records ───────────────────────────────

export type PlanStatus = "active" | "done" | "archived";
export const PLAN_STATUSES: readonly PlanStatus[] = ["active", "done", "archived"];

export type PlanDocumentKind = "markdown" | "html" | "mermaid" | "graphviz";
export const PLAN_DOCUMENT_KINDS: readonly PlanDocumentKind[] = ["markdown", "html", "mermaid", "graphviz"];

/** Where a version came from. Imported history versions are `plan-review`: plan review wrote them. */
export type PlanVersionSource = "plan-review" | "agent-tool" | "annotate-live" | "person";
export const PLAN_VERSION_SOURCES: readonly PlanVersionSource[] = ["plan-review", "agent-tool", "annotate-live", "person"];

/** A plan review's outcome on one version (the feedback archive's plan decisions, and the decision snapshots'). */
export type PlanDecisionKind = "approved" | "approved-with-notes" | "denied" | "feedback";
export const PLAN_DECISION_KINDS: readonly PlanDecisionKind[] = ["approved", "approved-with-notes", "denied", "feedback"];

export type PlanEventKind = "version_saved" | "document_created" | "asset_published" | "decision" | "comment_sent" | "agent_replied" | "archived";
export const PLAN_EVENT_KINDS: readonly PlanEventKind[] = ["version_saved", "document_created", "asset_published", "decision", "comment_sent", "agent_replied", "archived"];

/** Who made a change. Every field may be null (an import knows none of them). */
export interface PlanActor {
  author_label: string | null;
  /** How it came in: `plan-review`, `agent-tool`, `person`, `import`… An open set. */
  author_via: string | null;
  agent_host: string | null;
  agent_session: string | null;
  agent_name: string | null;
}

export const NO_ACTOR: PlanActor = { author_label: null, author_via: null, agent_host: null, agent_session: null, agent_name: null };

/** The files a plan was built from, relative to the data dir (read, never changed). */
export interface PlanLegacy {
  /** `history/{project}/{slug}` chains. */
  chains: { project: string; slug: string }[];
  /** Decision snapshots, as `plans/{slug}-approved.md#{blob sha}` (or `-denied.md`): the file and the text it held. */
  snapshots: string[];
}

export interface PlanRecord {
  id: string;
  /** The primary document's first heading (editable later). */
  name: string;
  note: string | null;
  /** The Inbox project (`prj_…`), once known; null for an imported plan. */
  project_id: string | null;
  project_root: string | null;
  /** The project's name as plan history files it (the `history/{project}` folder); null when unknown. */
  project_name: string | null;
  primary_doc_id: string;
  status: PlanStatus;
  /** Its Inbox thread, made on the first send. */
  thread_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: PlanActor;
  legacy: PlanLegacy | null;
}

export interface PlanDocument {
  id: string;
  plan_id: string;
  /** Display only: the id is the identity. */
  doc_path: string | null;
  kind: PlanDocumentKind;
  title: string;
  /** The newest version's number; 0 before the first. */
  head_version: number;
  created_at: string;
  archived_at: string | null;
}

export interface PlanVersion extends PlanActor {
  /** The git blob SHA-1 of the bytes (`gitBlobSha`). */
  version: string;
  /** 1, 2, 3… per document, with no gaps. */
  version_number: number;
  document_id: string;
  plan_id: string;
  /** Relative to the plan's folder: `docs/<doc_id>/<n>.md`. */
  file: string;
  size: number;
  committed_at: string;
  source: PlanVersionSource;
  /** The file it was imported from, relative to the data dir (`history/p/s/003.md`); null for a new one. */
  legacy: string | null;
}

/** A non-document file a plan keeps (bytes in its `files/`). Not written yet. */
export interface PlanArtifact {
  asset_path: string;
  /** SHA-256 of the bytes. */
  content_hash: string;
  content_type: string;
  size: number;
  title: string | null;
  created_at: string;
}

export type PlanCommentTarget =
  | { kind: "document"; document_id: string; document_version: string }
  | { kind: "asset"; asset_path: string; asset_sha: string }
  | { kind: "plan" };

/** A comment on a version, a file or the whole plan. Not written yet. */
export interface PlanComment extends PlanActor {
  id: string;
  plan_id: string;
  target: PlanCommentTarget;
  /** Plannotator's own annotation JSON, opaque to the store. */
  anchor: unknown;
  body: string;
  state: "open" | "resolved";
  created_at: string;
  sent: { at: string; message_id: string; to: { host: string; session: string } } | null;
}

export interface PlanReply extends PlanActor {
  id: string;
  annotation_id: string;
  body: string;
  created_at: string;
}

export interface PlanDecision {
  document_id: string;
  /** The version's blob SHA; null when the version it names was never imported. */
  version: string | null;
  version_number: number | null;
  decision: PlanDecisionKind;
  at: string;
  /** The person's notes with it, as the feedback archive holds them. */
  feedback: string | null;
  /** The feedback archive line it came from: `feedback/{project}/index.jsonl` and the line's SHA-1. */
  feedback_record: { file: string; line_sha: string; record_file: string | null } | null;
  /** The decision snapshot it came from (`plans/…-approved.md`), when one. */
  snapshot: string | null;
}

export interface PlanEvent extends PlanActor {
  id: string;
  plan_id: string;
  kind: PlanEventKind;
  at: string;
  /** What it is about: a document and version, an asset, a comment. */
  subject: { document_id?: string; version_number?: number | null; asset_path?: string; annotation_id?: string } | null;
  /** Present on `decision` events. */
  decision?: PlanDecision;
  /** The file (or line) it was imported from, so an import never adds it twice. */
  legacy: string | null;
}

/** What the person last saw of one plan. */
export interface PlanLook {
  looked_at: string;
  /** Per document: the newest version number the person has seen. */
  docs: Record<string, number>;
}

export interface PlanLooks {
  v: 1;
  plans: Record<string, PlanLook>;
}

/** One line of `index.jsonl`: a plan as the list shows it (the last line per id wins). */
export interface PlanIndexLine {
  id: string;
  name: string;
  project_id: string | null;
  project_name: string | null;
  status: PlanStatus;
  created_at: string;
  /** The last change: a version, a decision, a status. */
  updated_at: string;
  primary_doc_id: string;
  head_version_number: number;
  /** The newest decision (by time), or null. */
  decision: { decision: PlanDecisionKind; version_number: number | null; at: string } | null;
  counts: { documents: number; versions: number; comments: number; artifacts: number; events: number };
}

/** A plan in the list: its index line and the person's look. */
export interface PlanSummary extends PlanIndexLine {
  looked_at: string | null;
  /** The primary document's newest version the person has seen; null before the first look. */
  seen_version_number: number | null;
  /** Looked at before, and a newer version came since. */
  changed: boolean;
}

// ─────────────────────────────── Checks ───────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isIso = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));

export function isPlanVersionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isGitBlobSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isActor(value: Record<string, unknown>): boolean {
  return ["author_label", "author_via", "agent_host", "agent_session", "agent_name"].every((key) => value[key] === undefined || isStringOrNull(value[key]));
}

/** A plan record as the store reads it back; a line that is not one is skipped. */
export function isPlanRecord(value: unknown): value is PlanRecord {
  if (!isObject(value)) return false;
  return (
    isPlanId("pln", value.id) &&
    typeof value.name === "string" &&
    isPlanId("doc", value.primary_doc_id) &&
    PLAN_STATUSES.includes(value.status as PlanStatus) &&
    isIso(value.created_at) &&
    isIso(value.updated_at) &&
    isStringOrNull(value.project_name ?? null) &&
    isStringOrNull(value.thread_id ?? null) &&
    isObject(value.created_by) &&
    isActor(value.created_by)
  );
}

export function isPlanDocument(value: unknown): value is PlanDocument {
  if (!isObject(value)) return false;
  return (
    isPlanId("doc", value.id) &&
    isPlanId("pln", value.plan_id) &&
    PLAN_DOCUMENT_KINDS.includes(value.kind as PlanDocumentKind) &&
    typeof value.title === "string" &&
    typeof value.head_version === "number" &&
    Number.isSafeInteger(value.head_version) &&
    value.head_version >= 0 &&
    isIso(value.created_at)
  );
}

export function isPlanVersion(value: unknown): value is PlanVersion {
  if (!isObject(value)) return false;
  return (
    isGitBlobSha(value.version) &&
    isPlanVersionNumber(value.version_number) &&
    isPlanId("doc", value.document_id) &&
    isPlanId("pln", value.plan_id) &&
    typeof value.file === "string" &&
    /^docs\/doc_[0-9A-HJKMNP-TV-Z]{26}\/[1-9][0-9]*\.[a-z]+$/.test(value.file) &&
    typeof value.size === "number" &&
    isIso(value.committed_at) &&
    PLAN_VERSION_SOURCES.includes(value.source as PlanVersionSource) &&
    isStringOrNull(value.legacy ?? null) &&
    isActor(value)
  );
}

export function isPlanDecision(value: unknown): value is PlanDecision {
  if (!isObject(value)) return false;
  return (
    isPlanId("doc", value.document_id) &&
    (value.version === null || isGitBlobSha(value.version)) &&
    (value.version_number === null || isPlanVersionNumber(value.version_number)) &&
    PLAN_DECISION_KINDS.includes(value.decision as PlanDecisionKind) &&
    isIso(value.at)
  );
}

export function isPlanEvent(value: unknown): value is PlanEvent {
  if (!isObject(value)) return false;
  return (
    isPlanId("actev", value.id) &&
    isPlanId("pln", value.plan_id) &&
    PLAN_EVENT_KINDS.includes(value.kind as PlanEventKind) &&
    isIso(value.at) &&
    (value.kind !== "decision" || isPlanDecision(value.decision)) &&
    isStringOrNull(value.legacy ?? null) &&
    isActor(value)
  );
}

export function isPlanIndexLine(value: unknown): value is PlanIndexLine {
  if (!isObject(value)) return false;
  return (
    isPlanId("pln", value.id) &&
    typeof value.name === "string" &&
    PLAN_STATUSES.includes(value.status as PlanStatus) &&
    isIso(value.updated_at) &&
    isPlanId("doc", value.primary_doc_id) &&
    typeof value.head_version_number === "number" &&
    isObject(value.counts)
  );
}

/** The `seen` a look may record for a document: a version number from 1 to the document's head. */
export function checkPlanLookInput(input: unknown): { ok: true; doc: string | null; seen: number | null } | { ok: false; error: string } {
  if (input !== undefined && input !== null && !isObject(input)) return { ok: false, error: "the body is { doc?, seen? }" };
  const body = (input ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => key !== "doc" && key !== "seen" && key !== "serverSession");
  if (unknown) return { ok: false, error: `unknown field ${unknown}` };
  if (body.doc !== undefined && !isPlanId("doc", body.doc)) return { ok: false, error: "doc is a document id (doc_…)" };
  if (body.seen !== undefined && !isPlanVersionNumber(body.seen)) return { ok: false, error: "seen is a version number" };
  return { ok: true, doc: (body.doc as string | undefined) ?? null, seen: (body.seen as number | undefined) ?? null };
}

/** The first `# heading` of a markdown document, trimmed; null when it has none. */
export function planHeadingOf(markdown: string): string | null {
  const match = /^#\s+(.+)$/m.exec(markdown);
  const heading = match?.[1]?.trim();
  return heading ? heading : null;
}

// ─────────────────────────────── The version id ───────────────────────────────

/**
 * The git blob SHA-1 of a version's bytes (`git hash-object`): SHA-1 over `blob <length>\0<bytes>`. Computed, not
 * stored in a repository, so a version keeps the same id wherever its bytes go.
 */
export function gitBlobSha(content: Uint8Array | string): string {
  const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header, 0);
  all.set(body, header.length);
  return sha1Hex(all);
}

/** SHA-1, synchronous and dependency-free (browser-safe). Only for content ids, never for security. */
export function sha1Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = (((length + 9 + 63) >> 6) << 6) >>> 0;
  const buffer = new Uint8Array(padded);
  buffer.set(bytes);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = length * 8;
  view.setUint32(padded - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded - 4, bits >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}
