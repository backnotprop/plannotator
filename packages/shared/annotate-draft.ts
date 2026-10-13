/**
 * Annotate draft storage keyed by the file's PATH as well as its content.
 *
 * Annotate drafts have always been keyed by a hash of the document text, so
 * when an agent edited the file and the review was reopened, the reviewer's
 * unsent comments were unreachable. This module applies the #1590 pattern
 * (review-draft.ts) to annotate sessions:
 *
 *  - Single local file: the draft is ALSO stored under a stable path key
 *    (`annotateFileDraftKey`). Load prefers the content key unless the path
 *    copy is strictly newer by `draftGeneration`; the path copy remembers every
 *    content key it was saved on, so a delete reaches all of them; the path
 *    key's tombstone guards both keys. All of that is review-draft.ts's dual
 *    key logic, reused verbatim with the content key as the "patch" key.
 *  - Per-document copies: every document a session holds comments on other
 *    than its own root (a folder session's files, a single-file session's
 *    linked documents) is saved under that document's path key, so opening the
 *    file in any later session (alone or in a folder) finds the comments.
 *    These writes come from a session that does not own the key's generation
 *    counter, so the SERVER stamps them one above the highest generation the
 *    key knows. That keeps the key monotonic for a single-file session that
 *    later resumes from it.
 *  - A decision (`settle`) clears the session's own keys plus the path key of
 *    every document it covered. After that, document writes are refused.
 *
 * Generations and the `patchKey` / `patchKeys` stamps are server-side: a
 * client cannot forge them (saveReviewDraft strips them from every body, and
 * document writes never read them from the client).
 *
 * Runtime-agnostic: node:fs via draft.ts only. Vendored to Pi.
 */

import { realpathSync, statSync } from "fs";
import { isAbsolute, resolve as resolvePath } from "path";
import { contentHash, deleteDraft, getDraftGeneration, loadDraft, saveDraft } from "./draft";
import {
  deleteReviewDraft,
  loadReviewDraft,
  reviewDraftState,
  saveReviewDraft,
  type ReviewDraftKeys,
  type ReviewDraftLoadResult,
  type ReviewDraftState,
} from "./review-draft";

/** Stable draft key for a local file, by absolute path. */
export function annotateFileDraftKey(absolutePath: string): string {
  return `file-${contentHash(`v1|file|${absolutePath}`)}`;
}

/** Most documents one write may carry. */
export const MAX_DRAFT_DOCUMENTS_PER_WRITE = 500;

export interface AnnotateDraftSessionOptions {
  /** The session's historical draft key (content hash, or the folder/live identity hash). */
  contentKey: string;
  /** Absolute path of the single local file under review; null for every other session kind. */
  filePath?: string | null;
  /**
   * Per-document copies. `isAllowed` decides which absolute paths this
   * session may read or write a document copy for (the paths its /api/doc may
   * serve). Absent: the session has no document copies.
   */
  documents?: {
    isAllowed: (absolutePath: string) => boolean;
  } | null;
}

export type DocumentDraftResult =
  | { status: 200; body: { found: true; annotations: unknown[]; globalAttachments: unknown[] } }
  | { status: 200; body: { ok: true; written: number; rejected?: string[] } }
  | { status: 400 | 403 | 404 | 409; body: { found?: false; ok?: false; error: string } };

interface DocumentWrite {
  path: string;
  annotations: unknown[];
  globalAttachments: unknown[];
}

function generationOf(value: unknown): number | null {
  const g = (value as { draftGeneration?: unknown } | null)?.draftGeneration;
  return typeof g === "number" && Number.isInteger(g) && g >= 0 ? g : null;
}

/** Fields a document write owns; everything else on a stored copy is kept. */
const DOCUMENT_OWNED_FIELDS = new Set(["annotations", "globalAttachments", "draftGeneration", "ts", "patchKey"]);
/** Fields that are bookkeeping, not reviewer content. */
const BOOKKEEPING_FIELDS = new Set(["patchKeys"]);

function hasOtherContent(stored: Record<string, unknown>): boolean {
  return Object.keys(stored).some((k) => !DOCUMENT_OWNED_FIELDS.has(k) && !BOOKKEEPING_FIELDS.has(k));
}

function parseDocumentWrites(body: unknown): DocumentWrite[] | string {
  const list = (body as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(list)) return "documents must be an array";
  if (list.length > MAX_DRAFT_DOCUMENTS_PER_WRITE) return `at most ${MAX_DRAFT_DOCUMENTS_PER_WRITE} documents per write`;
  const writes: DocumentWrite[] = [];
  for (const entry of list) {
    const e = entry as { path?: unknown; annotations?: unknown; globalAttachments?: unknown } | null;
    if (!e || typeof e.path !== "string" || !Array.isArray(e.annotations)) {
      return "each document needs a string path and an annotations array";
    }
    if (e.globalAttachments !== undefined && !Array.isArray(e.globalAttachments)) {
      return "globalAttachments must be an array";
    }
    writes.push({ path: e.path, annotations: e.annotations, globalAttachments: (e.globalAttachments as unknown[] | undefined) ?? [] });
  }
  return writes;
}

/**
 * One annotate server's draft bookkeeping. Every call is synchronous file
 * I/O through draft.ts; HTTP shaping is left to the two runtimes.
 */
export function createAnnotateDraftSession(options: AnnotateDraftSessionOptions) {
  const keys: ReviewDraftKeys = {
    patchKey: options.contentKey,
    targetKey: options.filePath ? annotateFileDraftKey(options.filePath) : null,
  };
  const rootPath = options.filePath ?? null;
  const documents = options.documents ?? null;
  /** Absolute paths whose document copy this session wrote or restored from. */
  const coveredDocuments = new Set<string>();
  /** The reviewer decided (feedback, approve, Close): saves are refused. */
  let settled = false;
  /** The agent closed the session: the draft is kept and may still grow. */
  let agentClosed = false;

  const resolveDocumentPath = (raw: unknown): { path: string } | { status: 400 | 403; error: string } => {
    if (typeof raw !== "string" || raw.length === 0) return { status: 400, error: "Missing path" };
    const path = canonicalDocumentPath(raw);
    if (!path) return { status: 400, error: "Not an existing file" };
    // The root file's own path key is the session draft itself (one writer).
    if (rootPath && path === rootPath) return { status: 403, error: "The session's own file is saved with the session draft" };
    if (!documents?.isAllowed(path)) return { status: 403, error: "Path not allowed" };
    return { path };
  };

  const clearDocumentCopy = (path: string) => {
    const key = annotateFileDraftKey(path);
    const known = getDraftGeneration(key);
    deleteDraft(key, known ?? undefined);
  };

  return {
    /** Whether this session advertises per-document copies to the client. */
    documentsEnabled: documents !== null,

    load(): ReviewDraftLoadResult {
      const result = loadReviewDraft(keys);
      if (!result.found) return result;
      // `patchChanged` is review vocabulary; an annotate client re-anchors
      // every comment by text on restore whatever the flag says.
      const { patchChanged: _changed, ...draft } = result.draft;
      return { found: true, draft };
    },

    /** Returns false when the save was rejected (decided, stale generation, tombstone). */
    save(body: object): boolean {
      if (settled) return false;
      return saveReviewDraft(keys, body);
    },

    /**
     * POST /api/draft, shaped for both runtimes.
     *  - After a decision every save is refused with `409 { decided: true }`,
     *    whatever its generation: a second tab must not put back comments
     *    that were just sent. The client never retries a decided refusal.
     *  - With a path copy in use a stale save is reported as
     *    `409 { error, found, draftGeneration }` (the #1590 shape) and the
     *    client saves again above `draftGeneration`.
     *  - Otherwise the historical always-ok answer.
     */
    saveRequest(body: object): { status: 200 | 409; body: Record<string, unknown> } {
      if (settled) {
        return { status: 409, body: { ok: false, decided: true, error: "The review is already decided", ...reviewDraftState(keys) } };
      }
      const saved = saveReviewDraft(keys, body);
      if (!saved && keys.targetKey !== null) {
        return { status: 409, body: { ok: false, error: "stale draft generation", ...reviewDraftState(keys) } };
      }
      return { status: 200, body: { ok: true } };
    },

    state(): ReviewDraftState {
      return reviewDraftState(keys);
    },

    /**
     * The client cleared the draft on screen (everything removed, or
     * dismissed). A no-op once the review is decided or closed by the agent:
     * a closed tab must not delete the draft the agent close kept.
     */
    remove(draftGeneration?: number): void {
      if (settled || agentClosed) return;
      deleteReviewDraft(keys, draftGeneration);
    },

    /**
     * The reviewer's decision (feedback, approve, Close): clear the session's
     * keys and every document copy it covered, then refuse further saves and
     * document writes.
     */
    settle(draftGeneration?: number): void {
      deleteReviewDraft(keys, draftGeneration);
      for (const path of coveredDocuments) clearDocumentCopy(path);
      coveredDocuments.clear();
      settled = true;
    },

    /**
     * The agent closed the session (`POST /api/host/close`, closedBy
     * "agent"): NOTHING is deleted. The reviewer's unsent comments stay in
     * the session draft, its path copy and the document copies, and come back
     * when the file is reopened. Saves and document writes are still
     * accepted, so a comment typed just before the close (its debounced save
     * arriving after it) completes the kept draft; only a DELETE from the
     * closed tab is ignored, so it cannot discard what the close kept.
     */
    closeKeepingDraft(): void {
      agentClosed = true;
    },

    /**
     * The reviewer's unsent comments this session holds on disk: the session
     * draft it would restore (content or path copy) plus every document copy
     * it covered. `count` reads one stored draft (host-control's
     * countUnsentDraftComments).
     */
    countUnsent(count: (draft: unknown) => number): number {
      const loaded = loadReviewDraft(keys);
      let total = loaded.found ? count(loaded.draft) : 0;
      for (const path of coveredDocuments) total += count(loadDraft(annotateFileDraftKey(path)));
      return total;
    },

    /** GET one document's copy (`?path=`). */
    loadDocument(rawPath: unknown): DocumentDraftResult {
      if (!documents) return { status: 404, body: { error: "Not available" } };
      const resolved = resolveDocumentPath(rawPath);
      if ("error" in resolved) return { status: resolved.status, body: { error: resolved.error } };
      const stored = loadDraft(annotateFileDraftKey(resolved.path)) as Record<string, unknown> | null;
      const annotations = Array.isArray(stored?.annotations) ? stored.annotations : [];
      const globalAttachments = Array.isArray(stored?.globalAttachments) ? stored.globalAttachments : [];
      if (annotations.length === 0 && globalAttachments.length === 0) {
        return { status: 404, body: { found: false, error: "No draft" } };
      }
      if (!settled) coveredDocuments.add(resolved.path);
      return { status: 200, body: { found: true, annotations, globalAttachments } };
    },

    /** POST `{ documents: [{ path, annotations, globalAttachments? }] }`. */
    saveDocuments(body: unknown): DocumentDraftResult {
      if (!documents) return { status: 404, body: { error: "Not available" } };
      if (settled) return { status: 409, body: { ok: false, error: "The review is already decided" } };
      const writes = parseDocumentWrites(body);
      if (typeof writes === "string") return { status: 400, body: { ok: false, error: writes } };
      // A path this session may not write is skipped and reported; the
      // others are still written, so one odd document never costs the rest.
      const resolvedWrites: DocumentWrite[] = [];
      const rejected: string[] = [];
      for (const write of writes) {
        const resolved = resolveDocumentPath(write.path);
        if ("error" in resolved) rejected.push(write.path);
        else resolvedWrites.push({ ...write, path: resolved.path });
      }

      let written = 0;
      for (const write of resolvedWrites) {
        coveredDocuments.add(write.path);
        const key = annotateFileDraftKey(write.path);
        const stored = loadDraft(key) as Record<string, unknown> | null;
        const empty = write.annotations.length === 0 && write.globalAttachments.length === 0;
        if (
          stored &&
          JSON.stringify(stored.annotations ?? []) === JSON.stringify(write.annotations) &&
          JSON.stringify(stored.globalAttachments ?? []) === JSON.stringify(write.globalAttachments)
        ) {
          continue;
        }
        if (!stored && empty) continue;
        // One above everything the key has seen (copy or tombstone), so the
        // write lands, and a single-file session that later loads this copy
        // resumes its own counter above it.
        const draftGeneration = (getDraftGeneration(key) ?? 0) + 1;
        if (empty && stored && !hasOtherContent(stored)) {
          deleteDraft(key, draftGeneration);
          written++;
          continue;
        }
        // Keep what a single-file session stored beside the comments (direct
        // edits, the content keys it was saved on); drop `patchKey`, which
        // names the text the copy was saved on, unknown to a document write.
        const kept: Record<string, unknown> = {};
        if (stored) {
          for (const [field, value] of Object.entries(stored)) {
            if (!DOCUMENT_OWNED_FIELDS.has(field)) kept[field] = value;
          }
        }
        if (saveDraft(key, {
          ...kept,
          annotations: write.annotations,
          globalAttachments: write.globalAttachments,
          draftGeneration,
          ts: Date.now(),
        })) {
          written++;
        }
      }
      return { status: 200, body: { ok: true, written, ...(rejected.length > 0 ? { rejected } : {}) } };
    },
  };
}

export type AnnotateDraftSession = ReturnType<typeof createAnnotateDraftSession>;

/**
 * The one spelling a document's path key is derived from: absolute, resolved,
 * symlinks followed (so an alias of a file shares its key), and only for an
 * existing regular file. Null for anything else (relative, missing, a
 * directory).
 */
export function canonicalDocumentPath(path: string): string | null {
  if (!path || !isAbsolute(path)) return null;
  try {
    const real = realpathSync(resolvePath(path));
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Whether an annotate session gets path-keyed drafts: a single local file
 * (mode "annotate", not a URL). Folder sessions keep their folder key and get
 * per-document copies instead; URL, live-app and agent-message sessions have
 * no file path. Returns the canonical path (canonicalDocumentPath), or the
 * resolved spelling when the file cannot be canonicalized (gone since the
 * CLI read it).
 */
export function annotateDraftFilePath(input: { mode: string; filePath: string }): string | null {
  if (input.mode !== "annotate") return null;
  if (!input.filePath || /^https?:\/\//i.test(input.filePath)) return null;
  const resolved = resolvePath(input.filePath);
  return canonicalDocumentPath(resolved) ?? resolved;
}
