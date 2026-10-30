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
 *    linked documents, a plan's linked documents) is saved under that
 *    document's path key, so opening the file in any later session (alone or
 *    in a folder) finds the comments. These writes come from a session that
 *    does not own the key's generation counter, so the SERVER stamps them one
 *    above the highest generation the key knows. That keeps the key monotonic
 *    for a single-file session that later resumes from it.
 *  - Sessions whose root has no file (plan review, an annotate session on a
 *    URL or on the last message) also keep a durable index of the copies they
 *    hold (`documentDraftIndexKey`), and their session draft load offers every
 *    listed document's comments by path (#1545). Draft Recovered then brings
 *    back every document's comments, each on its own document.
 *  - A decision (`settle`) clears the session's own keys plus the path key of
 *    every document it covered or lists and may serve. After that, document
 *    writes are refused. The index key comes from the root's text alone, so
 *    an entry another project listed under the same text is kept.
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

/**
 * Durable list of the document copies one session draft holds, keyed by the
 * session draft's key (see DocumentDraftStoreOptions.indexKey).
 */
export function documentDraftIndexKey(sessionKey: string): string {
  return `docs-${contentHash(`v1|docs|${sessionKey}`)}`;
}

/** Most documents one write may carry. */
export const MAX_DRAFT_DOCUMENTS_PER_WRITE = 500;

/** Most documents one index remembers (oldest dropped first). */
const MAX_INDEXED_DOCUMENTS = MAX_DRAFT_DOCUMENTS_PER_WRITE;

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
    /**
     * The session's root has no file of its own (a URL, the last message):
     * keep an index so the session draft offers every document's comments
     * (see DocumentDraftStoreOptions.indexKey).
     */
    indexed?: boolean;
  } | null;
}

export type DocumentDraftResult =
  | { status: 200; body: { found: true; annotations: unknown[]; globalAttachments: unknown[] } }
  | { status: 200; body: { ok: true; written: number; rejected?: string[] } }
  | { status: 400 | 403 | 404 | 409; body: { found?: false; ok?: false; error: string } };

/** One document's saved comments, as a session draft load offers them. */
export interface OfferedDocumentDraft {
  /** The path as the client named it when it saved or read the copy. */
  path: string;
  annotations: unknown[];
  globalAttachments: unknown[];
}

interface DocumentWrite {
  path: string;
  annotations: unknown[];
  globalAttachments: unknown[];
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

export interface DocumentDraftStoreOptions {
  /** Which absolute paths this session may read or write a copy for (the paths its /api/doc may serve). */
  isAllowed: (absolutePath: string) => boolean;
  /** A single-file session's own file: refused, the session draft carries it. */
  rootPath?: string | null;
  /**
   * A session whose root document has no file of its own (plan review, an
   * annotate session on a URL or on the last message) keeps a durable list of
   * the copies it holds under this key (`documentDraftIndexKey` of its session
   * draft key). Its session draft load then offers every listed document's
   * comments (Draft Recovered), attributed by path, so they come back on a
   * reload without each document being opened first, and reach the feedback.
   */
  indexKey?: string | null;
}

/**
 * Per-document draft copies (`/api/draft/document`): every document a session
 * holds comments on other than its own root is saved under that document's
 * path key. Shared by the annotate session below and the plan review servers.
 */
export function createDocumentDraftStore(options: DocumentDraftStoreOptions) {
  const rootPath = options.rootPath ?? null;
  const indexKey = options.indexKey ?? null;
  /** Absolute paths whose document copy this session wrote or restored from. */
  const coveredDocuments = new Set<string>();
  /** The reviewer decided: document writes are refused. */
  let settled = false;

  const resolveDocumentPath = (raw: unknown): { path: string } | { status: 400 | 403; error: string } => {
    if (typeof raw !== "string" || raw.length === 0) return { status: 400, error: "Missing path" };
    const path = canonicalDocumentPath(raw);
    if (!path) return { status: 400, error: "Not an existing file" };
    // The root file's own path key is the session draft itself (one writer).
    if (rootPath && path === rootPath) return { status: 403, error: "The session's own file is saved with the session draft" };
    if (!options.isAllowed(path)) return { status: 403, error: "Path not allowed" };
    return { path };
  };

  /**
   * Whether an index entry is one this session may serve. The index key comes
   * from the root's text alone, so two sessions on the same text in different
   * projects (worktrees running one plan) share an index: an entry the other
   * session listed is not this session's to offer, count or clear.
   */
  const servable = (canonical: string): boolean =>
    canonicalDocumentPath(canonical) === canonical &&
    !(rootPath && canonical === rootPath) &&
    options.isAllowed(canonical);

  const clearDocumentCopy = (path: string) => {
    const key = annotateFileDraftKey(path);
    const known = getDraftGeneration(key);
    deleteDraft(key, known ?? undefined);
  };

  /** The index: canonical path -> the client's spelling of it, oldest first. */
  const readIndex = (): Map<string, string> => {
    const index = new Map<string, string>();
    if (!indexKey) return index;
    const stored = loadDraft(indexKey) as { documents?: unknown } | null;
    const list = Array.isArray(stored?.documents) ? stored.documents : [];
    for (const entry of list) {
      const e = entry as { path?: unknown; canonical?: unknown } | null;
      if (e && typeof e.path === "string" && typeof e.canonical === "string") index.set(e.canonical, e.path);
    }
    return index;
  };

  const writeIndex = (index: Map<string, string>) => {
    if (!indexKey) return;
    if (index.size === 0) {
      deleteDraft(indexKey);
      return;
    }
    const documents = [...index].slice(-MAX_INDEXED_DOCUMENTS).map(([canonical, path]) => ({ canonical, path }));
    saveDraft(indexKey, { documents, ts: Date.now() });
  };

  const listed = (index: Map<string, string>, canonical: string, clientPath: string) => {
    index.delete(canonical);
    index.set(canonical, clientPath);
  };

  const storedContent = (path: string): { annotations: unknown[]; globalAttachments: unknown[]; ts: number } | null => {
    const stored = loadDraft(annotateFileDraftKey(path)) as Record<string, unknown> | null;
    const annotations = Array.isArray(stored?.annotations) ? stored.annotations : [];
    const globalAttachments = Array.isArray(stored?.globalAttachments) ? stored.globalAttachments : [];
    if (annotations.length === 0 && globalAttachments.length === 0) return null;
    return { annotations, globalAttachments, ts: typeof stored?.ts === "number" ? stored.ts : 0 };
  };

  return {
    /** Whether this store keeps an index (and so offers its documents on load). */
    indexed: indexKey !== null,

    /**
     * Every listed document that still has comments, and the newest save time
     * among them. Each one offered is covered: a decision clears it. A listed
     * copy that is gone is dropped from the index; a file that is gone, or a
     * path the session may no longer serve, is not offered.
     */
    offered(): { documents: OfferedDocumentDraft[]; ts: number } {
      if (!indexKey) return { documents: [], ts: 0 };
      const index = readIndex();
      const documents: OfferedDocumentDraft[] = [];
      let ts = 0;
      let pruned = false;
      for (const [canonical, clientPath] of [...index]) {
        const content = storedContent(canonical);
        if (!content) {
          index.delete(canonical);
          pruned = true;
          continue;
        }
        if (!servable(canonical)) continue;
        if (!settled) coveredDocuments.add(canonical);
        documents.push({ path: clientPath, annotations: content.annotations, globalAttachments: content.globalAttachments });
        ts = Math.max(ts, content.ts);
      }
      if (pruned && !settled) writeIndex(index);
      return { documents, ts };
    },

    /** GET one document's copy (`?path=`). */
    loadDocument(rawPath: unknown): DocumentDraftResult {
      const resolved = resolveDocumentPath(rawPath);
      if ("error" in resolved) return { status: resolved.status, body: { error: resolved.error } };
      const content = storedContent(resolved.path);
      if (!content) return { status: 404, body: { found: false, error: "No draft" } };
      if (!settled) {
        coveredDocuments.add(resolved.path);
        if (indexKey) {
          const index = readIndex();
          if (index.get(resolved.path) !== rawPath) {
            listed(index, resolved.path, rawPath as string);
            writeIndex(index);
          }
        }
      }
      return { status: 200, body: { found: true, annotations: content.annotations, globalAttachments: content.globalAttachments } };
    },

    /** POST `{ documents: [{ path, annotations, globalAttachments? }] }`. */
    saveDocuments(body: unknown): DocumentDraftResult {
      if (settled) return { status: 409, body: { ok: false, error: "The review is already decided" } };
      const writes = parseDocumentWrites(body);
      if (typeof writes === "string") return { status: 400, body: { ok: false, error: writes } };
      // A path this session may not write is skipped and reported; the
      // others are still written, so one odd document never costs the rest.
      const resolvedWrites: (DocumentWrite & { clientPath: string })[] = [];
      const rejected: string[] = [];
      for (const write of writes) {
        const resolved = resolveDocumentPath(write.path);
        if ("error" in resolved) rejected.push(write.path);
        else resolvedWrites.push({ ...write, path: resolved.path, clientPath: write.path });
      }

      const index = indexKey ? readIndex() : null;
      const indexBefore = index ? JSON.stringify([...index]) : "";
      let written = 0;
      for (const write of resolvedWrites) {
        coveredDocuments.add(write.path);
        const key = annotateFileDraftKey(write.path);
        const stored = loadDraft(key) as Record<string, unknown> | null;
        const empty = write.annotations.length === 0 && write.globalAttachments.length === 0;
        if (index) {
          if (empty) index.delete(write.path);
          else listed(index, write.path, write.clientPath);
        }
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
      if (index && JSON.stringify([...index]) !== indexBefore) writeIndex(index);
      return { status: 200, body: { ok: true, written, ...(rejected.length > 0 ? { rejected } : {}) } };
    },

    /**
     * The reviewer decided: clear every copy this session covered or lists
     * (and may serve), then refuse writes. Entries this session cannot serve
     * (another project's copies under the same root text) stay in the index;
     * the index is deleted only when none remain.
     */
    settle(): void {
      const paths = new Set(coveredDocuments);
      const index = readIndex();
      for (const canonical of index.keys()) if (servable(canonical)) paths.add(canonical);
      for (const path of paths) {
        clearDocumentCopy(path);
        index.delete(path);
      }
      writeIndex(index);
      coveredDocuments.clear();
      settled = true;
    },

    /** Unsent comments in every copy this session covered or lists (and may serve). */
    countUnsent(count: (draft: unknown) => number): number {
      const paths = new Set(coveredDocuments);
      for (const canonical of readIndex().keys()) if (servable(canonical)) paths.add(canonical);
      let total = 0;
      for (const path of paths) total += count(loadDraft(annotateFileDraftKey(path)));
      return total;
    },
  };
}

export type DocumentDraftStore = ReturnType<typeof createDocumentDraftStore>;

/**
 * GET /api/draft for a session whose store keeps an index: the session draft
 * plus `documents`, every listed document's comments by path. With no session
 * draft but listed documents, a draft with no root comments is served
 * (carrying the session key's generation, so the client resumes above a
 * tombstone). Without an index, exactly `loadReviewDraft`.
 */
export function loadSessionDraftWithDocuments(
  keys: ReviewDraftKeys,
  store: DocumentDraftStore | null,
): ReviewDraftLoadResult {
  const result = loadReviewDraft(keys);
  if (!store?.indexed) return result;
  const { documents, ts } = store.offered();
  if (!result.found) {
    if (documents.length === 0) return result;
    return {
      found: true,
      draft: {
        annotations: [],
        globalAttachments: [],
        documents,
        ...(result.draftGeneration !== null ? { draftGeneration: result.draftGeneration } : {}),
        ts,
      },
    };
  }
  // `documents` is the server's to write: a stored one is never passed on.
  const { documents: _stored, ...draft } = result.draft;
  return { found: true, draft: documents.length > 0 ? { ...draft, documents } : draft };
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
  const store = options.documents
    ? createDocumentDraftStore({
        isAllowed: options.documents.isAllowed,
        rootPath: options.filePath ?? null,
        indexKey: options.documents.indexed ? documentDraftIndexKey(options.contentKey) : null,
      })
    : null;
  /** The reviewer decided (feedback, approve, Close): saves are refused. */
  let settled = false;
  /** The agent closed the session: the draft is kept and may still grow. */
  let agentClosed = false;

  return {
    /** Whether this session advertises per-document copies to the client. */
    documentsEnabled: store !== null,

    load(): ReviewDraftLoadResult {
      const result = loadSessionDraftWithDocuments(keys, store);
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
     * a closed tab must not delete the draft the agent close kept. Document
     * copies are not touched: a root left with no comments while another
     * document holds some must not lose them (#1545).
     */
    remove(draftGeneration?: number): void {
      if (settled || agentClosed) return;
      deleteReviewDraft(keys, draftGeneration);
    },

    /**
     * The reviewer's decision (feedback, approve, Close): clear the session's
     * keys and every document copy it covered or lists, then refuse further
     * saves and document writes.
     */
    settle(draftGeneration?: number): void {
      deleteReviewDraft(keys, draftGeneration);
      store?.settle();
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
     * it covered or lists. `count` reads one stored draft (host-control's
     * countUnsentDraftComments).
     */
    countUnsent(count: (draft: unknown) => number): number {
      const loaded = loadReviewDraft(keys);
      const total = loaded.found ? count(loaded.draft) : 0;
      return total + (store ? store.countUnsent(count) : 0);
    },

    /** GET one document's copy (`?path=`). */
    loadDocument(rawPath: unknown): DocumentDraftResult {
      if (!store) return { status: 404, body: { error: "Not available" } };
      return store.loadDocument(rawPath);
    },

    /** POST `{ documents: [{ path, annotations, globalAttachments? }] }`. */
    saveDocuments(body: unknown): DocumentDraftResult {
      if (!store) return { status: 404, body: { error: "Not available" } };
      return store.saveDocuments(body);
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

/**
 * Whether an annotate session's root has no file of its own but can still
 * open linked documents: a URL or the last message. These sessions get
 * per-document copies WITH an index, like plan review (#1545). Live-app
 * sessions have no linked markdown documents and are left out.
 */
export function annotateSessionHasRootlessDocuments(input: { mode: string; filePath: string }): boolean {
  if (input.mode === "annotate-last") return true;
  return input.mode === "annotate" && /^https?:\/\//i.test(input.filePath ?? "");
}
