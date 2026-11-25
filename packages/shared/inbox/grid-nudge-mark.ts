import type { InboxGridNudge } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

/**
 * A reply's `nudge` (Nudge pressed on a stale line of Grid, approval "inbox-agent-grid", round 4), checked before
 * anything is written: `{ quiet_from }` to keep on the reply, or null when there is none. Anything else is a
 * `422 validation_error` naming the field.
 */
export function planGridNudge(raw: unknown): InboxGridNudge | null {
  if (raw === undefined || raw === null) return null;
  const quiet = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { quiet_from?: unknown }).quiet_from : undefined;
  if (typeof quiet !== "string" || !Number.isFinite(Date.parse(quiet))) {
    throw new InboxError("validation_error", "nudge: { quiet_from } (an ISO time).", { field: "nudge" });
  }
  return { quiet_from: new Date(Date.parse(quiet)).toISOString() };
}
