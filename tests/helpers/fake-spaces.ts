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
 * - `POST …/claim` gives an ownerless space to the signed-in caller (its own again: the same answer; another's:
 *   `409 claim_conflict`). A kept space keeps its link: a holder with no account still reads and comments (`201`),
 *   but a page save or a file upload is `403 forbidden`. Made private, every call with no account is
 *   `401 login_required`. A space that expired or was removed is never `410`: with no account `401 login_required`,
 *   signed in `404 workspace_not_found`.
 * - Limits: a page 1,572,864 bytes (HTML 16,000,000), a file and an ownerless space's files 100 MiB (both can be set
 *   small for a test), a comment 8 KiB (its anchor 16 KiB, the whole call 32 KiB, `413`); without a credential a
 *   number of writes a minute, then `429` with `Retry-After`.
 * - The "imported" shape (as landed on the Spaces side, 2026-11-20; read from its report, not run): an `actor`
 *   `{ kind: "imported", at, author_label?, agent_host?, agent_session?, agent_name? }` on the create, a page's JSON
 *   `PATCH` (with `body`; with a path change it is `422 validation_error` on `actor`), a comment and a reply (never
 *   with `mentions`). Allowed while the space has no owner, then only to its owner: else `403 imported_owner_only`.
 *   Read back as `imported: { author_label, agent_host, agent_session, agent_name, at }` with `author: null`,
 *   `author_standing: null` and no `agent` (`GET …/documents/:id/versions` and `…/annotations`). The create takes
 *   `external_key` (1-128 of `A-Za-z0-9_.:-`) with an account only (`422` without), echoed on that answer only. A
 *   key the same account already gave a space answers that space under its own id (`200`; the id sent is not used),
 *   or `409 external_key_conflict` (`details.workspace_id`, `details.org_id`) when the call names another team.
 *   Unknown fields are refused everywhere (`422`), an upload's query included: a file takes no actor.
 * - Answers have the service's shapes as seen on its test copy (2026-11-19): `{ workspace, document }` on the
 *   create, every other record bare, a page's version also as a weak `ETag`; the approval is a `PUT`, and a tool's
 *   token gets `403 approval_human_only`.
 * - `/cli/login`, `/cli/token` and `GET /v1/me`: the browser sign-in for a tool on this computer, with PKCE, as the
 *   service answers it (read from its code by the Spaces side, 2026-11-19). `/cli/login` needs all of `redirect_uri`
 *   (`http`, host `127.0.0.1` or `[::1]`, an explicit port; `localhost` is refused), `state`, `code_challenge` and
 *   `code_challenge_method=S256`. `/cli/token` takes a form body only (anything else, JSON included, is `415`) with
 *   `grant_type=authorization_code`, `code`, the same `redirect_uri` byte for byte and `code_verifier`; its errors are
 *   `{ "error": "<words>" }`. A code lives 120 seconds and is spent on its first lookup, so a second exchange with it
 *   always fails. The answer is `{ access_token, token_type, expires_at }` with no name: the name is `GET /v1/me`'s.
 * - The "tool connect" page on `/cli/login` (names as built on the Spaces side, 2026-11-20; run against its test copy
 *   in T14f): `client_name` (a name it does not know is `400`), `space` and `approve_document` + `approve_version`.
 *   A `space` the person may claim when the page is drawn (no owner, or theirs) makes it the "becomes your space"
 *   page: the press claims it and records the approval (`moved`: the page is at another version there); taken by
 *   someone else between the drawing and the press, the way back is `error=claim_conflict&state` with no code. A
 *   space someone else owns when the page is drawn (or one it does not hold) gets the plain connect page: the press
 *   only signs in (no claim, nothing approved), and the tool's own claim then answers `409 claim_conflict`.
 *   `approval=recorded|moved|none` is on a way back with a code whenever an approval was asked (`approve_document` +
 *   `approve_version` sent), whether or not the space line was drawn: `none` when nothing was recorded. It is absent
 *   only when no approval was asked. Cancel sends back
 *   `error=access_denied&state` only when `client_name` was sent; without it, Cancel is a link to the site's home and
 *   nothing comes back. Not from the contract: a `space` it does not hold claims nothing (and its approval is `none`).
 */
import { createHash, randomBytes } from "node:crypto";
import { gitBlobSha } from "../../packages/core/plans";

/** The `imported` a record is read back with: the actor's fields, each null when not sent. */
export interface FakeImported {
  author_label: string | null;
  agent_host: string | null;
  agent_session: string | null;
  agent_name: string | null;
  at: string;
}
interface FakeVersion {
  version: string;
  body: string;
  by: string | null;
  imported?: FakeImported | null;
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
  imported: FakeImported | null;
  replies: { id: string; key: string | null; body: string; by: string | null; imported: FakeImported | null }[];
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
  external_key: string | null;
  org_id: string | null;
}

export interface FakeSpacesCall {
  method: string;
  path: string;
  query: string;
  signedIn: boolean;
  idempotencyKey: string | null;
  ifMatch: string | null;
  /** The JSON body as sent, when it was JSON. */
  json: unknown;
  status: number;
  /** The error's code, when it answered one. */
  code: string | null;
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
  /** `GET /v1/me` answers `name: null` (an account with no display name). */
  nameless?: boolean;
  /** `/cli/login` sends the browser straight back (default), or shows a page with Allow and Cancel links. */
  login?: "auto" | "page";
  /** What the person presses on the page when `login` is `auto`: Allow (default) or Cancel. */
  consent?: "allow" | "cancel";
}

/** The tool names the connect page knows. */
const CLIENT_NAMES = new Set(["Plannotator"]);

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const newId = (prefix: string) => `${prefix}_${[...randomBytes(26)].map((b) => ID_ALPHABET[b % 32]).join("")}`;
const PAGE_EXTENSIONS: Record<string, string> = { md: "markdown", markdown: "markdown", html: "html", htm: "html", mmd: "mermaid", mermaid: "mermaid", dot: "graphviz", gv: "graphviz" };
const PAGE_TYPES: Record<string, string> = { markdown: "text/markdown", html: "text/html", mermaid: "text/vnd.mermaid", graphviz: "text/vnd.graphviz" };
const extensionOf = (path: string) => (/\.([^./]+)$/.exec(path)?.[1] ?? "").toLowerCase();
const validPath = (path: unknown): path is string =>
  typeof path === "string" && path.length > 0 && !/[\\?#%\u0000-\u001f\u007f]/.test(path) && path.split("/").every((name) => name.length > 0 && name !== "." && name !== ".." && name.toLowerCase() !== ".git" && new TextEncoder().encode(name).length <= 255);
const versionOf = (body: string) => gitBlobSha(body.replace(/^﻿/, ""));
const pageMax = (kind: string) => (kind === "html" ? 16_000_000 : 1_572_864);
const ACTOR_KEYS = ["kind", "at", "author_label", "agent_host", "agent_session", "agent_name"];
const EXTERNAL_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
/** An `actor` as sent: absent (undefined), the imported fields, or refused (null). */
function actorOf(value: unknown): FakeImported | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const actor = value as Record<string, unknown>;
  if (actor.kind !== "imported" || typeof actor.at !== "string" || Number.isNaN(Date.parse(actor.at))) return null;
  if (Object.keys(actor).some((key) => !ACTOR_KEYS.includes(key))) return null;
  const field = (key: string) => (typeof actor[key] === "string" ? (actor[key] as string) : null);
  return { author_label: field("author_label"), agent_host: field("agent_host"), agent_session: field("agent_session"), agent_name: field("agent_name"), at: actor.at };
}
/** How a comment or reply reads back: an imported one names no author. */
const authorWire = (record: { by: string | null; imported: FakeImported | null }) =>
  record.imported ? { imported: record.imported, author: null, author_standing: null } : { author: record.by ? { name: record.by } : null, author_standing: record.by ? "member" : "anonymous" };
/** A PKCE verifier or challenge: 43 to 128 of these characters. */
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
/** The way back to a tool: plain http to this computer's loopback address, an explicit port, any path. */
const loopbackRedirect = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]") && /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+(\/|$)/.test(value);
  } catch {
    return false;
  }
};

export function createFakeSpaces(options: FakeSpacesOptions = {}) {
  let origin = options.origin ?? "http://127.0.0.1:1";
  const spaces = new Map<string, FakeSpace>();
  /** Per account and key, the space it names. */
  const keys = new Map<string, string>();
  const tokens = new Map<string, string>();
  const codes = new Map<string, { challenge: string; redirect: string; name: string; until: number }>();
  /** Every `/cli/token` body as it came (tests check what was sent, and that it was sent once). */
  const exchanges: { contentType: string; body: string; origin: string | null; cookie: string | null; authorization: string | null }[] = [];
  const calls: FakeSpacesCall[] = [];
  const settings = { ...options };
  let openWrites = 0;
  let windowStart = Date.now();
  /** Faults for the next calls that match: answer with this status and code instead (`after`: do the call first). */
  const faults: { match: (call: { method: string; path: string }) => boolean; status: number; code: string; times: number; details?: Record<string, unknown>; after?: boolean }[] = [];
  let signInAs = "Maya Chen";

  type FakeLogin = { challenge: string; redirect: string; state: string; clientName: string | null; space: string | null; approveDocument: string | null; approveVersion: string | null; claimable: boolean };
  /** Pages shown (`login: "page"`), waiting for Allow or Cancel. */
  const pressing = new Map<string, FakeLogin>();
  /** A space the page may claim for the person when it is drawn: no owner yet, or theirs. */
  const claimableAtDraw = (id: string | null) => {
    const space = id ? spaces.get(id) : undefined;
    return !!space && !space.deleted && (space.owner === null || space.owner === signInAs);
  };
  /**
   * Allow pressed. A page drawn for a space it may claim: the claim, the approval sent with it, then back with a code
   * (or the claim lost, when someone else took it since). A page drawn for a space someone else owns: a code only.
   */
  function press(login: FakeLogin): string {
    const back = new URL(login.redirect);
    const space = login.space && login.claimable ? spaces.get(login.space) : undefined;
    const held = space && !space.deleted ? space : undefined;
    if (held && held.owner !== null && held.owner !== signInAs) {
      back.searchParams.set("error", "claim_conflict");
      back.searchParams.set("state", login.state);
      return back.toString();
    }
    if (held) held.owner = signInAs;
    const code = randomBytes(12).toString("hex");
    codes.set(code, { challenge: login.challenge, redirect: login.redirect, name: signInAs, until: Date.now() + 120_000 });
    back.searchParams.set("code", code);
    back.searchParams.set("state", login.state);
    if (login.approveDocument !== null && login.approveVersion !== null) {
      // Asked: always answered, `none` when the page recorded nothing (no space line, or no such page there).
      const doc = held?.documents.find((d) => d.id === login.approveDocument);
      const current = doc?.versions[doc.versions.length - 1]?.version;
      let approval = "none";
      if (held && doc && current) {
        if (current !== login.approveVersion) approval = "moved";
        else {
          approval = "recorded";
          if (!held.approvals.some((a) => a.document_id === doc.id && a.version === current && a.by === signInAs)) held.approvals.push({ document_id: doc.id, version: current, by: signInAs });
        }
      }
      back.searchParams.set("approval", approval);
    }
    return back.toString();
  }
  /** Cancel pressed: back with `access_denied` only for a tool that named itself; else the site's home. */
  function cancelled(login: FakeLogin): string {
    if (login.clientName === null) return `${origin}/`;
    const back = new URL(login.redirect);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", login.state);
    return back.toString();
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fail = (status: number, code: string, details?: Record<string, unknown>, headers: Record<string, string> = {}) => json(status, { error: { code, message: code.replace(/_/g, " "), ...(details ? { details } : {}) } }, headers);
  const docWire = (space: FakeSpace, doc: FakeDoc) => ({ file_url: `${space.share_url}/${doc.doc_path.split("/").map(encodeURIComponent).join("/")}@${doc.versions[doc.versions.length - 1]!.version}`, id: doc.id, workspace_id: space.id, doc_path: doc.doc_path, kind: doc.kind, title: doc.title, version: doc.versions[doc.versions.length - 1]!.version, version_count: doc.versions.length });
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

  const callOf = new WeakMap<Request, FakeSpacesCall>();
  /** Every answer, with its error's code kept on the call. */
  async function handle(request: Request): Promise<Response> {
    const response = await respond(request);
    const call = callOf.get(request);
    if (call && !response.ok && (response.headers.get("content-type") ?? "").startsWith("application/json")) {
      const body = (await response.clone().json().catch(() => null)) as { error?: { code?: unknown } } | null;
      call.code = typeof body?.error?.code === "string" ? body.error.code : null;
    }
    return response;
  }

  async function respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const auth = request.headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const user = bearer ? (tokens.get(bearer) ?? null) : null;
    let sent: unknown = null;
    if ((request.headers.get("content-type") ?? "").startsWith("application/json")) sent = await request.clone().json().catch(() => null);
    const call: FakeSpacesCall = { method, path: url.pathname, query: url.search, signedIn: bearer !== null, idempotencyKey: request.headers.get("idempotency-key"), ifMatch: request.headers.get("if-match"), json: sent, status: 0, code: null };
    calls.push(call);
    callOf.set(request, call);
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
      if (!loopbackRedirect(redirect) || !PKCE_VALUE.test(challenge) || !state || url.searchParams.get("code_challenge_method") !== "S256") return done(new Response("bad sign-in request", { status: 400 }));
      const clientName = url.searchParams.get("client_name");
      if (clientName !== null && !CLIENT_NAMES.has(clientName)) return done(new Response("unknown client_name", { status: 400 }));
      const login = { challenge, redirect, state, clientName, space: url.searchParams.get("space"), approveDocument: url.searchParams.get("approve_document"), approveVersion: url.searchParams.get("approve_version"), claimable: claimableAtDraw(url.searchParams.get("space")) };
      if ((settings.login ?? "auto") === "auto") return done(new Response(null, { status: 302, headers: { Location: (settings.consent ?? "allow") === "allow" ? press(login) : cancelled(login) } }));
      const ticket = randomBytes(12).toString("hex");
      pressing.set(ticket, login);
      return done(new Response(`<!doctype html><title>Stand-in sign-in</title><p>Connect Plannotator?</p><a id="allow" href="/cli/login/allow?ticket=${ticket}">Allow</a> <a id="cancel" href="/cli/login/cancel?ticket=${ticket}">Cancel</a>`, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    }
    if (method === "GET" && (url.pathname === "/cli/login/allow" || url.pathname === "/cli/login/cancel")) {
      const login = pressing.get(url.searchParams.get("ticket") ?? "");
      if (!login) return done(new Response("not found", { status: 404 }));
      pressing.delete(url.searchParams.get("ticket")!);
      return done(new Response(null, { status: 302, headers: { Location: url.pathname.endsWith("/allow") ? press(login) : cancelled(login) } }));
    }
    if (method === "POST" && url.pathname === "/cli/token") {
      const plain = (status: number, error: string) => done(json(status, { error }));
      const contentType = request.headers.get("content-type") ?? "";
      const raw = await request.text();
      exchanges.push({ contentType, body: raw, origin: request.headers.get("origin"), cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization") });
      const site = request.headers.get("sec-fetch-site");
      if (request.headers.get("cookie") && (site === "cross-site" || site === "same-site" || request.headers.get("origin") === "null")) return plain(403, "cross-site token exchange refused");
      if (contentType.split(";")[0]!.trim().toLowerCase() !== "application/x-www-form-urlencoded") return plain(415, "token exchange requires form data");
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") !== "authorization_code") return plain(400, "unsupported grant_type");
      const code = form.get("code") ?? "";
      const redirect = form.get("redirect_uri") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      if (!code || !redirect || !PKCE_VALUE.test(verifier)) return plain(400, "invalid authorization code exchange");
      // Spent on its first lookup, whatever comes of it.
      const held = codes.get(code);
      codes.delete(code);
      if (!held || held.until < Date.now() || held.redirect !== redirect || held.challenge !== createHash("sha256").update(verifier).digest("base64url")) return plain(400, "invalid authorization code");
      const token = `wscli_live_${randomBytes(18).toString("hex")}`;
      tokens.set(token, held.name);
      return done(json(200, { access_token: token, token_type: "Bearer", expires_at: null }));
    }

    if (parts[0] !== "v1") return done(fail(404, "not_found"));
    if (bearer && !user) return done(fail(401, "unauthorized"));
    const fault = faults.find((f) => f.times > 0 && f.match({ method, path: url.pathname }));
    if (fault && !fault.after) {
      fault.times--;
      if (fault.status === 0) throw new TypeError("fetch failed");
      return done(fail(fault.status, fault.code, fault.details, fault.status === 429 ? { "Retry-After": String(settings.retryAfter ?? 10) } : {}));
    }
    if (method === "GET" && url.pathname === "/v1/me") {
      if (!user) return done(fail(401, "login_required"));
      // For a CLI token `email` and `provider` are null, and `name` may be null too (an account with no display name).
      return done(json(200, { user_id: `usr_${createHash("sha256").update(user).digest("hex").slice(0, 16)}`, email: null, name: settings.nameless ? null : user, memberships: [], auth_type: "cli_token", provider: null, assignee: null }));
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
      const unknown = Object.keys(body).find((key) => !["id", "name", "note", "document", "org_id", "external_key", "actor"].includes(key));
      if (unknown) return fail(422, "validation_error", { fields: [unknown] });
      const actor = actorOf(body.actor);
      if (actor === null) return fail(422, "validation_error", { fields: ["actor"] });
      if (body.external_key !== undefined && (typeof body.external_key !== "string" || !EXTERNAL_KEY.test(body.external_key))) return fail(422, "validation_error", { fields: ["external_key"] });
      // A key names a space of an account: with none it is refused.
      if (body.external_key !== undefined && !user) return fail(422, "validation_error", { fields: ["external_key"] });
      const id = typeof body.id === "string" ? body.id : newId("ws");
      if (!/^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return fail(422, "validation_error", { fields: ["id"] });
      const existing = spaces.get(id);
      if (existing) return existing.createBody === raw && !existing.deleted ? json(201, existing.createAnswer) : fail(409, "workspace_id_conflict");
      const orgId = typeof body.org_id === "string" ? body.org_id : null;
      const keyed = user && typeof body.external_key === "string" ? spaces.get(keys.get(`${user}\n${body.external_key}`) ?? "") : undefined;
      if (keyed && !keyed.deleted) {
        if (keyed.org_id !== orgId) return fail(409, "external_key_conflict", { workspace_id: keyed.id, org_id: keyed.org_id });
        const page = keyed.documents[0];
        return json(200, { workspace: { ...spaceWire(keyed), external_key: keyed.external_key }, document: page ? docWire(keyed, page) : null });
      }
      const space: FakeSpace = { id, name: typeof body.name === "string" ? body.name.slice(0, 120) : "Untitled", owner: user, visibility: user ? "private" : "link_edit", share_url: `${origin}/s/${id.slice(3, 15).toLowerCase()}`, documents: [], assets: [], comments: [], approvals: [], deleted: false, createBody: raw, createAnswer: null, external_key: typeof body.external_key === "string" ? body.external_key : null, org_id: orgId };
      let first: FakeDoc | null = null;
      if (body.document !== null) {
        const d = (body.document ?? {}) as Record<string, unknown>;
        const path = typeof d.path === "string" ? d.path : "plan.md";
        const kind = typeof d.kind === "string" ? d.kind : (PAGE_EXTENSIONS[extensionOf(path)] ?? "markdown");
        const text = typeof d.body === "string" ? d.body : "";
        if (!validPath(path) || !PAGE_TYPES[kind] || ((kind === "mermaid" || kind === "graphviz") && PAGE_EXTENSIONS[extensionOf(path)] !== kind)) return fail(422, "validation_error", { fields: ["document"] });
        if (new TextEncoder().encode(text).length > pageMax(kind)) return fail(422, "validation_error", { fields: ["body"] });
        first = { id: newId("doc"), doc_path: path, kind, title: typeof d.title === "string" ? d.title : path, versions: [{ version: versionOf(text), body: text, by: user, imported: actor ?? null }] };
        space.documents.push(first);
      }
      // The key is echoed on this answer only.
      space.createAnswer = { workspace: { ...spaceWire(space), ...(space.external_key ? { external_key: space.external_key } : {}) }, document: first ? docWire(space, first) : null };
      spaces.set(id, space);
      if (user && space.external_key) keys.set(`${user}\n${space.external_key}`, id);
      return json(201, space.createAnswer);
    }

    const space = parts[1] === "workspaces" && parts[2] ? spaces.get(parts[2]) : undefined;
    // A space that is not there, or was removed (never a 410): with no account every read and write is asked to
    // sign in; signed in, it is not found.
    if (!space || space.deleted) return user ? fail(404, "workspace_not_found") : fail(401, "login_required");
    const rest = parts.slice(3);
    if (rest[0] === "claim" && rest.length === 1 && method === "POST") {
      if (!user) return fail(401, "login_required");
      // One winner: a space with another owner is not claimable; your own answers the same again.
      if (space.owner !== null && space.owner !== user) return fail(409, "claim_conflict");
      space.owner = user;
      return json(200, spaceWire(space, user));
    }
    // Someone else's space. Made private: no account is asked to sign in, another account does not find it. Kept
    // with its link still open: holders of the link read and comment, and a page save or a file upload is not allowed
    // (`403 forbidden`: they may not edit at all, imported or not). A comment they may write, but not an imported one
    // (`403 imported_owner_only`, below).
    const outsider = space.owner !== null && space.owner !== user;
    if (outsider && space.visibility === "private") return user ? fail(404, "workspace_not_found") : fail(401, "login_required");
    if (outsider && method !== "GET" && !(rest[0] === "documents" && rest[2] === "annotations")) return fail(403, "forbidden");
    /** An imported record may be written while the space has no owner, then by its owner only. */
    const importedRefused = () => (space.owner !== null && space.owner !== user ? fail(403, "imported_owner_only") : null);

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
      const unknown = Object.keys(body).find((key) => !["doc_path", "kind", "body", "title", "actor"].includes(key));
      if (unknown) return fail(422, "validation_error", { fields: [unknown] });
      const actor = actorOf(body.actor);
      if (actor === null) return fail(422, "validation_error", { fields: ["actor"] });
      if (actor) {
        const refused = importedRefused();
        if (refused) return refused;
      }
      if (new TextEncoder().encode(text).length > pageMax(kind)) return fail(422, "validation_error", { fields: ["body"] });
      if (space.documents.some((d) => d.doc_path === path) || space.assets.some((a) => a.path === path)) return fail(409, "path_conflict", { doc_path: path });
      const doc: FakeDoc = { id: newId("doc"), doc_path: path, kind, title: typeof body.title === "string" ? body.title : path, versions: [{ version: versionOf(text), body: text, by: user, imported: actor ?? null }] };
      space.documents.push(doc);
      return json(201, docWire(space, doc), { ETag: `W/"${doc.versions[0]!.version}"` });
    }

    const doc = rest[0] === "documents" && rest[1] ? space.documents.find((d) => d.id === rest[1]) : undefined;
    if (rest[0] === "documents" && rest[1] && !doc) return fail(404, "document_not_found");

    if (doc && rest.length === 2 && method === "PATCH") {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return fail(422, "validation_error");
      const unknown = Object.keys(body).find((key) => !["body", "doc_path", "title", "actor"].includes(key));
      if (unknown) return fail(422, "validation_error", { fields: [unknown] });
      const actor = actorOf(body.actor);
      if (actor === null) return fail(422, "validation_error", { fields: ["actor"] });
      if (actor) {
        if (typeof body.body !== "string") return fail(422, "validation_error", { fields: ["body"] });
        // The same path again is no change; another path with an actor is refused.
        if (body.doc_path !== undefined && body.doc_path !== doc.doc_path) return fail(422, "validation_error", { fields: ["actor"] });
        const refused = importedRefused();
        if (refused) return refused;
      }
      if (body.doc_path !== undefined && (!validPath(body.doc_path) || PAGE_EXTENSIONS[extensionOf(body.doc_path)] !== doc.kind)) return fail(422, "validation_error", { fields: ["doc_path"] });
      if (typeof body.body === "string" && new TextEncoder().encode(body.body).length > pageMax(doc.kind)) return fail(422, "validation_error", { fields: ["body"] });
      const current = doc.versions[doc.versions.length - 1]!.version;
      const expected = request.headers.get("if-match")?.replace(/^W\//, "").replace(/"/g, "");
      if (expected && expected !== current) return fail(412, "version_conflict", { current_version: current });
      if (typeof body.doc_path === "string") doc.doc_path = body.doc_path;
      if (typeof body.title === "string") doc.title = body.title;
      if (typeof body.body === "string") {
        const text = body.body.replace(/^\uFEFF/, "");
        doc.versions.push({ version: versionOf(text), body: text, by: user, imported: actor ?? null });
        space.approvals = space.approvals.filter((a) => a.document_id !== doc.id);
      }
      const version = doc.versions[doc.versions.length - 1]!.version;
      return json(200, docWire(space, doc), { ETag: `W/"${version}"` });
    }
    if (doc && rest[2] === "versions" && rest.length === 3 && method === "GET") {
      return json(200, { versions: doc.versions.map((v, i) => ({ version: v.version, version_number: i + 1, ...(v.imported ? { imported: v.imported, author: null } : { author: v.by ? { name: v.by } : null }) })) });
    }
    if (doc && rest[2] === "annotations" && rest.length === 3 && method === "GET") {
      return json(200, { annotations: space.comments.filter((c) => c.document_id === doc.id).map((c) => ({ id: c.id, document_id: doc.id, body: c.body, anchor: c.anchor, ...authorWire(c), replies: c.replies.map((r) => ({ id: r.id, annotation_id: c.id, body: r.body, ...authorWire(r) })) })) });
    }

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
      const unknown = Object.keys(body).find((key) => !["anchor", "body", "attachments", "mentions", "supersedes", "document_version", "author", "actor"].includes(key));
      if (unknown) return fail(422, "validation_error", { fields: [unknown] });
      const actor = actorOf(body.actor);
      if (actor === null || (actor && body.mentions !== undefined)) return fail(422, "validation_error", { fields: ["actor"] });
      if (actor) {
        const refused = importedRefused();
        if (refused) return refused;
      }
      if (new TextEncoder().encode(body.body).length > 8 * 1024 || new TextEncoder().encode(JSON.stringify(body.anchor)).length > 16 * 1024) return fail(422, "validation_error", { fields: ["body"] });
      if (new TextEncoder().encode(JSON.stringify(body)).length > 32 * 1024) return fail(413, "payload_too_large");
      const again = usable ? space.comments.find((c) => c.key === usable) : undefined;
      // The same key on another target is refused; a reply's key shares the space's keys.
      if (usable && space.comments.some((c) => c.replies.some((r) => r.key === usable))) return fail(422, "validation_error", { fields: { "Idempotency-Key": "already used on another target" } });
      if (again) return again.document_id === doc.id ? json(200, { id: again.id, document_id: doc.id }) : fail(422, "validation_error", { fields: { "Idempotency-Key": "already used on another target" } });
      const comment: FakeComment = { id: newId("anno"), document_id: doc.id, key: usable, body: body.body, anchor: body.anchor, document_version: typeof body.document_version === "string" ? body.document_version : null, by: user, imported: actor ?? null, replies: [] };
      space.comments.push(comment);
      return json(201, { id: comment.id, document_id: doc.id, ...authorWire(comment) });
    }
    if (doc && rest[2] === "annotations" && rest[4] === "replies" && rest.length === 5 && method === "POST") {
      const comment = space.comments.find((c) => c.id === rest[3]);
      if (!comment) return fail(404, "annotation_not_found");
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body.body !== "string") return fail(422, "validation_error", { fields: ["body"] });
      const unknown = Object.keys(body).find((key) => !["body", "mentions", "author", "actor"].includes(key));
      if (unknown) return fail(422, "validation_error", { fields: [unknown] });
      const actor = actorOf(body.actor);
      if (actor === null || (actor && body.mentions !== undefined)) return fail(422, "validation_error", { fields: ["actor"] });
      if (actor) {
        const refused = importedRefused();
        if (refused) return refused;
      }
      const sent = request.headers.get("idempotency-key")?.trim() || null;
      // A key over 200 characters is ignored, not refused.
      const key = sent && sent.length <= 200 ? sent : null;
      const again = key ? comment.replies.find((r) => r.key === key) : undefined;
      if (again) return json(200, { id: again.id, annotation_id: comment.id });
      if (key && (space.comments.some((c) => c.key === key) || space.comments.some((c) => c !== comment && c.replies.some((r) => r.key === key)))) return fail(422, "validation_error", { fields: { "Idempotency-Key": "already used on another target" } });
      const reply = { id: newId("reply"), key, body: body.body, by: user, imported: actor ?? null };
      comment.replies.push(reply);
      return json(201, { id: reply.id, annotation_id: comment.id, ...authorWire(reply) });
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
      // Only `?title=`: an upload takes no actor, nor anything else.
      const extra = [...url.searchParams.keys()].find((key) => key !== "title");
      if (extra) return fail(422, "validation_error", { fields: [extra] });
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
    exchanges,
    settings,
    /** The next `times` calls that match get this answer instead; `after`: the call is done first, then its answer is lost. */
    failNext(match: RegExp | ((call: { method: string; path: string }) => boolean), status: number, code: string, input: { times?: number; details?: Record<string, unknown>; after?: boolean } = {}) {
      faults.push({ match: typeof match === "function" ? match : (call) => match.test(`${call.method} ${call.path}`), status, code, times: input.times ?? 1, details: input.details, after: input.after });
    },
    /** Someone else signs in and keeps the space; `makePrivate`: and then closes its link. */
    keptBy(id: string, name: string, makePrivate = false) {
      const space = spaces.get(id);
      if (!space) return;
      space.owner = name;
      if (makePrivate) space.visibility = "private";
    },
    /** The space expires or is removed. */
    remove(id: string) {
      const space = spaces.get(id);
      if (space) space.deleted = true;
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
