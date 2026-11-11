/** Lines `update-prepare` prints on stderr (terminal and update.log) and how readers parse them back. Its own module (only `node:fs`) so auto-update.ts can read it without an import cycle through update-prepare.ts. */

import { readFileSync } from "node:fs";

/** Why a download failed at TLS. `untrusted`: neither Bun's roots nor this computer's trust the certificate. `revoked`: the chain holds a key Bun blocks (the leaked eMudhra keys), so nothing may be installed over this network. */
export type UpdateTlsFailure = "untrusted" | "revoked";

export const UPDATE_TLS_HINT: Record<UpdateTlsFailure, string> = {
  untrusted:
    "update: neither Plannotator nor this computer trusts the certificate that connection presented. If your network inspects HTTPS with its own certificate, run: NODE_EXTRA_CA_CERTS=/path/to/its-root.pem plannotator update",
  revoked:
    "update: that connection presented a revoked certificate, so nothing was downloaded. Do not install Plannotator over this network; try again on another network.",
};

export const UPDATE_STAGING_PREFIX = "update: could not prepare the update: ";

/** Printed when the served install script predates the pin check. For update.log only: `plannotator update` keeps it off the terminal (withoutLogOnlyLines). */
export const UPDATE_OLD_SCRIPT_NOTE = "update: this install script does not check the pinned checksum yet; it runs as before";

export function tlsFailureIn(text: string): UpdateTlsFailure | null {
  if (text.includes(UPDATE_TLS_HINT.revoked)) return "revoked";
  if (text.includes(UPDATE_TLS_HINT.untrusted)) return "untrusted";
  return null;
}

export function stagingFailureIn(text: string): string | null {
  const at = text.lastIndexOf(UPDATE_STAGING_PREFIX);
  if (at === -1) return null;
  const line = text.slice(at + UPDATE_STAGING_PREFIX.length).split("\n")[0]!;
  return line.replace(/; nothing was changed\s*$/, "").trim() || null;
}

export function withoutLogOnlyLines(text: string): string {
  return text.split(`${UPDATE_OLD_SCRIPT_NOTE}\n`).join("");
}

/** The last finished update run's part of update.log, up to the wrapper's "update: install.sh exited" line. Reads the last 64 KB only. */
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

export function lastRunTlsFailure(logPath: string): UpdateTlsFailure | null {
  return tlsFailureIn(lastRunLog(logPath));
}
