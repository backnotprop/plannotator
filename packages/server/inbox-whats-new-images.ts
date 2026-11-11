/**
 * The window's CSP stays `img-src 'self' data: blob:`, so the Inbox copies release images once and serves them itself. Only https hosts that release attachments use are fetched; redirects are followed by hand, at most 5. A failed image is left out and never fails the notes.
 * PLANNOTATOR_UPDATE_API_URL at a loopback http origin also allows that origin's images (tests use a fake GitHub).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES, MAX_REVIEW_IMAGE_PREVIEW_PIXELS } from "@plannotator/shared/diff-paths";
import { inboxMessageRemoteImageRefsInOrder } from "@plannotator/shared/inbox/message-images";
import { isLfsPointer, readImageDimensions, sniffImageContentType } from "@plannotator/shared/review-image";
import {
  RELEASE_ASSETS_FETCH_INTERVAL_MS,
  RELEASE_ASSETS_FETCH_RETRY_MS,
  RELEASE_NOTES_PENDING_RETRY_MS,
  hasReleaseNotesContent,
  normalizeStableVersion,
  patchUpdateState,
  readReleaseNotes,
  readUpdateState,
  updateCheckPaths,
  updateLog,
  type UpdateState,
} from "@plannotator/shared/update-check";

export const RELEASE_IMAGES_MAX = 12;
export const RELEASE_IMAGE_TIMEOUT_MS = 15_000;
/** Redirects one image may take, each to an allowed host. */
export const RELEASE_IMAGE_REDIRECTS_MAX = 5;
export const RELEASE_IMAGE_SRC_MAX = 2048;

const REPO_RAW_PREFIX = "/backnotprop/plannotator/";
/** The githubusercontent hosts release attachments use (user-attachments redirects to the first). */
const IMAGE_HOSTS = new Set(["private-user-images.githubusercontent.com", "user-images.githubusercontent.com"]);
const USER_AGENT = "plannotator-update-check";
const FETCH_REMEMBERED = 10;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/svg+xml": "svg",
};
export const RELEASE_IMAGE_FILE_RE = /^([0-9a-f]{64})\.(png|jpg|gif|webp|avif|bmp|ico|svg)$/;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function loopbackOverrideOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = env.PLANNOTATOR_UPDATE_API_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.username || url.password || !isLoopbackHost(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function allowedReleaseImageUrl(raw: string | URL, env: NodeJS.ProcessEnv = process.env): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const override = loopbackOverrideOrigin(env);
  if (override && url.origin === override) return url;
  if (url.protocol !== "https:" || url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  // No empty label (`.githubusercontent.com`, `a..b`) and no trailing dot.
  if (host.split(".").some((label) => label === "")) return null;
  if (host === "github.com") return url.pathname.startsWith("/user-attachments/assets/") ? url : null;
  if (host === "raw.githubusercontent.com") return url.pathname.startsWith(REPO_RAW_PREFIX) ? url : null;
  // Where release attachments are served from; never gist., objects., camo. or any other subdomain.
  if (IMAGE_HOSTS.has(host)) return url;
  return null;
}

export function releaseImageSources(notes: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return inboxMessageRemoteImageRefsInOrder(notes)
    .filter((src) => src.length <= RELEASE_IMAGE_SRC_MAX && allowedReleaseImageUrl(src, env) !== null)
    .slice(0, RELEASE_IMAGES_MAX);
}


export interface ReleaseImageEntry {
  file: string;
  content_type: string;
  bytes: number;
  width?: number;
  height?: number;
}

interface ReleaseImagesManifest {
  v: 1;
  images: Record<string, ReleaseImageEntry>;
}

export function releaseImagesDir(version: string, dataDir?: string): string | null {
  const v = normalizeStableVersion(version);
  return v ? join(updateCheckPaths(dataDir).notes, v) : null;
}

export function readReleaseImages(version: string, dataDir?: string): Record<string, ReleaseImageEntry> {
  const dir = releaseImagesDir(version, dataDir);
  if (!dir) return {};
  try {
    const raw = JSON.parse(readFileSync(join(dir, "images.json"), "utf-8")) as Partial<ReleaseImagesManifest>;
    const out: Record<string, ReleaseImageEntry> = {};
    if (!raw || typeof raw.images !== "object" || raw.images === null) return out;
    for (const [src, entry] of Object.entries(raw.images)) {
      if (!entry || typeof entry.file !== "string" || !RELEASE_IMAGE_FILE_RE.test(entry.file)) continue;
      if (typeof entry.content_type !== "string" || typeof entry.bytes !== "number") continue;
      out[src] = {
        file: entry.file,
        content_type: entry.content_type,
        bytes: entry.bytes,
        ...(typeof entry.width === "number" && typeof entry.height === "number" ? { width: entry.width, height: entry.height } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

export function storedReleaseImageSources(version: string, notes: string, dataDir?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = releaseImagesDir(version, dataDir);
  if (!dir) return [];
  const stored = readReleaseImages(version, dataDir);
  return releaseImageSources(notes, env).filter((src) => {
    const entry = stored[src];
    return !!entry && existsSync(join(dir, entry.file));
  });
}


export type FetchedReleaseImage =
  | { ok: true; bytes: Uint8Array; contentType: string; width?: number; height?: number }
  | { ok: false; error: string };

export interface FetchReleaseImageOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  maxPixels?: number;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export async function fetchReleaseImage(src: string, options: FetchReleaseImageOptions = {}): Promise<FetchedReleaseImage> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_REVIEW_IMAGE_PREVIEW_BYTES;
  const maxPixels = options.maxPixels ?? MAX_REVIEW_IMAGE_PREVIEW_PIXELS;
  let url = allowedReleaseImageUrl(src, env);
  if (!url) return { ok: false, error: "not on the allowed hosts" };
  const signal = AbortSignal.timeout(options.timeoutMs ?? RELEASE_IMAGE_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: { accept: "image/*", "user-agent": USER_AGENT },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location) return { ok: false, error: `HTTP ${res.status} without a location` };
        if (hop >= RELEASE_IMAGE_REDIRECTS_MAX) return { ok: false, error: "too many redirects" };
        let next: URL | null = null;
        try {
          next = allowedReleaseImageUrl(new URL(location, url), env);
        } catch {}
        if (!next) return { ok: false, error: "redirected off the allowed hosts" };
        url = next;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, error: "larger than 10 MB" };
      }
      const bytes = await readCapped(res, maxBytes);
      if (!bytes) return { ok: false, error: "larger than 10 MB" };
      const contentType = sniffImageContentType(bytes);
      if (!contentType || isLfsPointer(bytes) || !EXTENSIONS[contentType]) return { ok: false, error: "not an image" };
      const dims = readImageDimensions(bytes, contentType);
      if (dims && dims.width * dims.height > maxPixels) return { ok: false, error: "more than 50 megapixels" };
      return { ok: true, bytes, contentType, ...(dims ? { width: dims.width, height: dims.height } : {}) };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}


type FetchRecord = NonNullable<UpdateState["releaseImagesFetch"]>[string];

/** Once, then no sooner than 6 h after a failure or 24 h after an answer (the notes' rule); a claim its process abandoned mid-fetch waits 15 minutes. */
export function isReleaseImagesFetchDue(state: UpdateState, version: string, now: number): boolean {
  const record = state.releaseImagesFetch?.[version];
  const at = record?.attemptedAt;
  if (!record || typeof at !== "number" || !Number.isFinite(at) || at > now) return true;
  const wait = record.failedAt
    ? RELEASE_ASSETS_FETCH_RETRY_MS
    : record.inFlight
      ? RELEASE_NOTES_PENDING_RETRY_MS
      : RELEASE_ASSETS_FETCH_INTERVAL_MS;
  return now - at >= wait;
}

export interface ReleaseImagesFetchDeps {
  version: string;
  dataDir?: string;
  now?: () => number;
  enabled: () => boolean;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type ReleaseImagesFetchOutcome =
  | { outcome: "none" | "present" | "disabled" | "not-due" }
  | { outcome: "fetched"; stored: string[]; failed: { src: string; error: string }[] }
  | { outcome: "failed"; error: string };

export async function fetchReleaseImagesFor(deps: ReleaseImagesFetchDeps): Promise<ReleaseImagesFetchOutcome> {
  const env = deps.env ?? process.env;
  const version = normalizeStableVersion(deps.version);
  if (!version) return { outcome: "failed", error: "not a stable version" };
  const notes = readReleaseNotes(version, deps.dataDir);
  if (!hasReleaseNotesContent(notes)) return { outcome: "none" };
  const wanted = releaseImageSources(notes.notes, env);
  if (wanted.length === 0) return { outcome: "none" };
  const stored = new Set(storedReleaseImageSources(version, notes.notes, deps.dataDir, env));
  const missing = wanted.filter((src) => !stored.has(src));
  if (missing.length === 0) return { outcome: "present" };
  if (!deps.enabled()) return { outcome: "disabled" };
  const now = (deps.now ?? Date.now)();
  const record = (patch: FetchRecord) =>
    patchUpdateState((s) => {
      const entries = Object.entries({ ...(s.releaseImagesFetch ?? {}), [version]: patch })
        .filter(([, r]) => r && typeof r.attemptedAt === "number")
        .sort((a, b) => b[1].attemptedAt - a[1].attemptedAt)
        .slice(0, FETCH_REMEMBERED);
      return { ...s, releaseImagesFetch: Object.fromEntries(entries) };
    }, deps.dataDir);
  try {
    if (!isReleaseImagesFetchDue(readUpdateState(deps.dataDir), version, now)) return { outcome: "not-due" };
    // Claim the attempt before the network call so concurrent processes ask once;
    // marked in flight until the answer below replaces it.
    record({ attemptedAt: now, inFlight: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateLog(`could not write update-state.json: ${error}`, deps.dataDir);
    return { outcome: "failed", error };
  }
  const dir = releaseImagesDir(version, deps.dataDir)!;
  const added: Record<string, ReleaseImageEntry> = {};
  const failed: { src: string; error: string }[] = [];
  for (const src of missing) {
    const result = await fetchReleaseImage(src, { fetchImpl: deps.fetchImpl, env, timeoutMs: deps.timeoutMs });
    if (!result.ok) {
      failed.push({ src, error: result.error });
      continue;
    }
    const sha = createHash("sha256").update(result.bytes).digest("hex");
    const file = `${sha}.${EXTENSIONS[result.contentType]}`;
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, file);
      if (!existsSync(path) || statSync(path).size !== result.bytes.byteLength) writeAtomic(path, result.bytes);
      added[src] = {
        file,
        content_type: result.contentType,
        bytes: result.bytes.byteLength,
        ...(result.width !== undefined && result.height !== undefined ? { width: result.width, height: result.height } : {}),
      };
    } catch (err) {
      failed.push({ src, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (Object.keys(added).length > 0) {
    try {
      // Read again before the write: another process may have added images meanwhile.
      const manifest: ReleaseImagesManifest = { v: 1, images: { ...readReleaseImages(version, deps.dataDir), ...added } };
      writeAtomic(join(dir, "images.json"), JSON.stringify(manifest) + "\n");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const src of Object.keys(added)) failed.push({ src, error });
      for (const src of Object.keys(added)) delete added[src];
    }
  }
  for (const { src, error } of failed) {
    updateLog(`could not save an image of the ${version} release notes (${error}): ${src.slice(0, 200)}`, deps.dataDir);
  }
  try {
    record(failed.length > 0 ? { attemptedAt: now, failedAt: now, error: failed[0]!.error.slice(0, 200) } : { attemptedAt: now });
  } catch {}
  return { outcome: "fetched", stored: Object.keys(added), failed };
}


export const INBOX_WHATS_NEW_IMAGE_PATH = "/api/inbox/whats-new/image";
/** As the Inbox's other image routes: an SVG opened directly never runs. */
const IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
const GUARD_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": IMAGE_CSP,
  "Cross-Origin-Resource-Policy": "same-origin",
};

function refuse(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { ...GUARD_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || strip(tag) === etag);
}

export function whatsNewImageRoute(req: Request, url: URL, dataDir: string, env: NodeJS.ProcessEnv = process.env): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(405, "method_not_allowed", "Use GET.");
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return refuse(403, "cross_origin", "Cross-origin requests are not accepted.");
  const version = normalizeStableVersion(url.searchParams.get("version") ?? "");
  const src = url.searchParams.get("src") ?? "";
  if (!version) return refuse(422, "validation_error", "version: a release version (X.Y.Z).");
  if (!src || src.length > RELEASE_IMAGE_SRC_MAX) return refuse(422, "validation_error", "src: the image's source as the notes write it.");
  const notes = readReleaseNotes(version, dataDir);
  if (!hasReleaseNotesContent(notes) || !releaseImageSources(notes.notes, env).includes(src)) {
    return refuse(404, "image_not_referenced", "The release notes show no such image.");
  }
  const entry = readReleaseImages(version, dataDir)[src];
  const dir = releaseImagesDir(version, dataDir)!;
  const match = entry ? RELEASE_IMAGE_FILE_RE.exec(entry.file) : null;
  if (!entry || !match) return refuse(404, "image_not_stored", "That image is not saved on this computer.");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const path = join(dir, entry.file);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_REVIEW_IMAGE_PREVIEW_BYTES) return refuse(404, "image_not_stored", "That image is not saved on this computer.");
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    return refuse(404, "image_not_stored", "That image is not saved on this computer.");
  }
  // Content-addressed: the bytes must still be the ones the name says.
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== match[1]) return refuse(404, "image_not_stored", "That image is not saved on this computer.");
  const contentType = sniffImageContentType(bytes);
  if (!contentType) return refuse(415, "not_an_image", "That file is not a recognized image.");
  const dims = readImageDimensions(bytes, contentType);
  const etag = `"${sha}"`;
  const headers: Record<string, string> = {
    ...GUARD_HEADERS,
    "Content-Type": contentType,
    "Cache-Control": "private, no-cache",
    ETag: etag,
    ...(dims ? { "X-Image-Width": String(dims.width), "X-Image-Height": String(dims.height) } : {}),
  };
  if (ifNoneMatchHits(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : bytes, { headers: { ...headers, "Content-Length": String(bytes.byteLength) } });
}
