/**
 * `plannotator sessions` output: the table people read (stderr, as before)
 * and the `--json` form scripts and agents read (stdout).
 *
 * Every row names its full target (absolute path, URL, PR URL or reviewed
 * directory) and, when a host started it, the review's `pn-` id: two sessions
 * on files that share a name must be told apart here too.
 */

import type { SessionInfo } from "@plannotator/server/sessions";

function ageText(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The human table, one line per session, newest first (the registry's order). */
export function formatSessionsTable(sessions: readonly SessionInfo[], now: number = Date.now()): string {
  const lines = ["Active Plannotator sessions:", ""];
  sessions.forEach((session, index) => {
    const cells = [
      `#${index + 1}`.padEnd(4),
      session.mode.padEnd(10),
      (session.reviewId ?? "-").padEnd(10),
      session.project.padEnd(20),
      session.url.padEnd(28),
      `${ageText(session.startedAt, now)} ago`.padEnd(10),
      session.target ?? "-",
    ];
    lines.push(`  ${cells.join(" ")}`.trimEnd());
  });
  lines.push("", "Reopen with: plannotator sessions --open [N]");
  return lines.join("\n");
}

/** `--json`: the sessions as one JSON array; `index` is the N `--open` takes. */
export function formatSessionsJson(sessions: readonly SessionInfo[]): string {
  return JSON.stringify(
    sessions.map((session, index) => ({
      index: index + 1,
      mode: session.mode,
      ...(session.reviewId ? { reviewId: session.reviewId } : {}),
      ...(session.target ? { target: session.target } : {}),
      url: session.url,
      port: session.port,
      pid: session.pid,
      project: session.project,
      label: session.label,
      startedAt: session.startedAt,
      ...(session.hostSession ? { hostSession: session.hostSession } : {}),
    })),
  );
}
