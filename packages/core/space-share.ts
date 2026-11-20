/**
 * Share this space: what a plan's copy in a hosted space is made of (browser-safe: types, limits, path rules and the
 * plan of calls; no I/O). The calls themselves are packages/shared/spaces/ (client.ts, engine.ts); the routes are the
 * Inbox's (packages/server/plans-capability.ts); the screen is packages/inbox/plans/PlanShare.tsx.
 *
 * A share is a list of steps, each one call: create the space (with the main page's first version), each further
 * version of each page by a save on top of the one before, each file, each comment not yet sent to the agent, and the
 * person's approval last. What went up is kept beside the plan (`SpaceShareRecord`, `<pln_id>/share.json`), so a
 * later Update plans only what is new, and a run that stopped midway goes on from the step after the last one kept.
 */
import type { PlanArtifact, PlanComment, PlanDocumentKind } from "./plans";
import { ulid } from "./ulid";

// ─────────────────────────────── What a hosted space takes ───────────────────────────────

/** The page kinds a hosted space has. A picture or a table is a file there, never a page. */
export const SPACE_PAGE_KINDS = ["markdown", "html", "mermaid", "graphviz"] as const;
export type SpacePageKind = (typeof SPACE_PAGE_KINDS)[number];
export const isSpacePageKind = (kind: PlanDocumentKind): kind is SpacePageKind => (SPACE_PAGE_KINDS as readonly string[]).includes(kind);

/** A Markdown or diagram page, in bytes. */
export const SPACE_TEXT_MAX = 1_572_864;
/** An HTML page, in bytes. */
export const SPACE_HTML_MAX = 16_000_000;
/** One file, in bytes. */
export const SPACE_FILE_MAX = 104_857_600;
/** Every file of a space nobody kept, in bytes. */
export const SPACE_OPEN_FILES_MAX = 104_857_600;
/** A comment's words, and its anchor as JSON, in bytes. */
export const SPACE_COMMENT_BODY_MAX = 8 * 1024;
export const SPACE_COMMENT_ANCHOR_MAX = 16 * 1024;
export const SPACE_NAME_MAX = 120;

export const spacePageMax = (kind: SpacePageKind) => (kind === "html" ? SPACE_HTML_MAX : SPACE_TEXT_MAX);

const PAGE_EXTENSION: Record<SpacePageKind, string> = { markdown: "md", html: "html", mermaid: "mmd", graphviz: "dot" };
const KIND_OF_EXTENSION: Record<string, SpacePageKind> = { md: "markdown", markdown: "markdown", html: "html", htm: "html", mmd: "mermaid", mermaid: "mermaid", dot: "graphviz", gv: "graphviz" };

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** The page kind a path's extension names (a hosted space takes such a path only as a page), or null: a file. */
export const spacePageKindOfPath = (path: string): SpacePageKind | null => KIND_OF_EXTENSION[extensionOf(path)] ?? null;

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * A path a hosted space takes, for a page or a file: `/`-separated names, no empty, `.`, `..` or `.git` name, no
 * control character, none of `\ ? # %`, each name at most 255 bytes.
 */
export function isSpacePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/[\\?#%\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((name) => name.length > 0 && name !== "." && name !== ".." && name.toLowerCase() !== ".git" && utf8Length(name) <= 255);
}

const foldPath = (path: string) => path.normalize("NFC").toLowerCase();

/**
 * The path a page goes up at: its own `doc_path` when a hosted space takes it for that kind, else its title as a file
 * name with the kind's extension; never one already `taken` (compared as a disk that folds case would).
 */
export function spacePagePath(doc: { doc_path: string | null; title: string }, extension: string, kind: SpacePageKind | null, taken: ReadonlySet<string>): string {
  const own = doc.doc_path;
  if (own && isSpacePath(own) && (kind ? spacePageKindOfPath(own) === kind : spacePageKindOfPath(own) === null) && !taken.has(foldPath(own))) return own;
  const words = (doc.title || "")
    .replace(/[\\/?#%<>:"|*\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  const base = words || "plan";
  for (let n = 1; ; n++) {
    const path = `${n === 1 ? base : `${base} ${n}`}.${extension}`;
    if (!taken.has(foldPath(path))) return path;
  }
}

/**
 * The path a file goes up at: its own when a hosted space takes it, else the same with what it refuses (`#`, `%`,
 * `?`, an over-long name) written as `-` or cut, never one already `taken`. The file keeps its name on this computer.
 */
export function spaceFilePath(assetPath: string, taken: ReadonlySet<string>): string {
  if (isSpacePath(assetPath) && !taken.has(foldPath(assetPath))) return assetPath;
  const names = assetPath.split("/").map((name) => {
    let safe = name.replace(/[\\?#%\u0000-\u001f\u007f]+/g, "-");
    if (safe === "." || safe === ".." || safe.toLowerCase() === ".git") safe = `-${safe.slice(1)}`;
    while (utf8Length(safe) > 255) safe = safe.slice(1);
    return safe || "-";
  });
  const last = names.pop()!;
  const dot = last.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [last.slice(0, dot), last.slice(dot)] : [last, ""];
  for (let n = 1; ; n++) {
    const path = [...names, `${n === 1 ? stem : `${stem} ${n}`}${extension}`].join("/");
    if (!taken.has(foldPath(path))) return path;
  }
}

/** A hosted space's id, made here so a create tried twice is one space. */
export const newSpaceId = (now?: number): string => `ws_${ulid(now)}`;
export const isSpaceId = (value: unknown): value is string => typeof value === "string" && /^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);

// ─────────────────────────────── The record of what went up ───────────────────────────────

export type SpaceShareMode = "all" | "newest";

/** One version that went up: its number here, the version the space answered with, and the hash of what was sent. */
export interface SpaceSharePushed {
  local: number;
  remote: string;
  hash: string;
}

export interface SpaceSharePage {
  /** `page`: a page of the space. `file`: a picture or a table, kept there as a file. */
  lane: "page" | "file";
  /** The hosted page's (or file's) id; null until the call that makes it answered. */
  remote_id: string | null;
  doc_path: string;
  /** The page's address, as the space last returned it (`file_url`), when it did. */
  url?: string | null;
  pushed: SpaceSharePushed[];
  /** The page changed in the space since the last push: it is left alone. `current`: the version the space holds. */
  stopped: { current: string | null } | null;
}

export interface SpaceShareFile {
  /** The path it has in the space, when that is not its path here (a name the space does not take). */
  remote_path?: string;
  remote_id: string | null;
  /** SHA-256 of the bytes that went up. */
  content_hash: string;
  /** A file with a page's extension goes up as a page: the version the space answered with. */
  page_version?: string;
}

export interface SpaceShareRecord {
  v: 1;
  /** The Spaces origin it went to. */
  host: string;
  space_id: string;
  /** The create call as first made (kept so a retry sends the same call): the name, and the page and version in it. */
  name: string;
  seed: { doc: string | null; version: number | null } | null;
  /** The create answered. */
  created: boolean;
  /** The link, exactly as the space returned it. */
  share_url: string | null;
  mode: SpaceShareMode;
  /** The space is the person's own (made signed in, or kept later). */
  kept: boolean;
  /** The share was started signed in: it is never made, or gone on with, without a sign-in. */
  signed?: boolean;
  /** Who can open it, as the space said last (`private`, `link_edit`, …); null when it has not said. */
  visibility?: string | null;
  owner: string | null;
  /** A write was refused after the space had been made here without sign-in: someone else kept it. */
  refused: boolean;
  /** Per local document id. */
  pages: Record<string, SpaceSharePage>;
  /** Per artifact path. */
  files: Record<string, SpaceShareFile>;
  /** Per local comment id (`anno_…`): the hosted comment or reply, or why it stays here. */
  comments: Record<string, { remote_id: string; reply?: true } | { left: string }>;
  approval: { document_id: string; version_number: number } | null;
  /** The space did not take the approval: not asked again, and not shown. */
  approval_refused: boolean;
  /** The first share that finished, and the last run that did. */
  shared_at: string | null;
  updated_at: string;
  /** A run not finished: how many steps it has done, and how it ended (null while it runs, or the Inbox died in it). */
  job: {
    done: number;
    total: number;
    ended: "failed" | "stopped" | "over_limit" | null;
    /** The space was not there for this caller: only a new space can go on. */
    gone?: boolean;
    /** A write was not allowed: the space has an owner now. Keep this space finds out whether it is this person. */
    keep?: boolean;
  } | null;
}

export function newSpaceShareRecord(input: { host: string; space_id: string; name: string; mode: SpaceShareMode; kept: boolean; signed?: boolean; at: string }): SpaceShareRecord {
  return {
    v: 1,
    host: input.host,
    space_id: input.space_id,
    name: input.name.trim().slice(0, SPACE_NAME_MAX) || "Plan",
    seed: null,
    created: false,
    share_url: null,
    mode: input.mode,
    kept: input.kept,
    signed: input.signed === true,
    owner: null,
    refused: false,
    pages: {},
    files: {},
    comments: {},
    approval: null,
    approval_refused: false,
    shared_at: null,
    updated_at: input.at,
    job: null,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A record as read back from disk; anything else is no record (the plan reads as never shared). */
export function isSpaceShareRecord(value: unknown): value is SpaceShareRecord {
  if (!isObject(value)) return false;
  return (
    value.v === 1 &&
    typeof value.host === "string" &&
    isSpaceId(value.space_id) &&
    typeof value.name === "string" &&
    typeof value.created === "boolean" &&
    (value.share_url === null || typeof value.share_url === "string") &&
    (value.mode === "all" || value.mode === "newest") &&
    typeof value.kept === "boolean" &&
    isObject(value.pages) &&
    isObject(value.files) &&
    isObject(value.comments)
  );
}

// ─────────────────────────────── Who wrote it, and when ───────────────────────────────

/** Where a version or a comment came from here: its author's display name, the agent session, and its own time. */
export interface SpaceImported {
  author_label: string | null;
  agent_host: string | null;
  agent_session: string | null;
  agent_name: string | null;
  /** When it was written here (a version's `committed_at`, a comment's `created_at`). */
  at: string;
}

/**
 * The fields a call carries to say where a version or a comment came from. The engine hands every version and
 * comment it sends through here. Today it adds nothing: the hosted side does not take them yet and their names are
 * not final, and an unknown field is refused there. When it does, this is the one place to write them.
 */
export function spaceImportedFields(_origin: SpaceImported | null): Record<string, unknown> {
  return {};
}

/** A comment's origin: the person's display name when one is kept, its agent fields, and when it was made. */
export const spaceImportedOfComment = (comment: PlanComment): SpaceImported => ({ author_label: comment.author_label, agent_host: comment.agent_host, agent_session: comment.agent_session, agent_name: comment.agent_name, at: comment.created_at });

// ─────────────────────────────── The space on this computer ───────────────────────────────

export interface LocalSpaceDocument {
  id: string;
  kind: PlanDocumentKind;
  title: string;
  doc_path: string | null;
  /** A picture or a table page: the extension its file gets (`png`, `svg`, `csv`). */
  file_extension: string | null;
  /** Oldest first. `version`: the git blob SHA of its bytes. */
  versions: { version_number: number; version: string; size: number; imported?: SpaceImported }[];
}

/** What a share reads of a plan: the pages kept (none archived), its files, comments and the person's approval. */
export interface LocalSpace {
  name: string;
  primary_doc_id: string;
  documents: LocalSpaceDocument[];
  artifacts: PlanArtifact[];
  comments: PlanComment[];
  /** The person's approval on the main page's newest version, when it holds one. */
  approval: { document_id: string; version_number: number } | null;
  /** Older versions of the main page that hold an approval. */
  older_approvals: number;
}

export type SpaceShareStep =
  /** Make the space, with `doc`'s version `version` as its first page (`doc` null: an empty space). */
  | { kind: "create"; doc: string | null; version: number | null }
  | { kind: "page-add"; doc: string; version: number }
  | { kind: "page-save"; doc: string; version: number }
  /** A picture or table page, as a file. */
  | { kind: "page-file"; doc: string; version: number }
  | { kind: "file"; path: string }
  /** A file a hosted space takes only as a page (its extension is a page's). */
  | { kind: "file-page"; path: string }
  | { kind: "comment"; id: string }
  | { kind: "reply"; id: string; parent: string }
  | { kind: "approval"; doc: string; version: number };

/** The Details view: what goes up, and what stays on this computer. A row with nothing in it is not shown. */
export interface SpaceShareDetails {
  pages: number;
  files: number;
  comments: number;
  /** The version whose approval goes (or went) up; null: none. */
  approval: number | null;
  not: {
    sent_comments: number;
    pictures: number;
    original_dates: boolean;
    files_over: number;
    pages_over: number;
    long_comments: number;
    older_approvals: number;
  };
}

export interface SpaceSharePlan {
  steps: SpaceShareStep[];
  details: SpaceShareDetails;
  /** Pages, files and comments with something new to send. */
  changes: number;
  /** Every file byte this share holds in the space once done (what a space nobody kept may hold 100 MB of). */
  file_bytes: number;
  /** The path each document goes up at. */
  paths: Record<string, string>;
  /** The path each file (by its path here) goes up at. */
  file_paths: Record<string, string>;
}

const annotationOf = (comment: PlanComment): Record<string, unknown> => (isObject(comment.anchor) ? comment.anchor : {});

/**
 * A comment's anchor as it goes up: where it is and what it says, and nothing about who or when. Left here: its
 * pictures (paths on this computer), the commenter's name and the people it names (a space nobody kept is open to
 * every holder of its link), and when it was made.
 */
export function spaceCommentAnchor(comment: PlanComment): Record<string, unknown> {
  const { images: _images, author: _author, mentions: _mentions, createdA: _createdA, ...rest } = annotationOf(comment);
  return rest;
}

const picturesOf = (comment: PlanComment) => {
  const images = annotationOf(comment).images;
  return Array.isArray(images) ? images.length : 0;
};

/**
 * The calls a share or an Update makes, in order, from the plan as it is and the record of what went up. Pure: the
 * same plan and record give the same steps, so a run that stopped goes on where it was.
 */
export function planSpaceShare(local: LocalSpace, record: SpaceShareRecord | null, options: { mode: SpaceShareMode; signedIn: boolean }): SpaceSharePlan {
  const mode = record?.mode ?? options.mode;
  // Before the space is made, a signed-in share will make it the person's own.
  const kept = record?.created ? record.kept : options.signedIn;
  const steps: SpaceShareStep[] = [];
  const details: SpaceShareDetails = { pages: 0, files: 0, comments: 0, approval: null, not: { sent_comments: 0, pictures: 0, original_dates: false, files_over: 0, pages_over: 0, long_comments: 0, older_approvals: local.older_approvals } };
  const changed = new Set<string>();
  let fileBytes = 0;

  // Paths: a recorded one stays; a file keeps its own path where the space takes it; a new page never takes a
  // file's path or another page's.
  const taken = new Set<string>();
  for (const page of Object.values(record?.pages ?? {})) taken.add(foldPath(page.doc_path));
  const filePaths: Record<string, string> = {};
  for (const artifact of [...local.artifacts].sort((a, b) => Number(isSpacePath(b.asset_path)) - Number(isSpacePath(a.asset_path)))) {
    const path = record?.files[artifact.asset_path]?.remote_path ?? (record?.files[artifact.asset_path] ? artifact.asset_path : spaceFilePath(artifact.asset_path, taken));
    taken.add(foldPath(path));
    filePaths[artifact.asset_path] = path;
  }
  const paths: Record<string, string> = {};
  const docs = [...local.documents].sort((a, b) => Number(b.id === local.primary_doc_id) - Number(a.id === local.primary_doc_id));
  for (const doc of docs) {
    const kind = isSpacePageKind(doc.kind) ? doc.kind : null;
    const path = record?.pages[doc.id]?.doc_path ?? spacePagePath(doc, kind ? PAGE_EXTENSION[kind] : (doc.file_extension ?? "bin"), kind, taken);
    taken.add(foldPath(path));
    paths[doc.id] = path;
  }

  // The versions up, or about to be: a comment goes only with a version the space holds.
  const up = new Map<string, Set<string>>();
  let created = record?.created ?? false;
  const createStep = (doc: string | null, version: number | null) => {
    steps.push({ kind: "create", doc, version });
    created = true;
  };
  let primarySaved = false;

  for (const doc of docs) {
    const kind = isSpacePageKind(doc.kind) ? doc.kind : null;
    const page = record?.pages[doc.id];
    const hashes = new Set<string>((page?.pushed ?? []).map((p) => p.hash));
    up.set(doc.id, hashes);
    const head = doc.versions[doc.versions.length - 1];
    if (!head) continue;
    const pushedMax = Math.max(0, ...(page?.pushed ?? []).map((p) => p.local));
    const fresh = (mode === "all" ? doc.versions : [head]).filter((v) => v.version_number > pushedMax);
    const max = kind ? spacePageMax(kind) : SPACE_FILE_MAX;
    const going = page?.stopped ? [] : fresh.filter((v) => v.size <= max);
    if (fresh.some((v) => v.size > max)) kind ? details.not.pages_over++ : details.not.files_over++;
    if (pushedMax > 0 || going.length > 0) kind ? details.pages++ : details.files++;
    // A file's every kept version counts against what a space may hold.
    if (!kind) fileBytes += doc.versions.filter((v) => going.includes(v) || page?.pushed.some((p) => p.local === v.version_number)).reduce((n, v) => n + v.size, 0);
    let made = !!page?.remote_id;
    for (const v of going) {
      if (kind) {
        if (!created && doc.id === local.primary_doc_id) createStep(doc.id, v.version_number);
        else {
          if (!created) createStep(null, null);
          steps.push({ kind: made ? "page-save" : "page-add", doc: doc.id, version: v.version_number });
        }
        made = true;
        if (doc.id === local.primary_doc_id) primarySaved = true;
      } else {
        if (!created) createStep(null, null);
        steps.push({ kind: "page-file", doc: doc.id, version: v.version_number });
      }
      hashes.add(v.version);
      changed.add(`doc:${doc.id}`);
    }
    if (pushedMax > 0 || going.length > 0) details.not.original_dates = true;
  }

  for (const artifact of local.artifacts) {
    const asPage = spacePageKindOfPath(artifact.asset_path);
    const over = artifact.size > (asPage ? spacePageMax(asPage) : SPACE_FILE_MAX);
    if (over) {
      asPage ? details.not.pages_over++ : details.not.files_over++;
      continue;
    }
    details.files++;
    if (!asPage) fileBytes += artifact.size;
    if (record?.files[artifact.asset_path]?.content_hash === artifact.content_hash) continue;
    if (!created) createStep(null, null);
    steps.push({ kind: asPage ? "file-page" : "file", path: artifact.asset_path });
    changed.add(`file:${artifact.asset_path}`);
  }

  // Comments: only the ones not sent to the agent; a reply after the comment it answers.
  const byAnnotation = new Map<string, PlanComment>();
  for (const comment of local.comments) {
    const id = annotationOf(comment).id;
    if (typeof id === "string") byAnnotation.set(id, comment);
  }
  const going = new Set<string>();
  const ordered = [...local.comments].sort((a, b) => Number(typeof annotationOf(a).inReplyTo === "string") - Number(typeof annotationOf(b).inReplyTo === "string") || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const comment of ordered) {
    if (comment.sent) {
      details.not.sent_comments++;
      continue;
    }
    const target = comment.target;
    if (target.kind !== "document") continue;
    const page = record?.pages[target.document_id];
    const doc = local.documents.find((d) => d.id === target.document_id);
    if (!doc || !isSpacePageKind(doc.kind) || page?.lane === "file") continue;
    if (!up.get(doc.id)?.has(target.document_version)) continue;
    const known = record?.comments[comment.id];
    if (known && "left" in known) continue;
    if (utf8Length(comment.body) > SPACE_COMMENT_BODY_MAX || utf8Length(JSON.stringify(spaceCommentAnchor(comment))) > SPACE_COMMENT_ANCHOR_MAX) {
      details.not.long_comments++;
      continue;
    }
    const replyTo = annotationOf(comment).inReplyTo;
    const parent = typeof replyTo === "string" ? byAnnotation.get(replyTo) : null;
    // A reply goes only under a comment that is in the space too.
    if (typeof replyTo === "string" && !(parent && going.has(parent.id))) continue;
    going.add(comment.id);
    details.comments++;
    details.not.pictures += picturesOf(comment);
    if (known) continue;
    steps.push(parent ? { kind: "reply", id: comment.id, parent: parent.id } : { kind: "comment", id: comment.id });
    changed.add(`comment:${comment.id}`);
  }

  // The approval last (a save clears it there), and only into a space that is the person's own.
  const approval = local.approval;
  const primary = local.documents.find((d) => d.id === local.primary_doc_id);
  if (approval && primary && isSpacePageKind(primary.kind) && !record?.approval_refused) {
    const head = primary.versions.find((v) => v.version_number === approval.version_number);
    // Listed in Details only where it goes: never for a space nobody kept.
    if (kept && head && up.get(primary.id)?.has(head.version) && !record?.pages[primary.id]?.stopped) {
      details.approval = approval.version_number;
      const there = record?.approval?.document_id === approval.document_id && record.approval.version_number === approval.version_number && !primarySaved;
      if (!there) steps.push({ kind: "approval", doc: approval.document_id, version: approval.version_number });
    }
  }

  return { steps, details, changes: changed.size, file_bytes: fileBytes, paths, file_paths: filePaths };
}

// ─────────────────────────────── What the page is told ───────────────────────────────

/**
 * `GET /api/plans/:id/share`: where a plan's share stands. Never a credential: `signed_in` and `who` are all the
 * page learns of the sign-in.
 */
export interface SpaceShareStatus {
  /**
   * `none`: never shared. `sharing`: a run is going. `shared`: up. `failed`: the last run did not finish. `stopped`:
   * the person stopped it. `over_limit`: more than a space nobody kept may hold. `refused`: someone else kept it.
   * `gone`: the space is no longer there for this computer.
   */
  phase: "none" | "sharing" | "shared" | "failed" | "stopped" | "over_limit" | "refused" | "gone";
  /** Steps done of all, while a run is going or after one that did not finish. */
  progress: { done: number; total: number } | null;
  /** The space asked to wait: the seconds left. */
  waiting: number | null;
  /** The link, once the space answered with one. */
  link: string | null;
  /** A share of this plan finished at least once. */
  shared_once: boolean;
  kept: boolean;
  /**
   * What the access line says, as is true of the space: `edit` (nobody kept it: anyone with the link can edit),
   * `comment` (kept after it was shared: holders of the link still read and comment) or `private` (made signed in:
   * only the person).
   */
  access: "edit" | "comment" | "private";
  signed_in: boolean;
  /** The signed-in person's name, when the space told it. */
  who: string | null;
  /** `waiting`: the browser is open for the sign-in. `remote`: this Inbox runs where no browser can come back to. */
  keep: "waiting" | "remote" | null;
  mode: SpaceShareMode;
  /** The most versions any page has: the switch shows only above 1. */
  versions: number;
  /** Pages, files and comments new since the last share. */
  changes: number;
  /** Pages left alone because they changed in the space, each with its address there (the link and its path). */
  stopped_pages: { title: string; url?: string | null }[];
  /** The claim is going: Keep waits for it. */
  busy?: boolean;
  /**
   * Nothing more goes up until the person signs in and keeps the space: a write was not allowed (the space has an
   * owner, perhaps this person from elsewhere), or the space is theirs and the sign-in is gone from this computer.
   * Keep this space is offered; Update waits for it.
   */
  needs_keep?: boolean;
  details: Record<SpaceShareMode, SpaceShareDetails>;
}

/** What the top bar's button reads, and whether it carries a mark. */
export function spaceShareButton(status: SpaceShareStatus | null): { label: "Share" | "Sharing" | "Shared" | "Update"; state: "idle" | "busy" | "shared" | "update" | "look" | "failed" } {
  if (!status || status.phase === "none") return { label: "Share", state: "idle" };
  if (status.phase === "sharing") return { label: "Sharing", state: "busy" };
  // Waiting for Keep, a stopped page, or someone else's by now: it needs a look, and never reads Update.
  if (status.phase === "refused" || status.stopped_pages.length > 0 || (status.phase === "shared" && status.needs_keep)) return { label: "Shared", state: "look" };
  if (status.phase === "failed" || status.phase === "stopped" || status.phase === "over_limit" || status.phase === "gone") return status.shared_once ? { label: "Shared", state: "look" } : { label: "Share", state: "failed" };
  if (status.changes > 0) return { label: "Update", state: "update" };
  return { label: "Shared", state: "shared" };
}
