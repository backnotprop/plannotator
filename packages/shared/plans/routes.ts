/**
 * Plans' HTTP routes, runtime-neutral (the shape of packages/shared/shape/routes.ts). The Inbox mounts them through
 * its capability list (packages/server/plans-capability.ts) only while Plans is on; off, every `/api/plans` path is
 * the Inbox's unknown-route 404, as if absent. The caller owns the guards (the owner's window on this computer,
 * same-origin, the page's server session on the one write).
 *
 *   GET  /api/plans                          every plan, newest change first, with the person's look
 *   GET  /api/plans/:id                      one plan: its record, documents, artifacts, decisions and activity, look
 *   GET  /api/plans/:id/files/<asset_path>   an artifact's bytes (a raster picture as itself, other text as plain
 *                                            text, anything else as a download: `artifactServedType`)
 *   GET  /api/plans/:id/versions[?doc=]      a document's versions (the primary one without doc)
 *   GET  /api/plans/:id/versions/:n[?doc=]   one version's bytes, as saved
 *   GET  /api/plans/:id/diff[?doc=&from=&to=]  the two texts a diff needs: `to` the head unless named, `from` the
 *                                            version the person last saw (else the one before `to`)
 *   POST /api/plans/:id/look                 { doc?, seen? }: the person looked (and saw version `seen`)
 *   POST /api/plans/:id/comments             { doc?, version, annotation }: the person's comment on a version (new, or
 *                                            an edit of one not sent), kept as the Inbox keeps a file's comment
 *   POST /api/plans/:id/comments/:annotation/remove   take that comment away
 *
 * `GET /api/plans/:id` carries the kept comments (`comments`).
 */
import { checkPlanCommentInput, checkPlanLookInput, isPlanAnnotationId, isPlanId, isPlanPictureType, isPlanVersionNumber, planMediaType, type PlanVersion } from "@plannotator/core/plans";
import type { PlanStore } from "./store";

export const PLANS_ROUTE_PREFIX = "/api/plans";

export type PlanRouteResult =
  | { status: number; body: unknown }
  | { status: 200; file: { path: string; contentType: string } };

export interface PlanRouteRequest {
  method: string;
  /** The URL's path, `/api/plans/…`. */
  pathname: string;
  params: URLSearchParams;
  /** The JSON body of a POST; it throws on bad JSON. */
  json: () => Promise<unknown>;
}

export interface PlanRouteDeps {
  store: PlanStore;
  /** A look was recorded (the event feed, later). */
  changed?: (id: string) => void;
  /** The import is running: the list says so (`importing: true`), so a reader can ask again. */
  importing?: () => boolean;
  /** The last import failed: its message (`import_error`), else null; the list holds what was read before. */
  importError?: () => string | null;
}

const CONTENT_TYPE: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  html: "text/plain; charset=utf-8",
  mmd: "text/plain; charset=utf-8",
  dot: "text/plain; charset=utf-8",
};

/**
 * The type an artifact's bytes are served as. An artifact is an agent's file on this Inbox's own origin, so nothing
 * that could run there is served as itself: a raster picture keeps its type; text of any kind (HTML, SVG, JSON…)
 * is plain text, which the window draws itself (an HTML page in a sandboxed frame, an SVG as a data: picture);
 * anything else is a download.
 */
export function artifactServedType(contentType: string): string {
  const type = planMediaType(contentType);
  // Raster pictures (`PLAN_PICTURE_TYPES`, the list the window draws as pictures) as what they are: they run nothing.
  if (isPlanPictureType(type)) return type;
  if (type.startsWith("text/") || type === "image/svg+xml" || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

const bad = (message: string, status = 400): PlanRouteResult => ({ status, body: { error: message } });

/** True for `/api/plans` and every path under it. */
export function isPlansPath(pathname: string): boolean {
  return pathname === PLANS_ROUTE_PREFIX || pathname.startsWith(`${PLANS_ROUTE_PREFIX}/`);
}

/** Plans' routes; null when the path is not one of them. */
export async function handlePlanRoute(req: PlanRouteRequest, deps: PlanRouteDeps): Promise<PlanRouteResult | null> {
  if (!isPlansPath(req.pathname)) return null;
  const { store } = deps;
  let parts: string[];
  try {
    parts = req.pathname.split("/").slice(3).filter(Boolean).map((p) => decodeURIComponent(p));
  } catch {
    return bad("malformed URL encoding");
  }
  const method = req.method.toUpperCase();

  if (parts.length === 0) {
    if (method !== "GET") return bad("method not allowed", 405);
    return { status: 200, body: { plans: store.list(), importing: deps.importing?.() ?? false, import_error: deps.importError?.() ?? null } };
  }

  const id = parts[0]!;
  if (!isPlanId("pln", id)) return bad("not a plan id", 404);
  const read = store.read(id);
  if (!read) return bad(`No plan ${id}.`, 404);
  const sub = parts[1];
  const docParam = req.params.get("doc");
  if (docParam !== null && !read.documents.some((doc) => doc.id === docParam)) return bad(`${id} has no document ${docParam}.`, 404);
  const docId = docParam ?? read.plan.primary_doc_id;
  const look = store.looks().plans[id] ?? null;

  if (!sub) {
    if (method !== "GET") return bad("method not allowed", 405);
    const decisions = read.events.filter((event) => event.kind === "decision").map((event) => event.decision);
    return { status: 200, body: { plan: read.plan, documents: read.documents, artifacts: read.artifacts, decisions, events: read.events, look, comments: store.comments(id) } };
  }

  if (sub === "files" && parts.length >= 3) {
    if (method !== "GET") return bad("method not allowed", 405);
    const assetPath = parts.slice(2).join("/");
    const artifact = read.artifacts.find((a) => a.asset_path === assetPath);
    const path = artifact ? store.artifactPath(id, assetPath) : null;
    if (!artifact || !path) return bad(`${id} has no artifact ${assetPath}.`, 404);
    return { status: 200, file: { path, contentType: artifactServedType(artifact.content_type) } };
  }

  if (sub === "versions" && parts.length === 2) {
    if (method !== "GET") return bad("method not allowed", 405);
    return { status: 200, body: { document_id: docId, versions: read.versions.filter((v) => v.document_id === docId) } };
  }

  if (sub === "versions" && parts.length === 3) {
    if (method !== "GET") return bad("method not allowed", 405);
    const n = Number(parts[2]);
    if (!isPlanVersionNumber(n) || String(n) !== parts[2]) return bad("a version number", 404);
    const path = store.versionPath(id, docId, n);
    if (!path) return bad(`${id} has no version ${n}.`, 404);
    const ext = path.slice(path.lastIndexOf(".") + 1);
    return { status: 200, file: { path, contentType: CONTENT_TYPE[ext] ?? "text/plain; charset=utf-8" } };
  }

  if (sub === "diff" && parts.length === 2) {
    if (method !== "GET") return bad("method not allowed", 405);
    const versions = read.versions.filter((v) => v.document_id === docId);
    const head = versions[versions.length - 1];
    if (!head) return { status: 200, body: { document_id: docId, from: null, to: null } };
    // Absent: null (the default applies); named but not a version of this document: "bad".
    const pick = (raw: string | null): PlanVersion | null | "bad" => {
      if (raw === null) return null;
      const n = Number(raw);
      return (isPlanVersionNumber(n) && versions.find((v) => v.version_number === n)) || "bad";
    };
    const toPick = pick(req.params.get("to"));
    const fromPick = pick(req.params.get("from"));
    if (toPick === "bad" || fromPick === "bad") return bad("from and to are version numbers of this document", 404);
    const to = toPick ?? head;
    const seen = look?.docs[docId];
    const from = fromPick ?? (seen !== undefined && seen < to.version_number ? versions.find((v) => v.version_number === seen) : undefined) ?? versions.find((v) => v.version_number === to.version_number - 1) ?? null;
    const textOf = (v: PlanVersion | null) => {
      if (!v) return null;
      const bytes = store.versionBytes(id, docId, v.version_number);
      return bytes ? { version_number: v.version_number, version: v.version, committed_at: v.committed_at, text: new TextDecoder().decode(bytes) } : null;
    };
    return { status: 200, body: { document_id: docId, seen: seen ?? null, from: textOf(from), to: textOf(to) } };
  }

  if (sub === "look" && parts.length === 2) {
    if (method !== "POST") return bad("method not allowed", 405);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return bad("the body must be JSON");
    }
    const input = checkPlanLookInput(body);
    if (!input.ok) return bad(input.error);
    const doc = input.doc ?? read.plan.primary_doc_id;
    const document = read.documents.find((d) => d.id === doc);
    if (!document) return bad(`${id} has no document ${doc}.`, 404);
    if (input.seen !== null && input.seen > document.head_version) return bad(`${doc} has no version ${input.seen}.`);
    const recorded = store.recordLook(id, { doc, seen: input.seen });
    deps.changed?.(id);
    return { status: 200, body: { look: recorded } };
  }

  if (sub === "comments" && parts.length === 2) {
    if (method !== "POST") return bad("method not allowed", 405);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return bad("the body must be JSON");
    }
    const input = checkPlanCommentInput(body);
    if (!input.ok) return bad(input.error);
    const doc = input.doc ?? read.plan.primary_doc_id;
    if (!read.documents.some((d) => d.id === doc)) return bad(`${id} has no document ${doc}.`, 404);
    const version = read.versions.find((v) => v.document_id === doc && v.version_number === input.version);
    if (!version) return bad(`${doc} has no version ${input.version}.`, 404);
    try {
      const comment = store.saveComment(id, { document_id: doc, document_version: version.version, annotation: input.annotation, at: new Date().toISOString() });
      deps.changed?.(id);
      return { status: 200, body: { comment } };
    } catch (error) {
      return bad(error instanceof Error ? error.message : String(error), 409);
    }
  }

  if (sub === "comments" && parts.length === 4 && parts[3] === "remove") {
    if (method !== "POST") return bad("method not allowed", 405);
    const annotationId = parts[2]!;
    if (!isPlanAnnotationId(annotationId)) return bad("not an annotation id", 404);
    try {
      const comment = store.removeComment(id, annotationId, new Date().toISOString());
      if (!comment) return bad(`${id} has no comment ${annotationId}.`, 404);
      deps.changed?.(id);
      return { status: 200, body: { comment } };
    } catch (error) {
      return bad(error instanceof Error ? error.message : String(error), 409);
    }
  }

  return bad("not found", 404);
}
