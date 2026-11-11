/**
 * Annotate draft storage keyed by the file's path as well as its content, plus per-document copies and an index of them.
 * Generations and the `patchKey`/`patchKeys` stamps are server-side: a client cannot forge them.
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

export function annotateFileDraftKey(absolutePath: string): string {
  return `file-${contentHash(`v1|file|${absolutePath}`)}`;
}

export function documentDraftIndexKey(sessionKey: string): string {
  return `docs-${contentHash(`v1|docs|${sessionKey}`)}`;
}

export function readDraftClientId(raw: unknown): string | null {
  return typeof raw === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(raw) ? raw : null;
}

export const MAX_DRAFT_DOCUMENTS_PER_WRITE = 500;

const MAX_INDEXED_DOCUMENTS = MAX_DRAFT_DOCUMENTS_PER_WRITE;

export interface AnnotateDraftSessionOptions {
  contentKey: string;
  filePath?: string | null;
  documents?: {
    isAllowed: (absolutePath: string, anyPath: boolean) => boolean;
  } | null;
}

export type DocumentDraftResult =
  | { status: 200; body: { found: true; annotations: unknown[]; globalAttachments: unknown[] } }
  | { status: 200; body: { ok: true; written: number; rejected?: string[] } }
  | { status: 400 | 403 | 404 | 409; body: { found?: false; ok?: false; error: string } };

export interface OfferedDocumentDraft {
  path: string;
  annotations: unknown[];
  globalAttachments: unknown[];
}

interface DocumentWrite {
  path: string;
  annotations: unknown[];
  globalAttachments: unknown[];
}

const DOCUMENT_OWNED_FIELDS = new Set(["annotations", "globalAttachments", "draftGeneration", "ts", "patchKey"]);
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
  isAllowed: (absolutePath: string, anyPath: boolean) => boolean;
  rootPath?: string | null;
  indexKey?: string | null;
}

export function createDocumentDraftStore(options: DocumentDraftStoreOptions) {
  const rootPath = options.rootPath ?? null;
  const indexKey = options.indexKey ?? null;
  const coveredByPage = new Map<string, Set<string>>();
  const cover = (path: string, clientId: string | null | undefined) => {
    const page = readDraftClientId(clientId) ?? "";
    let paths = coveredByPage.get(page);
    if (!paths) {
      paths = new Set();
      coveredByPage.set(page, paths);
    }
    paths.add(path);
  };
  const allCovered = (): Set<string> => {
    const paths = new Set<string>();
    for (const page of coveredByPage.values()) for (const path of page) paths.add(path);
    return paths;
  };
  let settled = false;

  const resolveDocumentPath = (raw: unknown, anyPath: boolean): { path: string } | { status: 400 | 403; error: string } => {
    if (typeof raw !== "string" || raw.length === 0) return { status: 400, error: "Missing path" };
    const path = canonicalDocumentPath(raw);
    if (!path) return { status: 400, error: "Not an existing file" };
    // The root file's own path key is the session draft itself (one writer).
    if (rootPath && path === rootPath) return { status: 403, error: "The session's own file is saved with the session draft" };
    if (!options.isAllowed(path, anyPath)) return { status: 403, error: "Path not allowed" };
    return { path };
  };

  /** The index key comes from the root's text alone, so an entry another project listed under the same text is not this session's to offer, count or clear. */
  const servable = (canonical: string): boolean =>
    canonicalDocumentPath(canonical) === canonical &&
    !(rootPath && canonical === rootPath) &&
    options.isAllowed(canonical, false);

  const clearDocumentCopy = (path: string) => {
    const key = annotateFileDraftKey(path);
    const known = getDraftGeneration(key);
    deleteDraft(key, known ?? undefined);
  };

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
    indexed: indexKey !== null,

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
        // The session draft's load names no page: a page that restores a
        // copy reads it again under its own id (useDocumentDrafts).
        if (!settled) cover(canonical, null);
        documents.push({ path: clientPath, annotations: content.annotations, globalAttachments: content.globalAttachments });
        ts = Math.max(ts, content.ts);
      }
      if (pruned && !settled) writeIndex(index);
      return { documents, ts };
    },

    loadDocument(rawPath: unknown, clientId?: string | null, anyPath = false): DocumentDraftResult {
      const resolved = resolveDocumentPath(rawPath, anyPath);
      if ("error" in resolved) return { status: resolved.status, body: { error: resolved.error } };
      const content = storedContent(resolved.path);
      if (!content) return { status: 404, body: { found: false, error: "No draft" } };
      if (!settled) {
        cover(resolved.path, clientId);
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

    saveDocuments(body: unknown, clientId?: string | null, anyPath = false): DocumentDraftResult {
      if (settled) return { status: 409, body: { ok: false, error: "The review is already decided" } };
      const writes = parseDocumentWrites(body);
      if (typeof writes === "string") return { status: 400, body: { ok: false, error: writes } };
      // A path this session may not write is skipped and reported; the
      // others are still written, so one odd document never costs the rest.
      const resolvedWrites: (DocumentWrite & { clientPath: string })[] = [];
      const rejected: string[] = [];
      for (const write of writes) {
        const resolved = resolveDocumentPath(write.path, anyPath);
        if ("error" in resolved) rejected.push(write.path);
        else resolvedWrites.push({ ...write, path: resolved.path, clientPath: write.path });
      }

      const index = indexKey ? readIndex() : null;
      const indexBefore = index ? JSON.stringify([...index]) : "";
      let written = 0;
      for (const write of resolvedWrites) {
        cover(write.path, clientId);
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
        // One above everything the key has seen, so the write lands.
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

    /** With a page id, clear only the copies that page read, wrote or restored; without one, every copy this session wrote, read or offered. Then refuse writes. */
    settle(clientId?: string | null): void {
      const page = readDraftClientId(clientId);
      const index = readIndex();
      const paths = page !== null ? new Set(coveredByPage.get(page) ?? []) : allCovered();
      for (const path of paths) {
        clearDocumentCopy(path);
        index.delete(path);
      }
      writeIndex(index);
      coveredByPage.clear();
      settled = true;
    },

    countUnsent(count: (draft: unknown) => number): number {
      const paths = allCovered();
      for (const canonical of readIndex().keys()) if (servable(canonical)) paths.add(canonical);
      let total = 0;
      for (const path of paths) total += count(loadDraft(annotateFileDraftKey(path)));
      return total;
    },
  };
}

export type DocumentDraftStore = ReturnType<typeof createDocumentDraftStore>;

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

export function createAnnotateDraftSession(options: AnnotateDraftSessionOptions) {
  const keys: ReviewDraftKeys = {
    patchKey: options.contentKey,
    targetKey: options.filePath ? annotateFileDraftKey(options.filePath) : null,
  };
  const store = options.documents
    ? createDocumentDraftStore({
        isAllowed: options.documents.isAllowed,
        rootPath: options.filePath ?? null,
        indexKey: documentDraftIndexKey(options.contentKey),
      })
    : null;
  let settled = false;
  let agentClosed = false;

  return {
    documentsEnabled: store !== null,

    load(): ReviewDraftLoadResult {
      const result = loadSessionDraftWithDocuments(keys, store);
      if (!result.found) return result;
      // `patchChanged` is review vocabulary; an annotate client re-anchors
      // every comment by text on restore whatever the flag says.
      const { patchChanged: _changed, ...draft } = result.draft;
      return { found: true, draft };
    },

    save(body: object): boolean {
      if (settled) return false;
      return saveReviewDraft(keys, body);
    },

    /**
     * After a decision every save is refused with `409 { decided: true }` so a second tab cannot put back sent comments.
     * With a path copy, a stale save is `409 { error, found, draftGeneration }`.
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

    /** A no-op once decided or closed by the agent: a closed tab must not delete the draft the agent close kept. Document copies are untouched. */
    remove(draftGeneration?: number): void {
      if (settled || agentClosed) return;
      deleteReviewDraft(keys, draftGeneration);
    },

    settle(draftGeneration?: number, clientId?: string | null): void {
      deleteReviewDraft(keys, draftGeneration);
      store?.settle(clientId);
      settled = true;
    },

    /** Agent close deletes nothing. Saves stay accepted so a debounced save arriving after the close completes the kept draft; only a DELETE from the closed tab is ignored. */
    closeKeepingDraft(): void {
      agentClosed = true;
    },

    countUnsent(count: (draft: unknown) => number): number {
      const loaded = loadReviewDraft(keys);
      const total = loaded.found ? count(loaded.draft) : 0;
      return total + (store ? store.countUnsent(count) : 0);
    },

    loadDocument(rawPath: unknown, clientId?: string | null, anyPath = false): DocumentDraftResult {
      if (!store) return { status: 404, body: { error: "Not available" } };
      return store.loadDocument(rawPath, clientId, anyPath);
    },

    saveDocuments(body: unknown, clientId?: string | null, anyPath = false): DocumentDraftResult {
      if (!store) return { status: 404, body: { error: "Not available" } };
      return store.saveDocuments(body, clientId, anyPath);
    },
  };
}

export type AnnotateDraftSession = ReturnType<typeof createAnnotateDraftSession>;

/** Absolute, resolved, symlinks followed (aliases share a key), existing regular file only; else null. */
export function canonicalDocumentPath(path: string): string | null {
  if (!path || !isAbsolute(path)) return null;
  try {
    const real = realpathSync(resolvePath(path));
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Path-keyed drafts apply to a single local file session (mode "annotate", not a URL); folder sessions use per-document copies instead. */
export function annotateDraftFilePath(input: { mode: string; filePath: string }): string | null {
  if (input.mode !== "annotate") return null;
  if (!input.filePath || /^https?:\/\//i.test(input.filePath)) return null;
  const resolved = resolvePath(input.filePath);
  return canonicalDocumentPath(resolved) ?? resolved;
}

export function annotateSessionHasRootlessDocuments(input: { mode: string; filePath: string }): boolean {
  if (input.mode === "annotate-last") return true;
  return input.mode === "annotate" && /^https?:\/\//i.test(input.filePath ?? "");
}
