/**
 * Server-side share URL generation for remote sessions
 *
 * Generates a share.plannotator.ai URL from plan content so remote users
 * can open the review in their local browser without port forwarding.
 */

import { compress } from "@plannotator/shared/compress";
import type { DaemonRemoteShareNotice } from "@plannotator/shared/daemon-protocol";

const DEFAULT_SHARE_BASE = "https://share.plannotator.ai";

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
  const hash = await compress({ p: plan, a: [] });
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

export async function createRemoteShareNotice(
  content: string,
  shareBaseUrl: string | undefined,
  verb: string,
  noun: string
): Promise<DaemonRemoteShareNotice> {
  const url = await generateRemoteShareUrl(content, shareBaseUrl);
  return {
    url,
    verb,
    noun,
    size: formatSize(new TextEncoder().encode(url).length),
  };
}

export function formatRemoteShareNotice(notice: DaemonRemoteShareNotice): string {
  return (
    `\n  Open this link on your local machine to ${notice.verb}:\n` +
    `  ${notice.url}\n\n` +
    `  (${notice.size} — ${notice.noun}, annotations added in browser)\n\n`
  );
}

/**
 * Generate a remote share URL and write it to stderr for the user.
 * Silently does nothing on failure.
 */
export async function writeRemoteShareLink(
  content: string,
  shareBaseUrl: string | undefined,
  verb: string,
  noun: string
): Promise<void> {
  process.stderr.write(formatRemoteShareNotice(
    await createRemoteShareNotice(content, shareBaseUrl, verb, noun),
  ));
}
