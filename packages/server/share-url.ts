/**
 * Server-side share URL generation for remote sessions
 *
 * Generates a share.plannotator.ai URL from plan content so remote users
 * can open the review in their local browser without port forwarding.
 *
 * Uses the same deflate-raw + base64url encoding as the client-side
 * sharing utilities in @plannotator/ui.
 */

const DEFAULT_SHARE_BASE = "https://share.plannotator.ai";

// Intentional subset of the canonical SharePayload in @plannotator/ui/utils/sharing.ts.
// Only `p` (plan) is populated server-side; annotations are added in the browser.
// If the canonical format changes, this must be updated to match.
interface SharePayload {
  p: string;
  a: [];
}

/**
 * Generate a share URL from plan markdown content.
 *
 * Returns the full hash-based URL. For remote sessions, this lets the
 * user open the plan in their local browser without any backend needed.
 */
export async function generateRemoteShareUrl(
  plan: string,
  shareBaseUrl?: string
): Promise<string> {
  const base = shareBaseUrl || DEFAULT_SHARE_BASE;

  // Build minimal payload (no annotations at server startup)
  const payload: SharePayload = { p: plan, a: [] };
  const json = JSON.stringify(payload);
  const byteArray = new TextEncoder().encode(json);

  // Compress using deflate-raw (same as client-side)
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  writer.write(byteArray);
  writer.close();

  const buffer = await new Response(stream.readable).arrayBuffer();
  const compressed = new Uint8Array(buffer);

  // Convert to base64url — use a loop instead of spread to avoid
  // RangeError on large plans (spread has a ~65K argument limit).
  let binary = "";
  for (let i = 0; i < compressed.length; i++) {
    binary += String.fromCharCode(compressed[i]);
  }
  const base64 = btoa(binary);
  const hash = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return `${base}/#${hash}`;
}

/**
 * Format byte size as human-readable string
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}
