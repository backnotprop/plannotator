/**
 * Server-side share URL generation and notification for remote sessions.
 *
 * When Tailscale (or PLANNOTATOR_HOSTNAME) is available, the server URL is
 * directly reachable from the user's local browser — no port forwarding
 * needed. That URL is shown as the primary link (full approve/deny).
 *
 * As a fallback, a read-only share.plannotator.ai URL is generated so remote
 * users can still open the review in their local browser (plan-only).
 *
 * Notification priority:
 *   1. ntfy push notification (if CLAUDE_HOOKS_NTFY_URL is set)
 *   2. stderr (fallback — works for OpenCode, logging, etc.)
 */

import { compress } from "@plannotator/shared/compress";
import { encrypt } from "@plannotator/shared/crypto";
import { getServerUrlHostname } from "./remote";

const DEFAULT_SHARE_BASE = "https://share.plannotator.ai";
const DEFAULT_PASTE_API = "https://plannotator-paste.plannotator.workers.dev";

export interface RemoteShareOptions {
  rawHtml?: string;
  pasteApiUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Local server URL (e.g. `http://localhost:45231`). When a reachable
   * hostname (Tailscale/explicit) is detected, its `localhost` host is
   * rewritten to that hostname and shown as the primary link with full
   * approve/deny. Left untouched otherwise (read-only share link is used).
   */
  serverUrl?: string;
}

/**
 * Resolve the directly-reachable server URL by swapping the local host for the
 * detected Tailscale/explicit hostname. Returns null when no reachable
 * hostname is available (so the read-only share link should be used instead).
 */
async function resolveReachableServerUrl(serverUrl?: string): Promise<string | null> {
  if (!serverUrl) return null;
  const host = await getServerUrlHostname();
  if (host === "localhost") return null;
  return serverUrl.replace("localhost", host).replace("127.0.0.1", host);
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
    // Callers that start from a local file should pass self-contained HTML
    // so sibling assets keep working after the payload leaves the machine.
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
    throw new Error(await readPasteError(response, `Paste service returned ${response.status}`));
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

async function readPasteError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
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
 * Send URL via ntfy push notification.
 *
 * Reads config from env vars (compatible with claude-code ntfy hooks):
 *   CLAUDE_HOOKS_NTFY_URL   - Full ntfy URL (e.g. https://ntfy.sh/mytopic)
 *   CLAUDE_HOOKS_NTFY_TOKEN - Optional auth token
 *
 * Returns true if the notification was sent successfully.
 */
async function notifyNtfy(url: string, verb: string): Promise<boolean> {
  const ntfyUrl = process.env.CLAUDE_HOOKS_NTFY_URL;
  if (!ntfyUrl) return false;

  const headers: Record<string, string> = {
    Title: `Plannotator: ${verb}`,
    Click: url,
    Tags: "clipboard",
  };

  const token = process.env.CLAUDE_HOOKS_NTFY_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(ntfyUrl, {
      method: "POST",
      headers,
      body: url,
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Notify the remote user about the review server URL.
 *
 * When a directly-reachable server URL is provided (Tailscale/explicit
 * hostname), it is shown as the primary link with full approve/deny.
 * Otherwise a read-only share URL is generated as the fallback.
 *
 * Notifies via ntfy push (if configured) and stderr. Silently does nothing
 * on failure.
 */
export async function writeRemoteShareLink(
  content: string,
  shareBaseUrl: string | undefined,
  verb: string,
  noun: string,
  options: RemoteShareOptions = {},
): Promise<void> {
  // Primary path: the server is directly reachable (full review w/ approve/deny).
  const reachableUrl = await resolveReachableServerUrl(options.serverUrl);
  if (reachableUrl) {
    const ntfyOk = await notifyNtfy(reachableUrl, verb);
    const lines = [`\n  Open this link on your local machine to ${verb}:\n  ${reachableUrl}\n`];
    lines.push(`  (${noun} — full review with approve/deny)`);
    if (ntfyOk) lines.push(`  [notified via ntfy]`);
    lines.push("\n");
    process.stderr.write(lines.join("\n"));
    return;
  }

  // Fallback path: read-only share URL (works without port forwarding).
  try {
    const shareUrl = await generateRemoteShareUrl(content, shareBaseUrl, options);
    const ntfyOk = await notifyNtfy(shareUrl, verb);
    const size = formatSize(new TextEncoder().encode(shareUrl).length);
    const lines = [`\n  Open this link on your local machine to ${verb}:\n  ${shareUrl}\n`];
    lines.push(`  (${size} — ${noun}, read-only, annotations added in browser)`);
    if (ntfyOk) lines.push(`  [notified via ntfy]`);
    lines.push("\n");
    process.stderr.write(lines.join("\n"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const pasteHint = options.rawHtml
      ? " HTML sharing uses the paste service; check PLANNOTATOR_PASTE_URL or try a smaller/self-contained HTML file."
      : "";
    process.stderr.write(
      `\n  Warning: could not create remote share link for ${noun}.\n` +
      `  ${reason}.${pasteHint}\n\n`
    );
  }
}
