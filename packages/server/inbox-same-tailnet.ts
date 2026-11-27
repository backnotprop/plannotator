/**
 * Linking two computers through a third (inbox-link-through.ts): the other computer must be one of this person's own
 * on this computer's tailnet. Checked when the computer an introduction is for takes its code (`link` in
 * inbox-machines.ts) and when the code's maker completes it (`linkBack`), never for a link the person makes by hand.
 *
 * The other computer's tailnet host (its MagicDNS name) must be a node in this computer's own `tailscale status
 * --json`, owned by the same user as this computer. When the status cannot be read (Tailscale not installed or not
 * running) or names no owner (a tagged machine is owned by its tags), nothing is refused: the link goes as before.
 * Inside a test sandbox (`PLANNOTATOR_TEST_SANDBOX`, two Inboxes on one computer) it is skipped, as loopback is taken
 * there (inbox-transport-tailnet.ts). No key is exchanged: this checks what Tailscale says of the address only.
 */

import type { TailscaleRunResult } from "@plannotator/shared/tailscale";

/** The refusal: the other computer is not one of this person's own on this tailnet. */
export const NOT_SAME_TAILNET = "That computer is not one of yours on this tailnet.";

type Node = { DNSName?: unknown; UserID?: unknown; Tags?: unknown };

/**
 * Who owns `host` as this status says: `same` (this computer's user), `other` (another user, or not a node here),
 * or `unknown` (not a running status document, or no owner to compare: a tagged machine on either side).
 */
export function tailnetOwnerOf(stdout: string, host: string): "same" | "other" | "unknown" {
  let parsed: unknown;
  try {
    // User ids are 64-bit integers: kept as their exact source text, never rounded (as parseTailscaleSelfIdentity does).
    parsed = JSON.parse(stdout, (key, value, context?: { source?: string }) =>
      key === "UserID" && typeof value === "number" && typeof context?.source === "string" && /^(?:0|-?[1-9]\d*)$/.test(context.source) ? context.source : value,
    );
  } catch {
    return "unknown";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
  const status = parsed as { BackendState?: unknown; Self?: Node; Peer?: unknown };
  if (status.BackendState !== "Running" || !status.Self || typeof status.Self !== "object") return "unknown";
  const owner = (node: Node) => (Array.isArray(node.Tags) && node.Tags.length > 0 ? null : typeof node.UserID === "string" || typeof node.UserID === "number" ? String(node.UserID) : null);
  const self = owner(status.Self);
  if (self === null) return "unknown";
  const name = host.toLowerCase().replace(/\.$/, "");
  const peers = status.Peer && typeof status.Peer === "object" && !Array.isArray(status.Peer) ? (Object.values(status.Peer) as Node[]) : [];
  const node = [status.Self, ...peers].find((n) => n && typeof n === "object" && typeof n.DNSName === "string" && n.DNSName.toLowerCase().replace(/\.$/, "") === name);
  if (!node) return "other";
  const theirs = owner(node);
  if (theirs === null) return "unknown";
  return theirs === self ? "same" : "other";
}

/**
 * Null when the computer at `url` may be linked through an introduction; else the words it is refused with. `read`:
 * this computer's `tailscale status --json` (the door's reader); absent or failing, nothing is refused.
 */
export async function sameTailnetRefusal(url: string, read: (() => Promise<TailscaleRunResult>) | undefined, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (env.PLANNOTATOR_TEST_SANDBOX || !read) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  let status: TailscaleRunResult;
  try {
    status = await read();
  } catch {
    return null;
  }
  if (status.error || status.status !== 0) return null;
  return tailnetOwnerOf(status.stdout, host) === "other" ? NOT_SAME_TAILNET : null;
}
