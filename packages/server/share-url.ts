/**
 * Server-side share URL generation for remote sessions
 *
 * Generates a share.plannotator.ai URL from plan content so remote users
 * can open the review in their local browser without port forwarding.
 */

import { compress } from "@plannotator/shared/compress";
import { encrypt } from "@plannotator/shared/crypto";

const DEFAULT_SHARE_BASE = "https://share.plannotator.ai";
const DEFAULT_PASTE_API = "https://plannotator-paste.plannotator.workers.dev";

export interface RemoteShareOptions {
  rawHtml?: string;
  pasteApiUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Generate a share URL from plan markdown content.
 *
 * Returns the full hash-based URL. For remote sessions, this lets the
 * user open the plan in their local browser without any backend needed.
 */
export async function generateRemoteShareUrl(
  plan: string,
  shareBaseUrl?: string,
  options: RemoteShareOptions = {},
): Promise<string> {
  const base = shareBaseUrl || DEFAULT_SHARE_BASE;
  if (options.rawHtml) {
    return generateRemotePasteShareUrl(
      { p: plan, a: [], h: options.rawHtml, r: "html" },
      base,
      options.pasteApiUrl,
      options.fetchImpl,
    );
  }
  const hash = await compress({ p: plan, a: [] });
  return `${base}/#${hash}`;
}

async function generateRemotePasteShareUrl(
  payload: unknown,
  shareBaseUrl: string,
  pasteApiUrl = DEFAULT_PASTE_API,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const compressed = await compress(payload);
  const { ciphertext, key } = await encrypt(compressed);

  const response = await fetchImpl(`${pasteApiUrl}/api/paste`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: ciphertext }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Paste service returned ${response.status}`);
  }

  const result = (await response.json()) as { id?: unknown };
  if (typeof result.id !== "string" || !result.id) {
    throw new Error("Paste service response missing id");
  }

  const pasteParam =
    pasteApiUrl !== DEFAULT_PASTE_API
      ? `&paste=${base64UrlEncode(pasteApiUrl)}`
      : "";
  return `${shareBaseUrl}/p/${result.id}#key=${key}${pasteParam}`;
}

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Format byte size as human-readable string
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

/**
 * Generate a remote share URL and write it to stderr for the user.
 * Silently does nothing on failure.
 */
export async function writeRemoteShareLink(
  content: string,
  shareBaseUrl: string | undefined,
  verb: string,
  noun: string,
  options: RemoteShareOptions = {},
): Promise<void> {
  const shareUrl = await generateRemoteShareUrl(content, shareBaseUrl, options);
  const size = formatSize(new TextEncoder().encode(shareUrl).length);
  process.stderr.write(
    `\n  Open this link on your local machine to ${verb}:\n` +
    `  ${shareUrl}\n\n` +
    `  (${size} — ${noun}, annotations added in browser)\n\n`
  );
}
