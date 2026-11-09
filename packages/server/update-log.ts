/**
 * What `update-prepare` (update-prepare.ts) tells the person, and how
 * `plannotator update`, the Inbox's failure dialog and the review-window
 * notice read it back. `update-prepare` prints these lines on stderr: the
 * terminal of `plannotator update`, and update.log for every run. All three
 * surfaces keep exit 75 (nothing ran, nothing changed) and choose their words
 * from the line the run printed.
 *
 * Its own module (only `node:fs`), so auto-update.ts can read it without an
 * import cycle through update-prepare.ts.
 */

import { readFileSync } from "node:fs";

/**
 * Why a download failed at TLS. `untrusted`: neither Bun's roots nor this
 * computer's trust the certificate (a network that inspects HTTPS with a root
 * this computer does not have either). `revoked`: the chain holds a key Bun
 * blocks (the leaked eMudhra keys), so nothing may be installed over this
 * network, by curl least of all.
 */
export type UpdateTlsFailure = "untrusted" | "revoked";

/** The line `update-prepare` prints for each TLS failure. */
export const UPDATE_TLS_HINT: Record<UpdateTlsFailure, string> = {
  untrusted:
    "update: neither Plannotator nor this computer trusts the certificate that connection presented. If your network inspects HTTPS with its own certificate, run: NODE_EXTRA_CA_CERTS=/path/to/its-root.pem plannotator update",
  revoked:
    "update: that connection presented a revoked certificate, so nothing was downloaded. Do not install Plannotator over this network; try again on another network.",
};

/**
 * The start of the line `update-prepare` prints when it downloaded the update
 * but could not save it (a full or read-only temp folder). The reason follows,
 * then "; nothing was changed".
 */
export const UPDATE_STAGING_PREFIX = "update: could not prepare the update: ";

/**
 * Printed when the install script plannotator.ai serves predates the pin
 * check (before the S3 sync). For update.log only: `plannotator update` keeps
 * it off the person's terminal (withoutLogOnlyLines).
 */
export const UPDATE_OLD_SCRIPT_NOTE = "update: this install script does not check the pinned checksum yet; it runs as before";

/** The TLS failure `update-prepare` reported in this output (a run's terminal text, or its part of update.log). */
export function tlsFailureIn(text: string): UpdateTlsFailure | null {
  if (text.includes(UPDATE_TLS_HINT.revoked)) return "revoked";
  if (text.includes(UPDATE_TLS_HINT.untrusted)) return "untrusted";
  return null;
}

/** The staging failure's reason (`the temp folder /tmp is full`) in this output, if any. */
export function stagingFailureIn(text: string): string | null {
  const at = text.lastIndexOf(UPDATE_STAGING_PREFIX);
  if (at === -1) return null;
  const line = text.slice(at + UPDATE_STAGING_PREFIX.length).split("\n")[0]!;
  return line.replace(/; nothing was changed\s*$/, "").trim() || null;
}

/** Terminal output without the lines meant for update.log only. */
export function withoutLogOnlyLines(text: string): string {
  return text.split(`${UPDATE_OLD_SCRIPT_NOTE}\n`).join("");
}

/**
 * The last finished update run's part of update.log: from the end of the run
 * before it to this run's end (the wrapper's "update: install.sh exited"
 * line). Reads the last 64 KB only. Empty when there is none.
 */
export function lastRunLog(logPath: string): string {
  let text: string;
  try {
    text = readFileSync(logPath, "utf-8").slice(-65_536);
  } catch {
    return "";
  }
  const END = "] update: install.sh exited";
  const last = text.lastIndexOf(END);
  if (last === -1) return "";
  const previous = last === 0 ? -1 : text.lastIndexOf(END, last - 1);
  return text.slice(previous === -1 ? 0 : previous + END.length, last);
}

/** The TLS failure the last finished update run in update.log reported. */
export function lastRunTlsFailure(logPath: string): UpdateTlsFailure | null {
  return tlsFailureIn(lastRunLog(logPath));
}
