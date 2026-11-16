import { cleanInboxSessionLabel } from "./inbox-sessions";

const PEER_NAMES_MAX = 500;

/** A peer's names are cleaned as a poll's label is: they reach this window as display text. */
export function inboxPeerSessionNames(value: unknown): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let kept = 0;
  for (const [session, name] of Object.entries(value as Record<string, unknown>)) {
    const clean = cleanInboxSessionLabel(name);
    if (!session || !clean) continue;
    out[session] = clean;
    if ((kept += 1) >= PEER_NAMES_MAX) break;
  }
  return out;
}
