/**
 * The Spaces REST calls a share makes, and nothing else. One JSON error shape on every call
 * (`{ error: { code, message, details? } }`), read into `SpacesError`; a call that never got an answer is
 * `SpacesError` with code `offline`. The sign-in token, when there is one, goes in the Authorization header only.
 * A redirect is never followed (the header would go with it).
 *
 * Answers are read leniently: a record may come bare (as the service answers a page, a file, a comment and a reply)
 * or under its name (`{ workspace, document }` on the create), since only the fields a share keeps are relied on
 * (ids, versions, `share_url`). A page's version also comes as a weak `ETag` (`W/"<sha>"`).
 */
import type { SpacePageKind } from "@plannotator/core/space-share";

export class SpacesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    /** Seconds the space asked to wait (`Retry-After`), when it did. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "SpacesError";
  }
}

/**
 * "This space now belongs to someone else": the one place that reads it off an answer, and only a claim says it
 * (`409 claim_conflict`). A write that is not allowed never does: the person may have kept the space themselves, in
 * the browser or from another computer.
 */
export function spaceKeptByAnother(error: unknown): boolean {
  return error instanceof SpacesError && error.status === 409 && error.code === "claim_conflict";
}

/** A page save or a file upload the space does not allow (`403`): it has an owner now. Whose, a claim finds out. */
export function spaceWriteNotAllowed(error: unknown): boolean {
  return error instanceof SpacesError && error.status === 403;
}

/** The space refused the credential itself (`401 unauthorized`): not any 401 (a sign-in asked for, a proxy's page). */
export function spacesTokenRefused(error: unknown): boolean {
  return error instanceof SpacesError && error.status === 401 && error.code === "unauthorized";
}

/**
 * The space is no longer there for this caller, without saying whose it is: with no account `401 login_required`
 * (a space that expired or was removed, or one made private), signed in `404 workspace_not_found`. Trying again
 * cannot help; sharing as a new space can.
 */
export function spaceNotAvailable(error: unknown, signedIn: boolean): boolean {
  if (!(error instanceof SpacesError)) return false;
  return signedIn ? error.status === 404 && error.code === "workspace_not_found" : error.status === 401 && error.code === "login_required";
}

/** How long a call may take before it counts as not answered: a minute, and longer for many bytes. */
export const SPACES_CALL_TIMEOUT_MS = 60_000;

export interface SpacesSpace {
  id: string;
  share_url: string | null;
  owner_name: string | null;
  /** The caller owns it (`access: "owner"`). */
  owned: boolean;
  /** Who can open it (`private`, `link_edit`, …), when the answer says. */
  visibility: string | null;
  documents: { id: string; doc_path: string; version: string | null }[];
}

export interface SpacesClient {
  readonly host: string;
  readonly signedIn: boolean;
  /**
   * `imported` (here and below): the origin fields of what is sent (`spaceImportedFields`, the `actor`), merged into
   * the call's JSON (on the create, beside `document`). `external_key`: the plan's id, signed in only.
   */
  createSpace(body: { id: string; name: string; document: { path: string; kind: SpacePageKind; title: string; body: string } | null; external_key?: string }, imported?: Record<string, unknown>): Promise<{ space: SpacesSpace; document: { id: string; version: string; url: string | null } | null }>;
  getSpace(id: string): Promise<SpacesSpace>;
  addPage(spaceId: string, body: { doc_path: string; kind: SpacePageKind; title: string; body: string }, imported?: Record<string, unknown>): Promise<{ id: string; version: string; url: string | null }>;
  /**
   * Replace a page's text; `ifMatch` is the version the space is expected to hold (412 `version_conflict` otherwise).
   * With `imported` it is the JSON `PATCH` (`{ body, actor }`, never a path), else the raw `PUT`.
   */
  savePage(spaceId: string, docId: string, bytes: Uint8Array, kind: SpacePageKind, ifMatch: string, imported?: Record<string, unknown>): Promise<{ version: string; url: string | null }>;
  putFile(spaceId: string, path: string, bytes: Uint8Array, contentType: string, title?: string | null): Promise<{ id: string | null; content_hash: string | null }>;
  addComment(spaceId: string, docId: string, body: { anchor: unknown; body: string; document_version: string }, key: string, imported?: Record<string, unknown>): Promise<{ id: string }>;
  addReply(spaceId: string, docId: string, annotationId: string, body: { body: string }, key: string, imported?: Record<string, unknown>): Promise<{ id: string }>;
  claim(spaceId: string): Promise<SpacesSpace>;
  deleteSpace(spaceId: string): Promise<void>;
}

/** The media type a page's raw bytes are sent as. */
export const SPACE_PAGE_MEDIA_TYPE: Record<SpacePageKind, string> = {
  markdown: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  mermaid: "text/vnd.mermaid; charset=utf-8",
  graphviz: "text/vnd.graphviz; charset=utf-8",
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
/** A record under its name, or bare. */
const under = (body: unknown, name: string): Record<string, unknown> => (isObject(body) && isObject(body[name]) ? (body[name] as Record<string, unknown>) : isObject(body) ? body : {});

function spaceOf(value: Record<string, unknown>): SpacesSpace {
  const documents = Array.isArray(value.documents) ? value.documents : [];
  return {
    id: text(value.id) ?? "",
    share_url: text(value.share_url),
    owner_name: text(value.owner_name),
    owned: value.access === "owner",
    visibility: text(value.visibility),
    documents: documents.filter(isObject).map((d) => ({ id: text(d.id) ?? "", doc_path: text(d.doc_path) ?? "", version: text(d.version) })),
  };
}

const segment = (value: string) => encodeURIComponent(value);

export function createSpacesClient(options: { host: string; token?: string | null; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }): SpacesClient {
  const doFetch = options.fetch ?? fetch;
  const token = options.token ?? null;

  async function call(method: string, path: string, init: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } = {}): Promise<{ body: unknown; headers: Headers }> {
    const headers: Record<string, string> = { Accept: "application/json", ...init.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.json !== undefined) headers["Content-Type"] = "application/json";
    // The body, made once: JSON as its UTF-8 bytes, or the raw bytes.
    const payload = init.json !== undefined ? new TextEncoder().encode(JSON.stringify(init.json)) : init.bytes;
    // A connection that stalls ends as a call that was not answered (about 50 KB a second at the least for a body).
    const timeout = AbortSignal.timeout((options.timeoutMs ?? SPACES_CALL_TIMEOUT_MS) + (payload ? payload.length / 50 : 0));
    let response: Response;
    let raw: string;
    try {
      response = await doFetch(`${options.host}${path}`, {
        method,
        headers,
        body: payload as BodyInit | undefined,
        redirect: "error",
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      raw = await response.text();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new SpacesError(0, "offline", "Spaces could not be reached.");
    }
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = isObject(body) && isObject(body.error) ? body.error : {};
      const after = Number(response.headers.get("retry-after"));
      throw new SpacesError(
        response.status,
        text(error.code) ?? `http_${response.status}`,
        text(error.message) ?? `Spaces answered ${response.status}.`,
        isObject(error.details) ? error.details : {},
        Number.isFinite(after) && after > 0 ? after : null,
      );
    }
    return { body, headers: response.headers };
  }

  const versionOf = (record: Record<string, unknown>, headers: Headers): string => text(record.version) ?? (headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "");
  const ws = (id: string) => `/v1/workspaces/${segment(id)}`;

  return {
    host: options.host,
    signedIn: token !== null,
    async createSpace(input, imported = {}) {
      const { body } = await call("POST", "/v1/workspaces", { json: { ...input, ...imported } });
      const space = spaceOf(under(body, "workspace"));
      const document = isObject(body) && isObject(body.document) ? body.document : null;
      return { space, document: document && text(document.id) && text(document.version) ? { id: document.id as string, version: document.version as string, url: text(document.file_url) } : null };
    },
    async getSpace(id) {
      return spaceOf(under((await call("GET", ws(id))).body, "workspace"));
    },
    async addPage(spaceId, input, imported = {}) {
      const { body, headers } = await call("POST", `${ws(spaceId)}/documents`, { json: { ...input, ...imported } });
      const document = under(body, "document");
      return { id: text(document.id) ?? "", version: versionOf(document, headers), url: text(document.file_url) };
    },
    // Origin fields ride only on JSON: such a save is the PATCH with the page's text as `body` and no path, so it is
    // never a rename (an actor with a path change is refused). The decoder drops a leading byte-order mark, as the
    // space does. Bytes that are not UTF-8 would change as text: they go as they are, by the raw PUT, with no actor.
    async savePage(spaceId, docId, bytes, kind, ifMatch, imported = {}) {
      const target = `${ws(spaceId)}/documents/${segment(docId)}`;
      const ifMatchHeader = { "If-Match": `"${ifMatch}"` };
      let decoded: string | null = null;
      if (Object.keys(imported).length > 0) {
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          decoded = null;
        }
      }
      const { body, headers } =
        decoded !== null
          ? await call("PATCH", target, { json: { body: decoded, ...imported }, headers: ifMatchHeader })
          : await call("PUT", target, { bytes, headers: { "Content-Type": SPACE_PAGE_MEDIA_TYPE[kind], ...ifMatchHeader } });
      const document = under(body, "document");
      return { version: versionOf(document, headers), url: text(document.file_url) };
    },
    async putFile(spaceId, path, bytes, contentType, title) {
      const query = title ? `?title=${encodeURIComponent(title)}` : "";
      const { body } = await call("PUT", `${ws(spaceId)}/assets/${path.split("/").map(segment).join("/")}${query}`, { bytes, headers: { "Content-Type": contentType || "application/octet-stream" } });
      const asset = under(body, "asset");
      return { id: text(asset.id), content_hash: text(asset.content_hash) };
    },
    async addComment(spaceId, docId, input, key, imported = {}) {
      const { body } = await call("POST", `${ws(spaceId)}/documents/${segment(docId)}/annotations`, { json: { ...input, ...imported }, headers: { "Idempotency-Key": key } });
      return { id: text(under(body, "annotation").id) ?? "" };
    },
    async addReply(spaceId, docId, annotationId, input, key, imported = {}) {
      const { body } = await call("POST", `${ws(spaceId)}/documents/${segment(docId)}/annotations/${segment(annotationId)}/replies`, { json: { ...input, ...imported }, headers: { "Idempotency-Key": key } });
      return { id: text(under(body, "reply").id) ?? "" };
    },
    async claim(spaceId) {
      // No body: the space wants none. A 200 alone says the space is the caller's now (its answer is the space).
      return spaceOf(under((await call("POST", `${ws(spaceId)}/claim`)).body, "workspace"));
    },
    async deleteSpace(spaceId) {
      await call("DELETE", ws(spaceId));
    },
  };
}
