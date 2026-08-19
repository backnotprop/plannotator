/**
 * Guide share — upload a portable Guided Review snapshot to a guide host
 * (guides.show, or your own deployment of its Worker) and remove it again.
 * Implements the producer half of the guide share hosting contract
 * (`adr/implementation/guide-share-hosting.md`, §1, §2, §4, §7).
 *
 * Two modes, both storing one text body per guide:
 *
 *   encrypted (default)  `encrypt(await compress(snapshot))` — the same
 *                        deflate + AES-256-GCM pipeline plan share links use;
 *                        the key never leaves this process except inside the
 *                        URL fragment (`#key=…`), so the host cannot read the
 *                        code.
 *   plain                the snapshot JSON, so the host can render link
 *                        previews (`--public` / "allow link previews").
 *
 * The viewer build this Plannotator version pins into exports (the checked-in
 * manifest, minus `baseUrl` — the host always uses its own `/v1/`) travels
 * with the upload so the hosted page renders with the same viewer a download
 * would. Runtime-agnostic: global `fetch`, `CompressionStream` and
 * `crypto.subtle` exist in Bun and Node alike, and `fetch` is injectable for
 * tests. Vendored to Pi like `guide-review.ts`.
 */
import { compress } from "@plannotator/shared/compress";
import { encrypt } from "@plannotator/shared/crypto";
import { GUIDE_SHARE_KEY_PARAM, type GuideSnapshot, type GuideViewerAssets } from "@plannotator/shared/guide-format";

export type GuideShareMode = "encrypted" | "plain";

/** The viewer pin sent with an upload: the manifest without `baseUrl` (contract §2). */
export type GuideShareViewer = Omit<GuideViewerAssets, "baseUrl">;

export interface ShareGuideOptions {
  /** Guide host base URL without a trailing slash, e.g. `https://guides.show` (see `resolveGuideShareUrl`). */
  readonly serviceUrl: string;
  readonly mode: GuideShareMode;
  /** Lifetime in seconds; absent = the link never expires. */
  readonly ttlSeconds?: number;
  readonly viewer: GuideShareViewer;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

export interface ShareGuideResult {
  readonly id: string;
  /** Share URL; carries `#key=…` for encrypted shares. */
  readonly url: string;
  /** Returned once by the host. Needed to remove the link later. */
  readonly deleteToken: string;
  /** ISO timestamp, absent when the link never expires. */
  readonly expiresAt?: string;
  /** Size of the stored body (ciphertext or JSON) in bytes. */
  readonly bytes: number;
}

/**
 * Anything that stops a share from being created or removed: the host being
 * unreachable (no `status`), or an HTTP error the host answered with
 * (`status` set; `message` carries the host's reason when it sent one).
 */
export class GuideShareError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GuideShareError";
    if (status !== undefined) this.status = status;
  }
}

/** Reachable host, HTTP error → a message the CLI and the UI can show as-is. */
async function describeHttpError(res: Response, verb: string): Promise<GuideShareError> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy page, an empty body): fall through to the status text.
  }
  const hostMessage = typeof body.error === "string" ? body.error : undefined;
  if (res.status === 413) {
    const max = typeof body.maxBytes === "number" ? ` (limit ${(body.maxBytes / (1024 * 1024)).toFixed(0)} MB)` : "";
    return new GuideShareError(`Guide is too large for the share service${max}. Download the portable file instead.`, 413);
  }
  const detail = hostMessage
    ? typeof body.path === "string" && typeof body.message === "string"
      ? `${hostMessage} (${body.path}: ${body.message})`
      : hostMessage
    : res.statusText || `HTTP ${res.status}`;
  return new GuideShareError(`Could not ${verb} the guide: ${detail}`, res.status);
}

/**
 * Upper bound on one round trip to the guide host. Uploads carry the whole
 * (compressed) guide, so this is generous; it exists so a blackholing proxy or
 * an offline machine turns into a clear error rather than a hung request —
 * `DELETE /api/guides/:id` awaits the unshare before the local delete.
 */
export const GUIDE_SHARE_REQUEST_TIMEOUT_MS = 60_000;

async function callService(
  doFetch: typeof fetch,
  serviceUrl: string,
  path: string,
  init: RequestInit,
  verb: string,
): Promise<Response> {
  const target = `${serviceUrl}${path}`;
  try {
    return await doFetch(target, { ...init, signal: init.signal ?? AbortSignal.timeout(GUIDE_SHARE_REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const reason = e instanceof Error ? (e.name === "TimeoutError" ? `no response within ${GUIDE_SHARE_REQUEST_TIMEOUT_MS / 1000}s` : e.message) : String(e);
    throw new GuideShareError(`Guide share service unreachable at ${serviceUrl}: ${reason}`);
  }
}

/** UTF-8 byte length without relying on Node's Buffer (works in every producer runtime). */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Upload a guide snapshot. Encrypted by default: the host stores ciphertext,
 * the returned `url` carries the key in its fragment. Throws `GuideShareError`
 * on any failure — never returns a half result.
 */
export async function shareGuide(snapshot: GuideSnapshot, opts: ShareGuideOptions): Promise<ShareGuideResult> {
  const doFetch = opts.fetch ?? fetch;
  let data: string;
  let key: string | undefined;
  if (opts.mode === "encrypted") {
    const compressed = await compress(snapshot);
    const encrypted = await encrypt(compressed);
    data = encrypted.ciphertext;
    key = encrypted.key;
  } else {
    data = JSON.stringify(snapshot);
  }
  const body = {
    mode: opts.mode,
    data,
    viewer: opts.viewer,
    ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
  };
  const res = await callService(
    doFetch,
    opts.serviceUrl,
    "/api/g",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    "share",
  );
  if (res.status !== 201 && res.status !== 200) throw await describeHttpError(res, "share");
  let created: Record<string, unknown>;
  try {
    created = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new GuideShareError("Could not share the guide: the share service returned an unreadable response", res.status);
  }
  if (typeof created.id !== "string" || typeof created.url !== "string" || typeof created.deleteToken !== "string") {
    throw new GuideShareError("Could not share the guide: the share service returned an incomplete response", res.status);
  }
  const url = key ? `${created.url}#${GUIDE_SHARE_KEY_PARAM}=${key}` : created.url;
  return {
    id: created.id,
    url,
    deleteToken: created.deleteToken,
    ...(typeof created.expiresAt === "string" ? { expiresAt: created.expiresAt } : {}),
    bytes: utf8Bytes(data),
  };
}

export interface UnshareGuideOptions {
  readonly serviceUrl: string;
  readonly fetch?: typeof fetch;
}

/**
 * Remove a shared guide with its delete token. Resolves on `204`; throws
 * `GuideShareError` with `status` 404 when the host no longer has it (already
 * removed or expired), 401 when the token is wrong, or without a status when
 * the host is unreachable.
 */
export async function unshareGuide(id: string, deleteToken: string, opts: UnshareGuideOptions): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  const res = await callService(
    doFetch,
    opts.serviceUrl,
    `/api/g/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${deleteToken}` } },
    "remove",
  );
  if (res.status === 204 || res.status === 200) return;
  if (res.status === 404) throw new GuideShareError("No shared guide with that id (already removed or expired)", 404);
  if (res.status === 401) throw new GuideShareError("The share service rejected the delete token", 401);
  throw await describeHttpError(res, "remove");
}

/**
 * Remove a saved guide's link right before the guide itself is deleted — the
 * envelope is the only copy of the delete token, so this is the last chance.
 * Best effort: a host that already forgot the link is fine, and any other
 * failure is logged with the manual `unshare` command instead of blocking
 * the delete.
 */
export async function unshareBeforeDelete(
  share: { id: string; url: string; deleteToken: string; serviceUrl: string } | undefined,
  doFetch?: typeof fetch,
): Promise<void> {
  if (!share) return;
  try {
    await unshareGuide(share.id, share.deleteToken, { serviceUrl: share.serviceUrl, fetch: doFetch });
  } catch (e) {
    if (e instanceof GuideShareError && e.status === 404) return;
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[guide] Could not remove the share link ${share.url} (${reason}). Remove it with: plannotator guide unshare ${share.id} --token ${share.deleteToken}`);
  }
}
