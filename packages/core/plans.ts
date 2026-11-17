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

/**
 * A page's kind. `image`: a picture (PNG, JPEG, GIF, WebP, AVIF or SVG; its type is read from its bytes,
 * `planPictureTypeOf`); `data`: a table as CSV or TSV text. Both are read-only on the plan page, as a diagram or an
 * HTML page is.
 */
export type PlanDocumentKind = "markdown" | "html" | "mermaid" | "graphviz" | "image" | "data";
export const PLAN_DOCUMENT_KINDS: readonly PlanDocumentKind[] = ["markdown", "html", "mermaid", "graphviz", "image", "data"];

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
  /** The last time a new version cleared approvals (approval "plans-editing"); absent before the first. */
  last_approval_cleared?: PlanApprovalCleared | null;
  /** The last time the person's own edit carried their approval to the new version; absent before the first. */
  last_approval_moved?: PlanApprovalMoved | null;
  /**
   * Per document id, the newest version of the person's the agent was told about (a Done or Restore's "Direct Edits"
   * that went: `POST /:id/sent` with `told`). The agent knows its own versions anyway; absent before the first.
   */
  agent_told?: Record<string, number>;
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
  /** A Restore: the version whose bytes this one took again (present only on a restore). */
  restored_from?: number;
}

/**
 * A non-document file a plan keeps: its bytes at `files/<asset_path>`, its record a line of `artifacts.jsonl` (the
 * last line per path wins). Read and shown; nothing writes one yet but the store's own `addArtifact`.
 */
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

/** A comment on a version, a file or the whole plan. Written for now only on a document version (the plan page's comments, `comments.jsonl`). */
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
  /** An approval the person's own edit carried here from that version (present only then). */
  moved_from?: number;
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
  /** Where the main page's approval stands on its newest version (`planApprovalState`); absent from an older line. */
  approval?: PlanApprovalState;
  counts: { documents: number; versions: number; comments: number; artifacts: number; events: number };
  /** The main page's kind (its face on the Spaces home); absent from an older line: read as Markdown. */
  primary_kind?: PlanDocumentKind;
  /** Who wrote the main page's newest version (`person`: the person's own edit or Restore); absent from an older line. */
  head_source?: PlanVersionSource | null;
  /** The main page's version numbers that hold a decision of the person's (approved or changes asked), oldest first. */
  decided_versions?: number[];
  /** When the main page's newest version came (its `committed_at`); absent from an older line (read `updated_at`). */
  head_at?: string | null;
  /**
   * The agent session that wrote the main page's newest version, when it said so (plan review records the session it
   * ran in: `history/{project}/{slug}/NNN.agent.json`); null when none is known. The Spaces home says "<agent> is
   * working" only while this session is live in the Inbox and this is the newest plan it submitted.
   */
  head_agent?: PlanHeadAgent | null;
}

/** An agent session as a version records it: its host (`claude-code`, `codex`, …), its session id and its name. */
export interface PlanHeadAgent {
  host: string;
  session: string;
  name: string | null;
}

/** The person's pinned plans, in their order (`pins.json`, written whole), and the Spaces home's view. */
export interface PlanPins {
  v: 1;
  ids: string[];
}

/** The Spaces home's two views (config.json `inboxSpacesView`, the person's): cards, or a list of rows. */
export type SpacesView = "cards" | "list";
export const SPACES_VIEWS: readonly SpacesView[] = ["cards", "list"];

/** `POST /api/plans/pins`: pin a plan (at `index`, else last), move it, or unpin it. */
export function checkPlanPinInput(input: unknown): { ok: true; id: string; pinned: boolean; index: number | null } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "the body is { id, pinned, index? }" };
  const unknown = Object.keys(input).find((key) => !["id", "pinned", "index", "serverSession"].includes(key));
  if (unknown) return { ok: false, error: `unknown field ${unknown}` };
  if (!isPlanId("pln", input.id)) return { ok: false, error: "id is a plan id (pln_…)" };
  if (typeof input.pinned !== "boolean") return { ok: false, error: "pinned is true or false" };
  if (input.index !== undefined && input.index !== null && !(typeof input.index === "number" && Number.isSafeInteger(input.index) && input.index >= 0)) return { ok: false, error: "index is a place from 0" };
  return { ok: true, id: input.id, pinned: input.pinned, index: typeof input.index === "number" ? input.index : null };
}

/** `POST /api/plans/view`: the Spaces home's view. */
export function checkSpacesViewInput(input: unknown): { ok: true; view: SpacesView } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "the body is { view }" };
  const unknown = Object.keys(input).find((key) => key !== "view" && key !== "serverSession");
  if (unknown) return { ok: false, error: `unknown field ${unknown}` };
  if (!SPACES_VIEWS.includes(input.view as SpacesView)) return { ok: false, error: "view is cards or list" };
  return { ok: true, view: input.view as SpacesView };
}

/** A pin list with `id` put at `index` (else last; already pinned, where it is), or taken out; every other id keeps its order. */
export function planPinsWith(ids: readonly string[], id: string, pinned: boolean, index: number | null): string[] {
  const rest = ids.filter((one) => one !== id);
  if (!pinned) return rest;
  if (index === null && rest.length < ids.length) return [...ids];
  const at = index === null ? rest.length : Math.min(index, rest.length);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
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

/** Names Windows keeps for devices (with or without an extension): such a file cannot be written or copied there. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/**
 * An artifact's path under its plan's `files/`: relative, `/`-separated, each segment a plain name that every disk
 * can hold (no `.` or `..`, no leading dot, no trailing dot or space, no backslash, no control character, none of
 * `<>:"|?*`, no Windows device name such as `CON` or `com1.txt`), at most 200 characters. Anything else names no
 * artifact.
 */
export function isPlanAssetPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  if (/[\\\u0000-\u001f\u007f<>:"|?*]/.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && !segment.startsWith(".") && !/[. ]$/.test(segment) && !WINDOWS_DEVICE_NAME.test(segment));
}

/**
 * The picture types an artifact is shown as a picture for, and served as itself: raster formats every browser draws.
 * Anything else under `image/` (BMP, TIFF, HEIC…) is a download, as the server sends it. One list for both sides.
 */
export const PLAN_PICTURE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

/** A media type without its parameters, lower case: `Image/PNG; x=1` → `image/png`. */
export const planMediaType = (contentType: string) => contentType.split(";")[0]!.trim().toLowerCase();

export const isPlanPictureType = (contentType: string) => PLAN_PICTURE_TYPES.includes(planMediaType(contentType));

export function isPlanArtifact(value: unknown): value is PlanArtifact {
  if (!isObject(value)) return false;
  return (
    isPlanAssetPath(value.asset_path) &&
    typeof value.content_hash === "string" &&
    /^[0-9a-f]{64}$/.test(value.content_hash) &&
    typeof value.content_type === "string" &&
    value.content_type.length > 0 &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    isStringOrNull(value.title ?? null) &&
    isIso(value.created_at)
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

/** The most one comment's annotation may hold (its JSON, in characters): the Inbox's cap for a live comment. */
export const PLAN_COMMENT_MAX = 128 * 1024;

/** An annotation's own id as a comment keeps it (Plannotator's `Annotation.id`): the Inbox's rule for a file comment's id. */
export const isPlanAnnotationId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

/** The id of the annotation a comment holds (its `anchor`), or null. */
export function planCommentAnnotationId(comment: Pick<PlanComment, "anchor">): string | null {
  const id = isObject(comment.anchor) ? comment.anchor.id : null;
  return isPlanAnnotationId(id) ? id : null;
}

/** A comment line as the store reads it back (`comments.jsonl`); a line that is not one is skipped. */
export function isPlanComment(value: unknown): value is PlanComment {
  if (!isObject(value) || !isObject(value.target)) return false;
  const target = value.target;
  return (
    isPlanId("anno", value.id) &&
    isPlanId("pln", value.plan_id) &&
    target.kind === "document" &&
    isPlanId("doc", target.document_id) &&
    isGitBlobSha(target.document_version) &&
    planCommentAnnotationId({ anchor: value.anchor }) !== null &&
    typeof value.body === "string" &&
    (value.state === "open" || value.state === "resolved") &&
    isIso(value.created_at) &&
    (value.sent === null || isObject(value.sent)) &&
    isActor(value)
  );
}

/**
 * The body of `POST /api/plans/:id/comments`: the person's annotation (Plannotator's `Annotation`, as the Inbox's file
 * viewer made it) on one version of a document (`doc` absent: the primary one).
 */
export function checkPlanCommentInput(input: unknown): { ok: true; doc: string | null; version: number; annotation: Record<string, unknown> } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "the body is { doc?, version, annotation }" };
  const unknown = Object.keys(input).find((key) => key !== "doc" && key !== "version" && key !== "annotation" && key !== "serverSession");
  if (unknown) return { ok: false, error: `unknown field ${unknown}` };
  if (input.doc !== undefined && !isPlanId("doc", input.doc)) return { ok: false, error: "doc is a document id (doc_…)" };
  if (!isPlanVersionNumber(input.version)) return { ok: false, error: "version is a version number" };
  if (!isObject(input.annotation)) return { ok: false, error: "annotation: an object" };
  if (!isPlanAnnotationId(input.annotation.id)) return { ok: false, error: "annotation.id: a short id" };
  if (JSON.stringify(input.annotation).length > PLAN_COMMENT_MAX) return { ok: false, error: `annotation: at most ${PLAN_COMMENT_MAX / 1024} KB` };
  return { ok: true, doc: (input.doc as string | undefined) ?? null, version: input.version, annotation: input.annotation };
}

/** The most a version the person writes may hold (its text, in bytes): what a plan review's editor ever sends. */
export const PLAN_TEXT_MAX = 2 * 1024 * 1024;

/**
 * A face on the Spaces home reads only the top of a version (`GET /api/plans/:id/versions/:n?face=1`): a document's
 * first `PLAN_FACE_TEXT_BYTES`, cut at a line's end; an HTML page whole, or nothing above `PLAN_FACE_HTML_MAX` (the
 * card shows its kind's ground).
 */
export const PLAN_FACE_TEXT_BYTES = 16 * 1024;
export const PLAN_FACE_HTML_MAX = 512 * 1024;
/** A picture page's face is the picture itself, up to this size (above it, the card shows its kind's ground). */
export const PLAN_FACE_PICTURE_MAX = 2 * 1024 * 1024;
/** ...and up to this many pixels, read from its header (a picture small in bytes can be huge once decoded). */
export const PLAN_FACE_PICTURE_PIXELS = 4096 * 4096;

/**
 * A raster picture's size from its header, without decoding it: PNG, GIF, WebP (lossy, lossless, extended) and JPEG
 * (its first frame header); null when the header does not say (SVG, AVIF, a cut or odd file).
 */
export function planPictureSize(bytes: Uint8Array): { width: number; height: number } | null {
  const type = planPictureTypeOf(bytes);
  const at = (i: number) => bytes[i] ?? 0;
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const le24 = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (type === "image/png" && bytes.length >= 24 && ascii(12, 16) === "IHDR") return { width: ((at(16) << 24) >>> 0) + (at(17) << 16) + (at(18) << 8) + at(19), height: ((at(20) << 24) >>> 0) + (at(21) << 16) + (at(22) << 8) + at(23) };
  if (type === "image/gif" && bytes.length >= 10) return { width: le16(6), height: le16(8) };
  if (type === "image/webp" && bytes.length >= 30) {
    const chunk = ascii(12, 16);
    if (chunk === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === "VP8L") return { width: 1 + (at(21) | ((at(22) & 0x3f) << 8)), height: 1 + ((at(22) >> 6) | (at(23) << 2) | ((at(24) & 0x0f) << 10)) };
    if (chunk === "VP8X") return { width: 1 + le24(24), height: 1 + le24(27) };
    return null;
  }
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) {
        i++;
        continue;
      }
      // A frame header (SOF0 to SOF15, but not DHT, JPG or DAC): its height, then its width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: be16(i + 7), height: be16(i + 5) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

/** `GET /api/plans/:id/versions/:n?face=1`: the top of a version for its face; `text` null when it is too big to draw. */
export interface PlanFaceText {
  text: string | null;
  /** The text is the version's first part only. */
  cut: boolean;
  /** A picture page: the picture as a `data:` URL (null when it is too big, or not a picture this list draws). */
  picture?: string | null;
}

/** The picture types a picture page may hold: the raster ones every browser draws, and SVG (drawn as a picture). */
export const PLAN_PAGE_PICTURE_TYPES: readonly string[] = [...PLAN_PICTURE_TYPES, "image/svg+xml"];

/** A picture's type from its first bytes (never its name): PNG, JPEG, GIF, WebP, AVIF or SVG; else null. */
export function planPictureTypeOf(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/**
 * The body of `POST /api/plans/:id/versions`: a new newest version the person made, either their edit of the newest
 * (`text`) or a Restore of an older one (`restore`, its number). `base` is the version number on screen when they
 * started: the Inbox refuses it once a newer version came (the plan moved on), so nothing is written over unseen.
 */
export function checkPlanVersionInput(input: unknown): { ok: true; doc: string | null; base: number; text: string | null; restore: number | null } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "the body is { doc?, base, text } or { doc?, base, restore }" };
  const unknown = Object.keys(input).find((key) => !["doc", "base", "text", "restore", "serverSession"].includes(key));
  if (unknown) return { ok: false, error: `unknown field ${unknown}` };
  if (input.doc !== undefined && !isPlanId("doc", input.doc)) return { ok: false, error: "doc is a document id (doc_…)" };
  if (!isPlanVersionNumber(input.base)) return { ok: false, error: "base is the version number the edit started from" };
  const hasText = input.text !== undefined;
  const hasRestore = input.restore !== undefined;
  if (hasText === hasRestore) return { ok: false, error: "send text or restore, one of them" };
  if (hasText && typeof input.text !== "string") return { ok: false, error: "text: the document's words" };
  if (hasText && new TextEncoder().encode(input.text as string).length > PLAN_TEXT_MAX) return { ok: false, error: `text: at most ${PLAN_TEXT_MAX / 1024 / 1024} MB` };
  if (hasRestore && !isPlanVersionNumber(input.restore)) return { ok: false, error: "restore is a version number" };
  return { ok: true, doc: (input.doc as string | undefined) ?? null, base: input.base, text: hasText ? (input.text as string) : null, restore: hasRestore ? (input.restore as number) : null };
}

/** The body of `POST /api/plans/:id/approve`: the version the person is looking at (`doc` absent: the primary one). */
export function checkPlanApproveInput(input: unknown): { ok: true; doc: string | null; version: number } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "the body is { doc?, version }" };
  const unknown = Object.keys(input).find((key) => !["doc", "version", "serverSession"].includes(key));
  if (unknown) return { ok: false, error: `unknown field ${unknown}` };
  if (input.doc !== undefined && !isPlanId("doc", input.doc)) return { ok: false, error: "doc is a document id (doc_…)" };
  if (!isPlanVersionNumber(input.version)) return { ok: false, error: "version is the version number on screen" };
  return { ok: true, doc: (input.doc as string | undefined) ?? null, version: input.version };
}

/**
 * The body of `POST /api/plans/:id/sent`: a Send from the plan page went out (New message's first thread, or a reply
 * in the plan's thread), so its comments are sent and the plan has that thread.
 */
export function checkPlanSentInput(input: unknown): { ok: true; thread_id: string | null; message_id: string; to: { host: string; session: string } | null; comments: string[]; told: { doc: string; version: number } | null } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "the body is { thread_id, message_id, to?, comments, told? }" };
  const unknown = Object.keys(input).find((key) => !["thread_id", "message_id", "to", "comments", "told", "serverSession"].includes(key));
  if (unknown) return { ok: false, error: `unknown field ${unknown}` };
  const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(value);
  // null: a Send held for another machine went, and its thread is that machine's (not known here).
  if (input.thread_id !== null && !id(input.thread_id)) return { ok: false, error: "thread_id: the Inbox thread's id, or null" };
  if (!id(input.message_id)) return { ok: false, error: "message_id: the message that carried it" };
  const told = input.told;
  if (told !== undefined && told !== null && !(isObject(told) && isPlanId("doc", told.doc) && isPlanVersionNumber(told.version))) return { ok: false, error: "told: { doc, version }, the version a Direct Edits section carried" };
  const to = input.to;
  if (to !== undefined && to !== null && !(isObject(to) && typeof to.host === "string" && typeof to.session === "string")) return { ok: false, error: "to: { host, session }" };
  if (!Array.isArray(input.comments) || input.comments.length > 1000 || !input.comments.every(isPlanAnnotationId)) return { ok: false, error: "comments: the annotation ids sent" };
  return { ok: true, thread_id: (input.thread_id as string | null) ?? null, message_id: input.message_id as string, to: to ? { host: (to as { host: string }).host, session: (to as { session: string }).session } : null, comments: input.comments as string[], told: told ? { doc: (told as { doc: string }).doc, version: (told as { version: number }).version } : null };
}

// ─────────────────────────────── Approvals ───────────────────────────────
//
// Approval "plans-editing": an approval belongs to the version it was given on, the current one only. A new version
// clears it (the plan record keeps `last_approval_cleared`), except the person's own edit, as its only author, of the
// version they approved: their approval moves to the new version (`last_approval_moved`, and a decision on the new
// version with `moved_from`). Decided by the store from the version's authors; a Restore or an agent's version clears.

/** The person on this computer, as an approval names them: the Inbox keeps no person's name ("You" on screen). */
export const PLAN_PERSON = "person";

export interface PlanApprovalCleared {
  document_id: string;
  cleared_at: string;
  /** The new version, which holds no approval. */
  version_number: number;
  /** The version the approvals were on. */
  from_version_number: number;
  /** Who had approved it (`PLAN_PERSON`: the person on this computer). */
  approver_names: string[];
}

export interface PlanApprovalMoved {
  document_id: string;
  moved_at: string;
  version_number: number;
  from_version_number: number;
  /** Whose approval moved (`PLAN_PERSON`: the person on this computer). */
  name: string;
}

export const isPlanApproval = (decision: PlanDecisionKind | null | undefined) => decision === "approved" || decision === "approved-with-notes";

/**
 * The version a decision is on: its own, else (an imported decision whose version was never found) the first, so a
 * past approval stays in view as history (approval "plans-editing").
 */
export const planDecisionVersion = (decision: Pick<PlanDecision, "version_number">): number => decision.version_number ?? 1;

/** Who a decision is by: its recorded name, else the person on this computer. */
export const planApproverName = (actor: Pick<PlanActor, "author_label">) => actor.author_label?.trim() || PLAN_PERSON;

/** The approvals version `n` of a document holds: each approver's newest decision on it, when that one approves. */
export function planApprovalsOn(events: readonly PlanEvent[], docId: string, n: number): { name: string; event: PlanEvent }[] {
  const newest = new Map<string, PlanEvent>();
  const ordered = events.filter((e) => e.kind === "decision" && e.decision?.document_id === docId && planDecisionVersion(e.decision) === n).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const event of ordered) newest.set(planApproverName(event), event);
  return [...newest].filter(([, event]) => isPlanApproval(event.decision!.decision)).map(([name, event]) => ({ name, event }));
}

/** Where a document's approval stands on its newest version (`head`), for every place that shows it. */
export type PlanApprovalState =
  | { kind: "approved"; version_number: number; names: string[]; notes: boolean; moved: PlanApprovalMoved | null }
  | { kind: "changes"; version_number: number }
  | { kind: "cleared"; version_number: number; from_version_number: number; names: string[] }
  | { kind: "undecided"; version_number: number; from_version_number: number }
  | { kind: "none" };

export function planApprovalState(events: readonly PlanEvent[], docId: string, head: number, facts: { cleared?: PlanApprovalCleared | null; moved?: PlanApprovalMoved | null } = {}): PlanApprovalState {
  if (head < 1) return { kind: "none" };
  const approvals = planApprovalsOn(events, docId, head);
  if (approvals.length > 0) {
    const moved = facts.moved && facts.moved.document_id === docId && facts.moved.version_number === head ? facts.moved : null;
    return { kind: "approved", version_number: head, names: approvals.map((a) => a.name), notes: approvals.some((a) => a.event.decision!.decision === "approved-with-notes"), moved };
  }
  const decided = events.filter((e) => e.kind === "decision" && e.decision?.document_id === docId);
  if (decided.some((e) => planDecisionVersion(e.decision!) === head)) return { kind: "changes", version_number: head };
  const cleared = facts.cleared;
  if (cleared && cleared.document_id === docId && cleared.version_number === head && cleared.approver_names.length > 0) {
    return { kind: "cleared", version_number: head, from_version_number: cleared.from_version_number, names: cleared.approver_names };
  }
  // No fact (history imported before facts were kept, or versions since): the newest older version with a decision.
  const older = Math.max(0, ...decided.map((e) => planDecisionVersion(e.decision!)).filter((n) => n < head));
  if (older === 0) return { kind: "none" };
  const held = planApprovalsOn(events, docId, older);
  return held.length > 0 ? { kind: "cleared", version_number: head, from_version_number: older, names: held.map((a) => a.name) } : { kind: "undecided", version_number: head, from_version_number: older };
}

const PLAN_KIND_EXTENSION: Record<PlanDocumentKind, string> = { markdown: "md", html: "html", mermaid: "mmd", graphviz: "dot", image: "png", data: "csv" };

/** A page's file name: the last part of its `doc_path`, else its title with its kind's extension ("Rollout.md"). */
export function planDocumentFileName(doc: Pick<PlanDocument, "doc_path" | "title" | "kind">): string {
  return doc.doc_path?.split("/").pop() || `${doc.title || "Plan"}.${PLAN_KIND_EXTENSION[doc.kind] ?? "md"}`;
}

/** Text compared as a person sees it: `\r\n` and a lone `\r` read as `\n` (an editor gives back `\n`). */
export const planTextLines = (text: string): string => text.replace(/\r\n?/g, "\n");

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
