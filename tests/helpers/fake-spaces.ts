/**
 * A small stand-in for the Spaces REST surface "Share this space" calls (packages/shared/spaces/client.ts), for tests
 * and for a sandbox run. Written from the public contract only; it is no copy of the real server, and a test that
 * passes here proves the client's side of that contract, nothing about Spaces itself.
 *
 * In-process: `fetch` answers a request with no socket (unit tests hand it to the client). `listen()` serves the same
 * handler on 127.0.0.1 and nowhere else, for a browser.
 *
 * What it keeps of the contract:
 * - `POST /v1/workspaces` takes a caller's id; the same call again answers the first answer, another call with that
 *   id is `409 workspace_id_conflict`; unknown fields are refused. No credential: a space nobody owns, open to anyone
 *   who holds its id. A credential: the caller's own.
 * - A page's version is the git blob SHA of its text (a leading byte-order mark dropped). `POST …/documents` to a
 *   path that exists is `409 path_conflict`. `PUT …/documents/:id` takes raw bytes whose type matches the kind, and
 *   with `If-Match` answers `412 version_conflict` (`details.current_version`) when the page moved.
 * - `PUT …/assets/<path>` creates or replaces; the same bytes change nothing; a page's extension is refused (422).
 * - A comment's `Idempotency-Key` makes a second post the first comment. Replies go to `…/replies`.
 * - `POST …/claim` gives an ownerless space to the signed-in caller; after it, anyone else's write is refused.
 * - Limits: a page 1,572,864 bytes (HTML 16,000,000), a file and an ownerless space's files 100 MiB (both can be set
 *   small for a test), a comment 8 KiB; without a credential a number of writes a minute, then `429` with
 *   `Retry-After`.
 * - Answers have the service's shapes as seen on its test copy (2026-11-19): `{ workspace, document }` on the
 *   create, every other record bare, a page's version also as a weak `ETag`; the approval is a `PUT`, and a tool's
 *   token gets `403 approval_human_only`.
 * - `/cli/login` and `/cli/token`: the browser sign-in for a tool on this computer, with PKCE.
 */
import { createHash, randomBytes } from "node:crypto";
import { gitBlobSha } from "../../packages/core/plans";

interface FakeVersion {
  version: string;
  body: string;
  by: string | null;
}
interface FakeDoc {
  id: string;
  doc_path: string;
  kind: string;
  title: string;
  versions: FakeVersion[];
}
interface FakeAsset {
  id: string;
  path: string;
  content_type: string;
  hashes: string[];
  size: number;
}
interface FakeComment {
  id: string;
  document_id: string;
  key: string | null;
  body: string;
  anchor: unknown;
  document_version: string | null;
  by: string | null;
  replies: { id: string; key: string | null; body: string; by: string | null }[];
}
export interface FakeSpace {
  id: string;
  name: string;
  owner: string | null;
  /** `private` when made signed in; a space made without an account, kept or not, stays `link_edit`. */
  visibility: string;
  share_url: string;
  documents: FakeDoc[];
  assets: FakeAsset[];
  comments: FakeComment[];
  approvals: { document_id: string; version: string; by: string }[];
  deleted: boolean;
  createBody: string;
  createAnswer: unknown;
}

export interface FakeSpacesCall {
  method: string;
  path: string;
  query: string;
  signedIn: boolean;
  idempotencyKey: string | null;
  ifMatch: string | null;
  status: number;
}

export interface FakeSpacesOptions {
  /** The origin its links name (default `http://127.0.0.1:1`; `listen()` sets its own). */
  origin?: string;
  /** Writes without a credential before a 429 (default: no limit), and the seconds it says to wait. */
  openWrites?: number;
  retryAfter?: number;
  /** The most file bytes an ownerless space holds, and one file's most (defaults: 100 MiB each). */
  openQuota?: number;
  fileMax?: number;
  /** The approval call: `refuse` (as a tool's token is today) or `accept`. */
  approvals?: "refuse" | "accept";
  /** The status a write gets once someone else kept the space (the real code is not settled; default 403). */
  refusal?: 401 | 403 | 404;
  /** `/cli/login` sends the browser straight back with a code (default), or shows a page with an Allow link. */
  login?: "auto" | "page";
}

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const newId = (prefix: string) => `${prefix}_${[...randomBytes(26)].map((b) => ID_ALPHABET[b % 32]).join("")}`;
const PAGE_EXTENSIONS: Record<string, string> = { md: "markdown", markdown: "markdown", html: "html", htm: "html", mmd: "mermaid", mermaid: "mermaid", dot: "graphviz", gv: "graphviz" };
const PAGE_TYPES: Record<string, string> = { markdown: "text/markdown", html: "text/html", mermaid: "text/vnd.mermaid", graphviz: "text/vnd.graphviz" };
const extensionOf = (path: string) => (/\.([^./]+)$/.exec(path)?.[1] ?? "").toLowerCase();
const validPath = (path: unknown): path is string =>
  typeof path === "string" && path.length > 0 && !/[\\?#%\u0000-\u001f\u007f]/.test(path) && path.split("/").every((name) => name.length > 0 && name !== "." && name !== ".." && name.toLowerCase() !== ".git" && new TextEncoder().encode(name).length <= 255);
const versionOf = (body: string) => gitBlobSha(body.replace(/^﻿/, ""));
const pageMax = (kind: string) => (kind === "html" ? 16_000_000 : 1_572_864);

export function createFakeSpaces(options: FakeSpacesOptions = {}) {
  let origin = options.origin ?? "http://127.0.0.1:1";
  const spaces = new Map<string, FakeSpace>();
  const tokens = new Map<string, string>();
  const codes = new Map<string, { challenge: string; name: string }>();
  const calls: FakeSpacesCall[] = [];
  const settings = { ...options };
  let openWrites = 0;
  let windowStart = Date.now();
  /** Faults for the next calls that match: answer with this status and code instead (`after`: do the call first). */
  const faults: { match: (call: { method: string; path: string }) => boolean; status: number; code: string; times: number; details?: Record<string, unknown>; after?: boolean }[] = [];
  let signInAs = "Maya Chen";

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fail = (status: number, code: string, details?: Record<string, unknown>, headers: Record<string, string> = {}) => json(status, { error: { code, message: code.replace(/_/g, " "), ...(details ? { details } : {}) } }, headers);
  const docWire = (space: FakeSpace, doc: FakeDoc) => ({ id: doc.id, workspace_id: space.id, doc_path: doc.doc_path, kind: doc.kind, title: doc.title, version: doc.versions[doc.versions.length - 1]!.version, version_count: doc.versions.length });
  const spaceWire = (space: FakeSpace, user: string | null = null) => ({
    access: space.owner !== null && space.owner === user ? "owner" : "edit",
    id: space.id,
    name: space.name,
    owner_name: space.owner,
    slug: space.id.slice(3, 13).toLowerCase(),
    share_url: space.share_url,
    visibility: space.visibility,
    documents: space.documents.map((d) => docWire(space, d)),
    assets: space.assets.map((a) => ({ id: a.id, path: a.path, content_type: a.content_type, size: a.size, content_hash: a.hashes[a.hashes.length - 1] })),
  });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const auth = request.headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const user = bearer ? (tokens.get(bearer) ?? null) : null;
    const call: FakeSpacesCall = { method, path: url.pathname, query: url.search, signedIn: bearer !== null, idempotencyKey: request.headers.get("idempotency-key"), ifMatch: request.headers.get("if-match"), status: 0 };
    calls.push(call);
    const done = (response: Response) => {
      call.status = response.status;
      return response;
    };
    const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));

    // ── The browser sign-in ──
    if (method === "GET" && url.pathname === "/cli/login") {
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(redirect) || !challenge || !state) return done(new Response("bad sign-in request", { status: 400 }));
      const code = randomBytes(12).toString("hex");
      codes.set(code, { challenge, name: signInAs });
      const back = `${redirect}?code=${code}&state=${encodeURIComponent(state)}`;
      if ((settings.login ?? "auto") === "auto") return done(new Response(null, { status: 302, headers: { Location: back } }));
      return done(new Response(`<!doctype html><title>Stand-in sign-in</title><p>Allow Plannotator?</p><a id="allow" href="${back}">Allow</a>`, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    }
    if (method === "POST" && url.pathname === "/cli/token") {
      const body = (await request.json().catch(() => null)) as { code?: string; code_verifier?: string } | null;
      const held = body?.code ? codes.get(body.code) : undefined;
      const challenge = body?.code_verifier ? createHash("sha256").update(body.code_verifier).digest("base64url") : "";
      if (!held || held.challenge !== challenge) return done(fail(400, "invalid_grant"));
      codes.delete(body!.code!);
      const token = `wscli_live_${randomBytes(18).toString("hex")}`;
      tokens.set(token, held.name);
      return done(json(200, { token, expires_at: null, user: { name: held.name } }));
    }

    if (parts[0] !== "v1") return done(fail(404, "not_found"));
    if (bearer && !user) return done(fail(401, "unauthorized"));
    const fault = faults.find((f) => f.times > 0 && f.match({ method, path: url.pathname }));
    if (fault && !fault.after) {
      fault.times--;
      if (fault.status === 0) throw new TypeError("fetch failed");
      return done(fail(fault.status, fault.code, fault.details, fault.status === 429 ? { "Retry-After": String(settings.retryAfter ?? 10) } : {}));
    }
    const answer = await route(request, url, method, parts, user);
    if (fault?.after && answer.ok) {
      fault.times--;
      // Status 0: the call was done and its answer never arrived.
      if (fault.status === 0) throw new TypeError("fetch failed");
      return done(fail(fault.status, fault.code, fault.details));
    }
    return done(answer);
  }

  async function route(request: Request, url: URL, method: string, parts: string[], user: string | null): Promise<Response> {
    const write = method !== "GET";
    if (write && !user && settings.openWrites !== undefined) {
      // A window as long as the wait it names: after it, the count starts again.
      if (Date.now() - windowStart >= (settings.retryAfter ?? 10) * 1000) {
        windowStart = Date.now();
        openWrites = 0;
      }
      if (++openWrites > settings.openWrites) return fail(429, "rate_limited", undefined, { "Retry-After": String(settings.retryAfter ?? 10) });
    }

    if (parts[1] === "workspaces" && parts.length === 2 && method === "POST") {
      const raw = await request.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return fail(422, "validation_error");
      }
      const unknown = Object.keys(body).find((key) => !["id", "name", "note", "document", "org_id"].includes(key));
      if (unknown) return fail(422, "validation_error", { fields: [unknown] });
      const id = typeof body.id === "string" ? body.id : newId("ws");
      if (!/^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return fail(422, "validation_error", { fields: ["id"] });
      const existing = spaces.get(id);
      if (existing) return existing.createBody === raw && !existing.deleted ? json(201, existing.createAnswer) : fail(409, "workspace_id_conflict");
      const space: FakeSpace = { id, name: typeof body.name === "string" ? body.name.slice(0, 120) : "Untitled", owner: user, visibility: user ? "private" : "link_edit", share_url: `${origin}/s/${id.slice(3, 15).toLowerCase()}`, documents: [], assets: [], comments: [], approvals: [], deleted: false, createBody: raw, createAnswer: null };
      let first: FakeDoc | null = null;
      if (body.document !== null) {
        const d = (body.document ?? {}) as Record<string, unknown>;
        const path = typeof d.path === "string" ? d.path : "plan.md";
        const kind = typeof d.kind === "string" ? d.kind : (PAGE_EXTENSIONS[extensionOf(path)] ?? "markdown");
        const text = typeof d.body === "string" ? d.body : "";
        if (!validPath(path) || !PAGE_TYPES[kind] || ((kind === "mermaid" || kind === "graphviz") && PAGE_EXTENSIONS[extensionOf(path)] !== kind)) return fail(422, "validation_error", { fields: ["document"] });
        if (new TextEncoder().encode(text).length > pageMax(kind)) return fail(422, "validation_error", { fields: ["body"] });
        first = { id: newId("doc"), doc_path: path, kind, title: typeof d.title === "string" ? d.title : path, versions: [{ version: versionOf(text), body: text, by: user }] };
        space.documents.push(first);
      }
      space.createAnswer = { workspace: spaceWire(space), document: first ? docWire(space, first) : null };
      spaces.set(id, space);
      return json(201, space.createAnswer);
    }

    const space = parts[1] === "workspaces" && parts[2] ? spaces.get(parts[2]) : undefined;
    // A space that is not there: without a credential a read is asked to sign in, as the service answers.
    if (!space) return !user && method === "GET" ? fail(401, "login_required") : fail(404, "workspace_not_found");
    if (space.deleted) return fail(410, "workspace_deleted");
    const rest = parts.slice(3);
    if (rest[0] === "claim" && rest.length === 1 && method === "POST") {
      if (!user) return fail(401, "login_required");
      // One winner: a space with another owner is not claimable; your own answers the same again.
      if (space.owner !== null && space.owner !== user) return fail(409, "claim_conflict");
      space.owner = user;
      return json(200, spaceWire(space, user));
    }
    const outsider = space.owner !== null && space.owner !== user;
    if (outsider) {
      const status = settings.refusal ?? 403;
      return fail(status, status === 404 ? "workspace_not_found" : status === 403 ? "forbidden" : "login_required");
    }

    if (rest.length === 0 && method === "GET") return json(200, spaceWire(space, user));
    if (rest.length === 0 && method === "DELETE") {
      if (!space.owner) return fail(403, "forbidden");
      space.deleted = true;
      return json(200, { deleted: true });
    }
    if (rest[0] === "documents" && rest.length === 1 && method === "POST") {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const path = body?.doc_path;
      const kind = String(body?.kind ?? "");
      const text = typeof body?.body === "string" ? body.body : "";
      if (!body || !validPath(path) || !PAGE_TYPES[kind] || PAGE_EXTENSIONS[extensionOf(path)] !== kind) return fail(422, "validation_error", { fields: ["doc_path"] });
      if (new TextEncoder().encode(text).length > pageMax(kind)) return fail(422, "validation_error", { fields: ["body"] });
      if (space.documents.some((d) => d.doc_path === path) || space.assets.some((a) => a.path === path)) return fail(409, "path_conflict", { doc_path: path });
      const doc: FakeDoc = { id: newId("doc"), doc_path: path, kind, title: typeof body.title === "string" ? body.title : path, versions: [{ version: versionOf(text), body: text, by: user }] };
      space.documents.push(doc);
      return json(201, docWire(space, doc), { ETag: `W/"${doc.versions[0]!.version}"` });
    }

    const doc = rest[0] === "documents" && rest[1] ? space.documents.find((d) => d.id === rest[1]) : undefined;
    if (rest[0] === "documents" && rest[1] && !doc) return fail(404, "document_not_found");

    if (doc && rest.length === 2 && method === "PUT") {
      const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (type !== PAGE_TYPES[doc.kind]) return fail(422, "validation_error", { fields: ["content-type"] });
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(await request.arrayBuffer()));
      if (new TextEncoder().encode(text).length > pageMax(doc.kind)) return fail(422, "validation_error", { fields: ["body"] });
      const current = doc.versions[doc.versions.length - 1]!.version;
      const expected = request.headers.get("if-match")?.replace(/^W\//, "").replace(/"/g, "");
      if (expected && expected !== current) return fail(412, "version_conflict", { current_version: current });
      const version = versionOf(text);
      doc.versions.push({ version, body: text.replace(/^﻿/, ""), by: user });
      // A save clears the page's approvals.
      space.approvals = space.approvals.filter((a) => a.document_id !== doc.id);
      return json(200, docWire(space, doc), { ETag: `W/"${version}"` });
    }

    if (doc && rest[2] === "annotations" && rest.length === 3 && method === "POST") {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const key = request.headers.get("idempotency-key")?.trim() || null;
      const usable = key && key.length <= 200 ? key : null;
      if (!body || typeof body.body !== "string" || !body.anchor || typeof body.anchor !== "object") return fail(422, "validation_error", { fields: ["anchor"] });
      if (new TextEncoder().encode(body.body).length > 8 * 1024 || JSON.stringify(body.anchor).length > 16 * 1024) return fail(422, "validation_error", { fields: ["body"] });
      const again = usable ? space.comments.find((c) => c.key === usable) : undefined;
      if (again) return again.document_id === doc.id ? json(200, { id: again.id, document_id: doc.id }) : fail(409, "idempotency_key_conflict");
      const comment: FakeComment = { id: newId("anno"), document_id: doc.id, key: usable, body: body.body, anchor: body.anchor, document_version: typeof body.document_version === "string" ? body.document_version : null, by: user, replies: [] };
      space.comments.push(comment);
      return json(201, { id: comment.id, document_id: doc.id, author: null, author_standing: user ? "member" : "anonymous" });
    }
    if (doc && rest[2] === "annotations" && rest[4] === "replies" && rest.length === 5 && method === "POST") {
      const comment = space.comments.find((c) => c.id === rest[3]);
      if (!comment) return fail(404, "annotation_not_found");
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body.body !== "string") return fail(422, "validation_error", { fields: ["body"] });
      const key = request.headers.get("idempotency-key")?.trim() || null;
      const again = key ? comment.replies.find((r) => r.key === key) : undefined;
      if (again) return json(200, { id: again.id, annotation_id: comment.id });
      const reply = { id: newId("reply"), key, body: body.body, by: user };
      comment.replies.push(reply);
      return json(201, { id: reply.id, annotation_id: comment.id });
    }
    if (doc && rest[2] === "approval" && rest.length === 3 && method === "PUT") {
      if (!user) return fail(401, "login_required");
      // As today: a person only; a tool's token may not approve.
      if ((settings.approvals ?? "refuse") === "refuse") return fail(403, "approval_human_only");
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const current = doc.versions[doc.versions.length - 1]!.version;
      if (body?.version !== current) return fail(409, "approval_version_moved");
      space.approvals.push({ document_id: doc.id, version: current, by: user });
      return json(200, { approval: { version: current } });
    }

    if (rest[0] === "assets" && rest.length >= 2 && method === "PUT") {
      const path = rest.slice(1).join("/");
      if (!validPath(path)) return fail(422, "validation_error", { fields: ["path"] });
      if (PAGE_EXTENSIONS[extensionOf(path)]) return fail(422, "validation_error", { fields: ["path"] });
      if (space.documents.some((d) => d.doc_path === path)) return fail(409, "path_conflict", { doc_path: path });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > (settings.fileMax ?? 104_857_600)) return fail(413, "artifact_too_large", { max_bytes: settings.fileMax ?? 104_857_600 });
      const hash = createHash("sha256").update(bytes).digest("hex");
      const existing = space.assets.find((a) => a.path === path);
      if (existing && existing.hashes[existing.hashes.length - 1] === hash) return json(200, { id: existing.id, path, content_hash: hash, changed: false });
      const quota = space.owner ? 1_073_741_824 : (settings.openQuota ?? 104_857_600);
      const used = space.assets.reduce((n, a) => n + a.size * a.hashes.length, 0);
      if (used + bytes.length > quota) return fail(413, "quota_exceeded", { usage_bytes: used, quota_bytes: quota });
      const asset = existing ?? { id: newId("asset"), path, content_type: request.headers.get("content-type") ?? "application/octet-stream", hashes: [], size: 0 };
      asset.hashes.push(hash);
      asset.size = bytes.length;
      if (!existing) space.assets.push(asset);
      return json(existing ? 200 : 201, { id: asset.id, path, content_hash: hash, changed: true });
    }
    return fail(404, "not_found");
  }

  let server: { stop(force?: boolean): void; port?: number } | null = null;

  return {
    /** Hand this to the client: the stand-in answers with no socket. */
    fetch: ((input: string | URL | Request, init?: RequestInit) => handle(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch,
    get origin() {
      return origin;
    },
    spaces,
    calls,
    settings,
    /** The next `times` calls that match get this answer instead; `after`: the call is done first, then its answer is lost. */
    failNext(match: RegExp | ((call: { method: string; path: string }) => boolean), status: number, code: string, input: { times?: number; details?: Record<string, unknown>; after?: boolean } = {}) {
      faults.push({ match: typeof match === "function" ? match : (call) => match.test(`${call.method} ${call.path}`), status, code, times: input.times ?? 1, details: input.details, after: input.after });
    },
    /** Someone else signs in and keeps the space. */
    keptBy(id: string, name: string) {
      const space = spaces.get(id);
      if (space) space.owner = name;
    },
    /** A page is edited in the space by someone there. */
    editPage(id: string, docPath: string, body: string) {
      const doc = spaces.get(id)?.documents.find((d) => d.doc_path === docPath);
      if (doc) doc.versions.push({ version: versionOf(body), body, by: "someone" });
    },
    /** A token for `name`, as if signed in before. */
    issueToken(name: string) {
      const token = `wscli_live_${randomBytes(18).toString("hex")}`;
      tokens.set(token, name);
      return token;
    },
    revoke(token: string) {
      tokens.delete(token);
    },
    signInAs(name: string) {
      signInAs = name;
    },
    resetWrites() {
      openWrites = 0;
      windowStart = Date.now();
    },
    /** Serve on this computer only; `stop()` ends it. */
    listen(port = 0) {
      const serve = (globalThis as { Bun?: { serve(options: object): { stop(force?: boolean): void; port: number } } }).Bun?.serve;
      if (!serve) throw new Error("listen() needs Bun.");
      const started = serve({ hostname: "127.0.0.1", port, fetch: handle });
      server = started;
      origin = `http://127.0.0.1:${started.port}`;
      return { origin, port: started.port };
    },
    stop() {
      server?.stop(true);
      server = null;
    },
  };
}

export type FakeSpaces = ReturnType<typeof createFakeSpaces>;
