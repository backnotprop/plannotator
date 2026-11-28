/**
 * A "now" write's deadline (adr/implementation/inbox-mobile.md, section 4, "not_after"): a write the phone
 * queued (Run, a secret, Stop, a switch) carries the time after which it must not happen, inside a sealed relay
 * command as `not_after` and on a request sent straight to the door as `X-Plannotator-Not-After` (the relay
 * client hands the sealed one to the door as this header). The door checks it in `claim`, after the command's
 * key: a key already answered replays its answer whatever the time; a first arrival past it by more than a few
 * seconds on this computer's clock is refused and never applied. Both refusals carry `now`, the computer's
 * time, so the phone can correct its clock's offset.
 */

/** The request header a write sent straight to the door names its deadline in. Never handed to the window. */
export const NOT_AFTER_HEADER = "X-Plannotator-Not-After";

/** How far past `not_after` a write is still applied: its time in transit and a clock a little off. */
export const NOT_AFTER_GRACE_MS = 5_000;

/**
 * Why a write is refused before the window sees it, or null to apply it: a `not_after` more than
 * `NOT_AFTER_GRACE_MS` past on this computer's clock (`410 command_expired`), or one that is no time at all
 * (`400 bad_request`). Absent (undefined or null): applied, as for every app before relay 1.1.
 */
export function commandTimeRefusal(notAfter: unknown, now: number): { status: number; body: { error: string; code: string; now: string } } | null {
  if (notAfter === undefined || notAfter === null) return null;
  const at = typeof notAfter === "string" ? Date.parse(notAfter) : Number.NaN;
  const said = new Date(now).toISOString();
  if (!Number.isFinite(at)) return { status: 400, body: { error: "not_after: an ISO time.", code: "bad_request", now: said } };
  if (now > at + NOT_AFTER_GRACE_MS) return { status: 410, body: { error: "This command reached the computer too late and was not applied.", code: "command_expired", now: said } };
  return null;
}
