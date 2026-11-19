/**
 * Plans' HTTP routes, runtime-neutral (the shape of packages/shared/shape/routes.ts). The Inbox mounts them through
 * its capability list (packages/server/plans-capability.ts) only while Plans is on; off, every `/api/plans` path is
 * the Inbox's unknown-route 404, as if absent. The caller owns the guards (the owner's window on this computer,
 * same-origin, the page's server session on the one write).
 *
 *   GET  /api/plans                          every plan, newest change first, with the person's look; the person's
 *                                            pins in their order (`pins`) and the Spaces home's view (`view`); with
 *                                            an `ETag`, and 304 for an `If-None-Match` that is still the answer
 *   POST /api/plans/pins                     { id, pinned, index? }: pin a plan (at `index`, else last), move it, or
 *                                            unpin it; answers the order (`pins`)
 *   POST /api/plans/view                     { view }: the Spaces home's view, "cards" or "list" (config.json)
 *   GET  /api/plans/:id                      one plan: its record, documents, artifacts, decisions and activity, look
 *   GET  /api/plans/:id/files/<asset_path>   an artifact's bytes (a raster picture as itself, other text as plain
 *                                            text, anything else as a download: `artifactServedType`)
 *   GET  /api/plans/:id/versions[?doc=]      a document's versions (the primary one without doc)
 *   GET  /api/plans/:id/versions/:n[?doc=]   one version's bytes, as saved; `face=1`: the top a face draws, as
 *                                            `PlanFaceText` (a document's first 16 KB, an HTML page up to 512 KB)
 *   GET  /api/plans/:id/diff[?doc=&from=&to=]  the two texts a diff needs: `to` the head unless named, `from` the
 *                                            version the person last saw (else the one before `to`)
 *   POST /api/plans/:id/look                 { doc?, seen? }: the person looked (and saw version `seen`)
 *   POST /api/plans/:id/comments             { doc?, version, annotation }: the person's comment on a version (new, or
 *                                            an edit of one not sent), kept as the Inbox keeps a file's comment
 *   POST /api/plans/:id/comments/:annotation/remove   take that comment away
 *   POST /api/plans/:id/versions             { doc?, base, text } or { doc?, base, restore }: a new newest version the
 *                                            person made (`source: "person"`); 409 `moved_on` when `base` is not the
 *                                            newest any more, 409 `unchanged` when it holds what the newest holds.
 *                                            Answers the version and the Direct Edits section for the agent.
 *   POST /api/plans/:id/approve              { doc?, version }: the person approves the version on screen; 409
 *                                            `moved_on` when a newer one came
 *   POST /api/plans/:id/sent                 { thread_id, message_id, to?, comments }: a Send went out: its comments
 *                                            are sent, and the plan has that Inbox thread
 *
 * `GET /api/plans/:id` carries the kept comments (`comments`). Approvals follow approval "plans-editing" (the store's
 * `addVersion` clears or moves them as it writes the version).
 *
 * A POST's body is read before the plan is: from that read to the write nothing awaits, so a check ("is `base` still
 * the newest?") and the write it allows see the same library, whatever wrote while the body was arriving (another
 * tab, the import's pickup of the agent's next version).
 */
import { checkPlanPinInput, checkSpacesViewInput, type SpacesView } from "@plannotator/core/plans";
import { checkPlanApproveInput, checkPlanCommentInput, checkPlanLookInput, checkPlanSentInput, checkPlanVersionInput, isPlanAnnotationId, isPlanId, isPlanPictureType, isPlanVersionNumber, planApprovalsOn, planDocumentFileName, planMediaType, planPictureTypeOf, planTextLines, PLAN_PERSON, type PlanVersion } from "@plannotator/core/plans";
import { buildDirectEditsSection } from "../direct-edits";
import type { PlanStore } from "./store";

export const PLANS_ROUTE_PREFIX = "/api/plans";

export type PlanRouteResult =
  | { status: number; body: unknown; etag?: string }
  | { status: 200; file: { path: string; contentType: string } };

export interface PlanRouteRequest {
  method: string;
  /** The URL's path, `/api/plans/…`. */
  pathname: string;
  params: URLSearchParams;
  /** The JSON body of a POST; it throws on bad JSON. */
  json: () => Promise<unknown>;
  /** The request's `If-None-Match` (the list's last `ETag`), if any. */
  ifNoneMatch?: string | null;
}

export interface PlanRouteDeps {
  store: PlanStore;
  /** A look was recorded (the event feed, later). */
  changed?: (id: string) => void;
  /** The import is running: the list says so (`importing: true`), so a reader can ask again. */
  importing?: () => boolean;
  /** The last import failed: its message (`import_error`), else null; the list holds what was read before. */
  importError?: () => string | null;
  /** The Spaces home's view (config.json `inboxSpacesView`); absent: "cards", and `POST /view` refused. */
  view?: { read: () => SpacesView; save: (view: SpacesView) => boolean };
}

const CONTENT_TYPE: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  html: "text/plain; charset=utf-8",
  mmd: "text/plain; charset=utf-8",
  dot: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
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

/** A write that names a version no longer the newest: refused, with the newest, so the window shows it. */
const movedOn = (head: PlanVersion) => ({ status: 409, body: { error: `The plan moved on: v${head.version_number} is newer than the version you had.`, code: "moved_on", head } });

/** The JSON body of a POST, or null when it is not JSON. */
async function bodyOf(req: PlanRouteRequest): Promise<{ value: unknown } | null> {
  try {
    return { value: await req.json() };
  } catch {
    return null;
  }
}

/** FNV-1a, 32 bits, as hex: a short tag for the list's stamp (not a secret). */
function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

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
    const importing = deps.importing?.() ?? false;
    const importError = deps.importError?.() ?? null;
    const view = deps.view?.read() ?? "cards";
    // The same files, import state and view are the same answer: a window polling it is told so without a read.
    const etag = `"${hashOf(JSON.stringify([store.listStamp(), importing, importError, view]))}"`;
    if (req.ifNoneMatch === etag) return { status: 304, body: null, etag };
    return { status: 200, body: { plans: store.list(), importing, import_error: importError, pins: store.pins(), view }, etag };
  }

  if (parts.length === 1 && parts[0] === "pins") {
    if (method !== "POST") return bad("method not allowed", 405);
    const posted = await bodyOf(req);
    if (!posted) return bad("the body must be JSON");
    const input = checkPlanPinInput(posted.value);
    if (!input.ok) return bad(input.error);
    if (input.pinned && !store.get(input.id)) return bad(`No plan ${input.id}.`, 404);
    return { status: 200, body: { pins: store.setPin(input.id, input.pinned, input.index) } };
  }

  if (parts.length === 1 && parts[0] === "view") {
    if (method !== "POST") return bad("method not allowed", 405);
    const posted = await bodyOf(req);
    if (!posted) return bad("the body must be JSON");
    const input = checkSpacesViewInput(posted.value);
    if (!input.ok) return bad(input.error);
    if (!deps.view) return bad("the view is not kept here", 404);
    if (!deps.view.save(input.view)) return bad("config.json could not be saved; the view holds for this window.", 500);
    return { status: 200, body: { view: input.view } };
  }

  const id = parts[0]!;
  if (!isPlanId("pln", id)) return bad("not a plan id", 404);
  // A POST's body before the plan: from this read to a write nothing awaits (the header says why).
  const posted = method === "POST" ? await bodyOf(req) : null;
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

  if (sub === "versions" && parts.length === 2 && method === "POST") {
    if (!posted) return bad("the body must be JSON");
    const input = checkPlanVersionInput(posted.value);
    if (!input.ok) return bad(input.error);
    const doc = read.documents.find((d) => d.id === (input.doc ?? read.plan.primary_doc_id));
    if (!doc) return bad(`${id} has no document ${input.doc}.`, 404);
    // Never an edit of a diagram or an HTML page this round: only a Markdown page's words; a Restore takes any kind.
    if (input.text !== null && doc.kind !== "markdown") return bad("Only a Markdown page can be edited.");
    const versions = read.versions.filter((v) => v.document_id === doc.id);
    const head = versions[versions.length - 1];
    if (!head) return bad(`${doc.id} has no version yet.`, 404);
    if (input.base !== head.version_number) return versions.some((v) => v.version_number === input.base) ? movedOn(head) : bad(`${doc.id} has no version ${input.base}.`, 404);
    const headBytes = store.versionBytes(id, doc.id, head.version_number);
    if (!headBytes) return bad(`${id} could not read version ${head.version_number}.`, 500);
    let bytes: Uint8Array;
    if (input.restore !== null) {
      if (input.restore === head.version_number) return { status: 409, body: { error: `v${head.version_number} is already the newest.`, code: "unchanged" } };
      const restored = store.versionBytes(id, doc.id, input.restore);
      if (!restored) return bad(`${doc.id} has no version ${input.restore}.`, 404);
      bytes = restored;
    } else {
      bytes = new TextEncoder().encode(input.text!);
    }
    const before = new TextDecoder().decode(headBytes);
    const after = new TextDecoder().decode(bytes);
    // Line endings are not a change: an editor gives `\r\n` back as `\n`.
    if (planTextLines(after) === planTextLines(before)) return { status: 409, body: { error: input.restore !== null ? `v${input.restore} holds what v${head.version_number} holds: nothing to restore.` : "Nothing changed: no new version.", code: "unchanged" } };
    const version = store.addVersion(id, doc.id, {
      bytes,
      committed_at: new Date().toISOString(),
      source: "person",
      author_via: "person",
      ...(input.restore !== null ? { restored_from: input.restore } : {}),
    });
    deps.changed?.(id);
    const plan = store.get(id)!;
    const cleared = plan.last_approval_cleared?.version_number === version.version_number && plan.last_approval_cleared.document_id === doc.id ? plan.last_approval_cleared : null;
    const moved = plan.last_approval_moved?.version_number === version.version_number && plan.last_approval_moved.document_id === doc.id ? plan.last_approval_moved : null;
    // What the agent is sent: from the newest version it knows (its own, or one of the person's it was told about; an
    // edit whose New message was never sent was not) to this one, so nothing the person changed is skipped.
    const told = Math.max(...versions.filter((v) => v.source !== "person").map((v) => v.version_number), Math.min(plan.agent_told?.[doc.id] ?? 0, head.version_number), 1);
    const toldBytes = told === head.version_number ? headBytes : store.versionBytes(id, doc.id, told);
    const from = toldBytes ? told : head.version_number;
    const fromText = planTextLines(toldBytes ? new TextDecoder().decode(toldBytes) : before);
    const file = planDocumentFileName(doc);
    const done = input.restore !== null ? `restored v${input.restore} of ${file} as v${version.version_number}` : `edited ${file}; it is now v${version.version_number}`;
    const direct_edits = buildDirectEditsSection(fromText, planTextLines(after), false, {
      label: file,
      preamble: `The person ${done}, in the Plannotator Inbox. Apply these exact changes: a unified diff from v${from} (the newest version you know) to v${version.version_number}:`,
    });
    return { status: 200, body: { version, direct_edits, told_from: from, cleared, moved } };
  }

  if (sub === "versions" && parts.length === 2) {
    if (method !== "GET") return bad("method not allowed", 405);
    return { status: 200, body: { document_id: docId, versions: read.versions.filter((v) => v.document_id === docId) } };
  }

  if (sub === "approve" && parts.length === 2) {
    if (method !== "POST") return bad("method not allowed", 405);
    if (!posted) return bad("the body must be JSON");
    const input = checkPlanApproveInput(posted.value);
    if (!input.ok) return bad(input.error);
    const doc = read.documents.find((d) => d.id === (input.doc ?? read.plan.primary_doc_id));
    if (!doc) return bad(`${id} has no document ${input.doc}.`, 404);
    const versions = read.versions.filter((v) => v.document_id === doc.id);
    const head = versions[versions.length - 1];
    const shown = versions.find((v) => v.version_number === input.version);
    if (!head || !shown) return bad(`${doc.id} has no version ${input.version}.`, 404);
    // An approval is of the version the person looked at, and only while it is the newest.
    if (shown.version_number !== head.version_number) return movedOn(head);
    const already = planApprovalsOn(read.events, doc.id, head.version_number).find((a) => a.name === PLAN_PERSON);
    if (already) return { status: 200, body: { decision: already.event.decision } };
    const at = new Date().toISOString();
    const event = store.addEvent(id, {
      kind: "decision",
      at,
      subject: { document_id: doc.id, version_number: head.version_number },
      decision: { document_id: doc.id, version: head.version, version_number: head.version_number, decision: "approved", at, feedback: null, feedback_record: null, snapshot: null },
      legacy: null,
      author_label: null,
      author_via: "person",
      agent_host: null,
      agent_session: null,
      agent_name: null,
    });
    deps.changed?.(id);
    return { status: 200, body: { decision: event.decision } };
  }

  if (sub === "sent" && parts.length === 2) {
    if (method !== "POST") return bad("method not allowed", 405);
    if (!posted) return bad("the body must be JSON");
    const input = checkPlanSentInput(posted.value);
    if (!input.ok) return bad(input.error);
    if (input.told && !read.versions.some((v) => v.document_id === input.told!.doc && v.version_number === input.told!.version)) return bad(`${id} has no version ${input.told.version} of ${input.told.doc}.`, 404);
    const at = new Date().toISOString();
    const comments = store.markCommentsSent(id, input.comments, { at, message_id: input.message_id, to: input.to ?? { host: "", session: "" } });
    // The plan's thread is the first one a Send made (a later Send replies in it); `told`: the newest of the person's
    // versions the agent has been sent.
    const thread = !read.plan.thread_id && input.thread_id ? { thread_id: input.thread_id } : {};
    const knew = input.told ? read.plan.agent_told?.[input.told.doc] ?? 0 : 0;
    const told = input.told && input.told.version > knew ? { agent_told: { ...read.plan.agent_told, [input.told.doc]: input.told.version } } : {};
    const plan = Object.keys(thread).length || Object.keys(told).length ? store.updatePlan(id, { ...thread, ...told }, at) : read.plan;
    deps.changed?.(id);
    return { status: 200, body: { plan, comments } };
  }

  if (sub === "versions" && parts.length === 3) {
    if (method !== "GET") return bad("method not allowed", 405);
    const n = Number(parts[2]);
    if (!isPlanVersionNumber(n) || String(n) !== parts[2]) return bad("a version number", 404);
    if (req.params.get("face") === "1") {
      const face = store.versionFace(id, docId, n);
      return face ? { status: 200, body: face } : bad(`${id} has no version ${n}.`, 404);
    }
    const path = store.versionPath(id, docId, n);
    if (!path) return bad(`${id} has no version ${n}.`, 404);
    const ext = path.slice(path.lastIndexOf(".") + 1);
    // A picture page: a raster picture as itself (it runs nothing); an SVG as plain text, as an artifact's is (the
    // window draws it as a data: picture); anything else a download.
    if (ext === "img") {
      const bytes = store.versionBytes(id, docId, n);
      const type = bytes ? planPictureTypeOf(bytes) : null;
      return { status: 200, file: { path, contentType: type ? artifactServedType(type) : "application/octet-stream" } };
    }
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
    if (!posted) return bad("the body must be JSON");
    const input = checkPlanLookInput(posted.value);
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
    if (!posted) return bad("the body must be JSON");
    const input = checkPlanCommentInput(posted.value);
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
