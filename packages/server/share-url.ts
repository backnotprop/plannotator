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

interface SharePayload {
  /** Plan markdown */
  p: string;
  /** Annotations (empty at server startup) */
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

  // Convert to base64url
  const base64 = btoa(String.fromCharCode(...compressed));
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
